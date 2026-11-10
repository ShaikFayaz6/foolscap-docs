import { existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit, type Options as RateLimitOptions } from 'express-rate-limit';
import pino, { type Logger } from 'pino';
import { z } from 'zod';
import { hashPassword, verifyPassword, type Db } from './db.ts';
import { hashToken, roleFor, SESSION_COOKIE, userForToken } from './access.ts';
import { NO_LIVE_EVENTS, type LiveEvents } from './presence.ts';
import { ApiError } from './errors.ts';
import { normalizeContent } from './content.ts';
import { convertUpload } from './importer.ts';
import { toMarkdown, toPdf, type DocNode } from './exporter.ts';
import {
  hasRole,
  IMPORT_RULES_TEXT,
  MAX_TITLE_LENGTH,
  MAX_UPLOAD_BYTES,
  SHARE_ROLES,
  type Role,
  type ShareRole,
} from '../shared/limits.ts';
import { EMPTY_DOC } from '../shared/schema.ts';
import { MAX_QUOTE_LENGTH } from '../shared/anchors.ts';
import type { AppConfig, CommentThread, DocumentDetail, DocumentSummary, Share, User } from '../shared/api.ts';

const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

interface DocumentRow {
  id: string;
  title: string;
  content: string;
  version: number;
  updated_at: string;
  owner_id: string;
  owner_name: string;
  owner_email: string;
  updated_by_name: string;
  share_count: number;
  share_role: ShareRole | null;
}

interface StoredContent {
  content: string;
  version: number;
  updated_at: string;
  updated_by: string;
}

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
interface CommentRow {
  id: number;
  author_id: string;
  author_name: string;
  body: string;
  quote: string;
  prefix: string;
  suffix: string;
  from_pos: number;
  to_pos: number;
  resolved: number;
  created_at: string;
}

interface ReplyRow {
  id: number;
  comment_id: number;
  author_id: string;
  author_name: string;
  body: string;
  created_at: string;
}

const MAX_COMMENT_LENGTH = 5000;
const MAX_COMMENTS = 500;
const MAX_SNAPSHOTS = 30;
const MAX_NAMED_VERSIONS = 50;
const EMPTY_SERIALIZED = JSON.stringify(EMPTY_DOC);

const titleSchema = z.string().trim().max(MAX_TITLE_LENGTH, `Titles can be at most ${MAX_TITLE_LENGTH} characters.`);
const currentUser = (res: Response) => res.locals.user as User;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(400, 'invalid_request', result.error.issues[0]?.message ?? 'Invalid request.');
}

const DOCUMENT_COLUMNS = `
  d.id, d.title, d.version, d.updated_at, d.owner_id,
  owner.name AS owner_name, owner.email AS owner_email, editor.name AS updated_by_name,
  (SELECT COUNT(*) FROM document_shares c WHERE c.document_id = d.id) AS share_count,
  s.role AS share_role`;
const DOCUMENT_JOINS = `
  FROM documents d
  JOIN users owner ON owner.id = d.owner_id
  JOIN users editor ON editor.id = d.updated_by
  LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = ?`;

function toSummary(row: DocumentRow, userId: string): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    role: row.owner_id === userId ? 'owner' : (row.share_role as Role),
    owner: { name: row.owner_name, email: row.owner_email },
    shareCount: row.share_count,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by_name,
  };
}

const MINUTE = 60_000;
const DEFAULT_RATE_LIMITS = {
  // Only failed logins count, so a reviewer signing in repeatedly is never locked out.
  login: { limit: 20, windowMs: 15 * MINUTE },
  upload: { limit: 30, windowMs: 10 * MINUTE },
  export: { limit: 60, windowMs: MINUTE },
};

export interface AppOptions {
  staticDir?: string;
  live?: LiveEvents;
  logger?: Logger;
  trustProxy?: number;
  isProduction?: boolean;
  demo?: AppConfig['demo'];
  rateLimits?: Partial<typeof DEFAULT_RATE_LIMITS>;
}

export function createApp(db: Db, options: AppOptions = {}) {
  const live = options.live ?? NO_LIVE_EVENTS;
  const logger = options.logger ?? pino({ level: 'silent' });
  const limits = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
  const unknownUserHash = hashPassword(randomBytes(16).toString('hex'));
  const app = express();
  app.set('trust proxy', options.trustProxy ?? 0);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
      strictTransportSecurity: options.isProduction ? { maxAge: 15_552_000 } : false,
    }),
  );
  app.use(cookieParser());

  // One structured line per request. Paths and ids only: never bodies, cookies or document text.
  app.use('/api', (req, res, next) => {
    const started = performance.now();
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId);
    res.on('finish', () => {
      const level = res.statusCode >= 500 ? 'error' : req.path === '/health' ? 'debug' : 'info';
      logger[level]({
        requestId: res.locals.requestId,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
        userId: (res.locals.user as User | undefined)?.id,
      }, 'request');
    });
    next();
  });

  const api = express.Router();

  // Cross-site forms cannot set a custom header, and browsers name the real origin.
  api.use((req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    let allowed = req.get('x-requested-with') === 'foolscap';
    if (allowed && origin) {
      try {
        allowed = new URL(origin).host === req.get('host');
      } catch {
        allowed = false;
      }
    }
    if (!allowed) throw new ApiError(403, 'csrf_rejected', 'This request was blocked because it did not come from Foolscap. Reload the page and try again.');
    next();
  });
  api.use(express.json({ limit: '6mb' }));

  const limiter = (rule: { limit: number; windowMs: number }, extra: Partial<RateLimitOptions> = {}) =>
    rateLimit({
      ...rule,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, _res, next) => next(new ApiError(429, 'rate_limited', 'Too many attempts. Please wait a few minutes and try again.')),
      ...extra,
    });
  const perUser = { keyGenerator: (_req: Request, res: Response) => currentUser(res).id };

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    defParamCharset: 'utf8',
  });

  api.get('/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true, database: 'up', uptimeSeconds: Math.round(process.uptime()) });
    } catch (error) {
      logger.error({ err: error }, 'Health check failed');
      res.status(503).json({ ok: false, database: 'down' });
    }
  });

  api.get('/config', (_req, res) => {
    const config: AppConfig = { demo: options.demo ?? null };
    res.json(config);
  });

  // --- Authentication -------------------------------------------------------

  const requireUser: RequestHandler = (req, res, next) => {
    const user = userForToken(db, req.cookies?.[SESSION_COOKIE]);
    if (!user) throw new ApiError(401, 'not_signed_in', 'Please sign in to continue.');
    res.locals.user = user;
    next();
  };

  api.post('/auth/login', limiter(limits.login, { skipSuccessfulRequests: true }), (req, res) => {
    const { email, password } = parse(
      z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) }),
      req.body,
    );
    const row = db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?').get(email) as
      | (User & { password_hash: string })
      | undefined;
    // Hashes even for unknown emails, so response time does not reveal who has an account.
    const passwordMatches = verifyPassword(password, row?.password_hash ?? unknownUserHash);
    if (!row || !passwordMatches) {
      throw new ApiError(401, 'invalid_credentials', 'That email and password do not match an account.');
    }
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      hashToken(token),
      row.id,
      Date.now() + SESSION_MS,
    );
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSION_MS,
      path: '/',
    });
    res.json({ user: { id: row.id, email: row.email, name: row.name } });
  });

  api.post('/auth/logout', (req, res) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  api.get('/auth/me', requireUser, (_req, res) => {
    res.json({ user: currentUser(res) });
  });

  api.use('/documents', requireUser);

  // --- Access control -------------------------------------------------------

  /**
   * The one place document access is decided. Every /documents/:id route goes
   * through it. People with no access get a 404, so a document's existence is
   * not revealed; people with too little access get a 403.
   */
  const requireRole =
    (minimum: Role): RequestHandler =>
    (req, res, next) => {
      const role = roleFor(db, String(req.params.id), currentUser(res).id);
      if (!role) throw new ApiError(404, 'not_found', 'This document does not exist or has not been shared with you.');
      if (!hasRole(role, minimum)) {
        const messages: Partial<Record<Role, string>> = {
          owner: 'Only the owner can do that.',
          editor: 'Your access does not include editing this document.',
          commenter: 'You have view-only access to this document.',
        };
        throw new ApiError(403, 'forbidden', messages[minimum] ?? 'You do not have access to do that.');
      }
      res.locals.role = role;
      next();
    };

  // --- Documents ------------------------------------------------------------

  function loadDetail(id: string, userId: string): DocumentDetail {
    const row = db
      .prepare(`SELECT ${DOCUMENT_COLUMNS}, d.content ${DOCUMENT_JOINS} WHERE d.id = ?`)
      .get(userId, id) as unknown as DocumentRow;
    return { ...toSummary(row, userId), content: JSON.parse(row.content), version: row.version };
  }

  function insertDocument(ownerId: string, title: string, serialized: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO documents (id, owner_id, title, content, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, ownerId, title, serialized, now, now, ownerId);
    return id;
  }

  function transaction(work: () => void): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Reads the stored document, refusing if it has moved on from the version the client edited. */
  function readCurrent(id: string, baseVersion?: number): StoredContent {
    const current = db
      .prepare('SELECT content, version, updated_at, updated_by FROM documents WHERE id = ?')
      .get(id) as unknown as StoredContent;
    if (baseVersion !== undefined && current.version !== baseVersion) {
      throw new ApiError(409, 'version_conflict', 'Someone else saved a newer version of this document.', {
        currentVersion: current.version,
      });
    }
    return current;
  }

  function writeContent(id: string, serialized: string, now: string, userId: string): void {
    db.prepare(
      'UPDATE documents SET content = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?',
    ).run(serialized, now, userId, id);
  }

  /** Autosave runs constantly, so history keeps a checkpoint, not every keystroke. */
  function shouldSnapshot(id: string, current: StoredContent, userId: string): boolean {
    if (current.content === EMPTY_SERIALIZED) return false;
    if (current.updated_by !== userId) return true; // Never lose one person's work to another's edit.
    const last = db
      .prepare('SELECT saved_at FROM document_versions WHERE document_id = ? ORDER BY id DESC LIMIT 1')
      .get(id) as { saved_at: string } | undefined;
    return !last || Date.now() - Date.parse(last.saved_at) >= SNAPSHOT_INTERVAL_MS;
  }

  function takeSnapshot(id: string, current: StoredContent, name: string | null = null): void {
    db.prepare(
      'INSERT INTO document_versions (document_id, version, content, saved_at, saved_by, name) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, current.version, current.content, current.updated_at, current.updated_by, name);
    // Only automatic checkpoints are pruned. A version someone named stays.
    db.prepare(
      `DELETE FROM document_versions WHERE document_id = ? AND name IS NULL AND id NOT IN
       (SELECT id FROM document_versions WHERE document_id = ? AND name IS NULL ORDER BY id DESC LIMIT ?)`,
    ).run(id, id, MAX_SNAPSHOTS);
  }

  /** Looks a version up within its own document, so another document's id cannot reach it. */
  function findVersion(documentId: string, versionId: string): { content: string } {
    const target = /^\d+$/.test(versionId)
      ? (db
          .prepare('SELECT content FROM document_versions WHERE id = ? AND document_id = ?')
          .get(Number(versionId), documentId) as { content: string } | undefined)
      : undefined;
    if (!target) throw new ApiError(404, 'version_not_found', 'That version no longer exists.');
    return target;
  }

  api.get('/documents', (_req, res) => {
    const userId = currentUser(res).id;
    const rows = db
      .prepare(
        `SELECT ${DOCUMENT_COLUMNS} ${DOCUMENT_JOINS}
         WHERE d.owner_id = ? OR s.user_id IS NOT NULL
         ORDER BY d.updated_at DESC`,
      )
      .all(userId, userId) as unknown as DocumentRow[];
    res.json({ documents: rows.map((row) => toSummary(row, userId)) });
  });

  api.post('/documents', (req, res) => {
    const { title } = parse(z.object({ title: titleSchema.optional() }), req.body ?? {});
    const userId = currentUser(res).id;
    const id = insertDocument(userId, title || 'Untitled', JSON.stringify(EMPTY_DOC));
    res.status(201).json({ document: loadDetail(id, userId) });
  });

  api.post('/documents/import', limiter(limits.upload, perUser), (req, res, next) => {
    upload.single('file')(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        next(
          error.code === 'LIMIT_FILE_SIZE'
            ? new ApiError(413, 'file_too_large', `That file is over the limit. Upload ${IMPORT_RULES_TEXT}.`)
            : new ApiError(400, 'invalid_upload', 'Upload one file at a time, in the "file" field.'),
        );
      } else {
        next(error);
      }
    });
  });

  api.post('/documents/import', async (req, res) => {
    if (!req.file) throw new ApiError(400, 'no_file', `Choose a file to import: ${IMPORT_RULES_TEXT}.`);
    const converted = await convertUpload(req.file.originalname, req.file.buffer);
    const { serialized } = normalizeContent(converted.content);
    const userId = currentUser(res).id;
    const id = insertDocument(userId, converted.title, serialized);
    res.status(201).json({ document: loadDetail(id, userId), notes: converted.notes });
  });

  api.get('/documents/:id', requireRole('viewer'), (req, res) => {
    res.json({ document: loadDetail(String(req.params.id), currentUser(res).id) });
  });

  api.patch('/documents/:id', requireRole('editor'), (req, res) => {
    const { title } = parse(z.object({ title: titleSchema }), req.body);
    const now = new Date().toISOString();
    db.prepare('UPDATE documents SET title = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(
      title || 'Untitled',
      now,
      currentUser(res).id,
      String(req.params.id),
    );
    live.changed(String(req.params.id), 'document');
    res.json({ title: title || 'Untitled', updatedAt: now });
  });

  api.put('/documents/:id/content', requireRole('editor'), (req, res) => {
    const body = parse(z.object({ content: z.unknown(), baseVersion: z.number().int().positive() }), req.body);
    const { serialized } = normalizeContent(body.content);
    const id = String(req.params.id);
    const userId = currentUser(res).id;
    const now = new Date().toISOString();
    // One transaction, so two saves cannot both pass the version check.
    transaction(() => {
      const current = readCurrent(id, body.baseVersion);
      if (shouldSnapshot(id, current, userId)) takeSnapshot(id, current);
      writeContent(id, serialized, now, userId);
    });
    live.changed(id, 'document');
    res.json({ version: body.baseVersion + 1, updatedAt: now });
  });

  // --- Export ---------------------------------------------------------------

  api.get('/documents/:id/export', requireRole('viewer'), limiter(limits.export, perUser), async (req, res) => {
    const { format } = parse(z.object({ format: z.enum(['markdown', 'pdf'], 'Choose markdown or pdf.') }), req.query);
    const row = db.prepare('SELECT title, content FROM documents WHERE id = ?').get(String(req.params.id)) as {
      title: string;
      content: string;
    };
    const content = JSON.parse(row.content) as DocNode;
    const filename = row.title.replace(/[\\/:*?"<>|\u0000-\u001f\s]+/g, ' ').trim() || 'Untitled';
    if (format === 'pdf') {
      const pdf = await toPdf(content, row.title);
      res.attachment(`${filename}.pdf`).type('application/pdf').send(pdf);
    } else {
      res.attachment(`${filename}.md`).type('text/markdown; charset=utf-8').send(toMarkdown(content));
    }
  });

  // --- Version history ------------------------------------------------------

  const listVersions = (documentId: string) =>
    db
      .prepare(
        `SELECT v.id, v.version, v.name, v.saved_at AS savedAt, u.name AS savedBy FROM document_versions v
         JOIN users u ON u.id = v.saved_by WHERE v.document_id = ? ORDER BY v.id DESC`,
      )
      .all(documentId);

  api.get('/documents/:id/versions', requireRole('editor'), (req, res) => {
    res.json({ versions: listVersions(String(req.params.id)) });
  });

  api.post('/documents/:id/versions', requireRole('editor'), (req, res) => {
    const { name } = parse(
      z.object({ name: z.string().trim().min(1, 'Give this version a name.').max(100, 'Names can be at most 100 characters.') }),
      req.body,
    );
    const id = String(req.params.id);
    transaction(() => {
      const { n } = db
        .prepare('SELECT COUNT(*) n FROM document_versions WHERE document_id = ? AND name IS NOT NULL')
        .get(id) as { n: number };
      if (n >= MAX_NAMED_VERSIONS) {
        throw new ApiError(409, 'too_many_named_versions', `A document can keep at most ${MAX_NAMED_VERSIONS} named versions.`);
      }
      takeSnapshot(id, readCurrent(id), name);
    });
    res.status(201).json({ versions: listVersions(id) });
  });

  api.get('/documents/:id/versions/:versionId', requireRole('editor'), (req, res) => {
    const target = findVersion(String(req.params.id), String(req.params.versionId));
    res.json({ content: JSON.parse(target.content) });
  });

  api.post('/documents/:id/versions/:versionId/restore', requireRole('editor'), (req, res) => {
    const { baseVersion } = parse(z.object({ baseVersion: z.number().int().positive() }), req.body);
    const id = String(req.params.id);
    const userId = currentUser(res).id;
    transaction(() => {
      const current = readCurrent(id, baseVersion);
      const target = findVersion(id, String(req.params.versionId));
      // A restore is itself undoable: the text it replaces always goes into history.
      if (current.content !== EMPTY_SERIALIZED) takeSnapshot(id, current);
      writeContent(id, target.content, new Date().toISOString(), userId);
    });
    live.changed(id, 'document');
    res.json({ document: loadDetail(id, userId) });
  });

  api.delete('/documents/:id', requireRole('owner'), (req, res) => {
    db.prepare('DELETE FROM documents WHERE id = ?').run(String(req.params.id));
    live.accessChanged(String(req.params.id));
    res.status(204).end();
  });

  // --- Comments -------------------------------------------------------------

  const commentBody = z.string().trim().min(1, 'Write something first.').max(MAX_COMMENT_LENGTH, `Comments can be at most ${MAX_COMMENT_LENGTH} characters.`);
  const anchorSchema = z.object({
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    quote: z.string().min(1).max(MAX_QUOTE_LENGTH),
    prefix: z.string().max(64),
    suffix: z.string().max(64),
  });

  /** Every comment write answers with the full list and tells everyone else to refresh theirs. */
  function sendComments(res: Response, documentId: string, status = 200): void {
    live.changed(documentId, 'comments');
    res.status(status).json({ comments: listComments(documentId) });
  }

  function listComments(documentId: string): CommentThread[] {
    const threads = db
      .prepare(
        `SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.document_id = ? ORDER BY c.id`,
      )
      .all(documentId) as unknown as CommentRow[];
    const replies = db
      .prepare(
        `SELECT r.id, r.comment_id, r.author_id, r.body, r.created_at, u.name AS author_name
         FROM comment_replies r JOIN users u ON u.id = r.author_id
         JOIN comments c ON c.id = r.comment_id WHERE c.document_id = ? ORDER BY r.id`,
      )
      .all(documentId) as unknown as ReplyRow[];
    return threads.map((row) => ({
      id: row.id,
      author: { id: row.author_id, name: row.author_name },
      body: row.body,
      anchor: { from: row.from_pos, to: row.to_pos, quote: row.quote, prefix: row.prefix, suffix: row.suffix },
      resolved: row.resolved === 1,
      createdAt: row.created_at,
      replies: replies
        .filter((reply) => reply.comment_id === row.id)
        .map((reply) => ({
          id: reply.id,
          author: { id: reply.author_id, name: reply.author_name },
          body: reply.body,
          createdAt: reply.created_at,
        })),
    }));
  }

  /** Looks a thread up within its own document, so another document's id cannot reach it. */
  function findComment(documentId: string, commentId: string): { author_id: string } {
    const row = /^\d+$/.test(commentId)
      ? (db.prepare('SELECT author_id FROM comments WHERE id = ? AND document_id = ?').get(Number(commentId), documentId) as
          | { author_id: string }
          | undefined)
      : undefined;
    if (!row) throw new ApiError(404, 'comment_not_found', 'That comment no longer exists.');
    return row;
  }

  api.get('/documents/:id/comments', requireRole('viewer'), (req, res) => {
    res.json({ comments: listComments(String(req.params.id)) });
  });

  api.post('/documents/:id/comments', requireRole('commenter'), (req, res) => {
    const { body, anchor } = parse(z.object({ body: commentBody, anchor: anchorSchema }), req.body);
    const id = String(req.params.id);
    const { n } = db.prepare('SELECT COUNT(*) n FROM comments WHERE document_id = ?').get(id) as { n: number };
    if (n >= MAX_COMMENTS) throw new ApiError(409, 'too_many_comments', `A document can hold at most ${MAX_COMMENTS} comment threads.`);
    db.prepare(
      `INSERT INTO comments (document_id, author_id, body, quote, prefix, suffix, from_pos, to_pos, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, currentUser(res).id, body, anchor.quote, anchor.prefix, anchor.suffix, anchor.from, anchor.to, new Date().toISOString());
    sendComments(res, id, 201);
  });

  api.post('/documents/:id/comments/:commentId/replies', requireRole('commenter'), (req, res) => {
    const { body } = parse(z.object({ body: commentBody }), req.body);
    const id = String(req.params.id);
    const commentId = String(req.params.commentId);
    findComment(id, commentId);
    db.prepare('INSERT INTO comment_replies (comment_id, author_id, body, created_at) VALUES (?, ?, ?, ?)').run(
      Number(commentId),
      currentUser(res).id,
      body,
      new Date().toISOString(),
    );
    sendComments(res, id, 201);
  });

  api.patch('/documents/:id/comments/:commentId', requireRole('commenter'), (req, res) => {
    const { resolved } = parse(z.object({ resolved: z.boolean() }), req.body);
    const id = String(req.params.id);
    const commentId = String(req.params.commentId);
    const comment = findComment(id, commentId);
    if (res.locals.role === 'commenter' && comment.author_id !== currentUser(res).id) {
      throw new ApiError(403, 'forbidden', 'Only the person who wrote this comment, an editor or the owner can resolve it.');
    }
    db.prepare('UPDATE comments SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, Number(commentId));
    sendComments(res, id);
  });

  api.delete('/documents/:id/comments/:commentId', requireRole('commenter'), (req, res) => {
    const id = String(req.params.id);
    const commentId = String(req.params.commentId);
    const comment = findComment(id, commentId);
    if (res.locals.role !== 'owner' && comment.author_id !== currentUser(res).id) {
      throw new ApiError(403, 'forbidden', 'Only the person who wrote this comment or the owner can delete it.');
    }
    db.prepare('DELETE FROM comments WHERE id = ?').run(Number(commentId));
    sendComments(res, id);
  });

  // --- Sharing --------------------------------------------------------------

  const listShares = (documentId: string): Share[] =>
    db
      .prepare(
        `SELECT u.id AS userId, u.name, u.email, s.role FROM document_shares s
         JOIN users u ON u.id = s.user_id WHERE s.document_id = ? ORDER BY u.name`,
      )
      .all(documentId) as unknown as Share[];

  api.get('/documents/:id/shares', requireRole('owner'), (req, res) => {
    res.json({ shares: listShares(String(req.params.id)) });
  });

  api.put('/documents/:id/shares', requireRole('owner'), (req, res) => {
    const { email, role } = parse(
      z.object({ email: z.string().trim().min(1, 'Enter an email address.').max(254), role: z.enum(SHARE_ROLES) }),
      req.body,
    );
    const id = String(req.params.id);
    const target = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
    if (!target) throw new ApiError(404, 'user_not_found', `There is no Foolscap account for ${email}.`);
    if (target.id === currentUser(res).id) {
      throw new ApiError(400, 'cannot_share_with_owner', 'You already own this document.');
    }
    db.prepare(
      `INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role`,
    ).run(id, target.id, role, new Date().toISOString());
    live.accessChanged(id);
    res.json({ shares: listShares(id) });
  });

  api.delete('/documents/:id/shares/:userId', requireRole('owner'), (req, res) => {
    const id = String(req.params.id);
    db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?').run(id, String(req.params.userId));
    live.accessChanged(id);
    res.json({ shares: listShares(id) });
  });

  api.use((_req, _res) => {
    throw new ApiError(404, 'not_found', 'No such API route.');
  });

  app.use('/api', api);

  // --- Front end ------------------------------------------------------------

  if (options.staticDir && existsSync(options.staticDir)) {
    const staticDir = options.staticDir;
    app.use(express.static(staticDir));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(staticDir, 'index.html')));
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, ...error.extra } });
      return;
    }
    const status = (error as { status?: number }).status;
    if (status === 413) {
      res.status(413).json({ error: { code: 'content_too_large', message: 'That request is too large.' } });
    } else if (status === 400) {
      res.status(400).json({ error: { code: 'invalid_request', message: 'That request could not be read.' } });
    } else {
      logger.error({ err: error, requestId: res.locals.requestId }, 'Unhandled error');
      res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on the server.' } });
    }
  });

  return app;
}
