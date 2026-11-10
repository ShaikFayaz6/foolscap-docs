import { existsSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import multer from 'multer';
import { z } from 'zod';
import { verifyPassword, type Db } from './db.ts';
import { ApiError } from './errors.ts';
import { normalizeContent } from './content.ts';
import { convertUpload } from './importer.ts';
import { IMPORT_RULES_TEXT, MAX_TITLE_LENGTH, MAX_UPLOAD_BYTES, ROLES, type Role } from '../shared/limits.ts';
import { EMPTY_DOC } from '../shared/schema.ts';
import type { DocumentDetail, DocumentSummary, Share, User } from '../shared/api.ts';

const SESSION_COOKIE = 'foolscap_session';
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
  share_role: 'viewer' | 'editor' | null;
}

interface StoredContent {
  content: string;
  version: number;
  updated_at: string;
  updated_by: string;
}

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SNAPSHOTS = 30;
const EMPTY_SERIALIZED = JSON.stringify(EMPTY_DOC);

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
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

export function createApp(db: Db, options: { staticDir?: string } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
      strictTransportSecurity: false,
    }),
  );
  app.use(cookieParser());

  const api = express.Router();
  api.use(express.json({ limit: '6mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    defParamCharset: 'utf8',
  });

  api.get('/health', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  // --- Authentication -------------------------------------------------------

  const requireUser: RequestHandler = (req, res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    const user =
      typeof token === 'string'
        ? (db
            .prepare(
              `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token_hash = ? AND s.expires_at > ?`,
            )
            .get(hashToken(token), Date.now()) as User | undefined)
        : undefined;
    if (!user) throw new ApiError(401, 'not_signed_in', 'Please sign in to continue.');
    res.locals.user = { ...user };
    next();
  };

  api.post('/auth/login', (req, res) => {
    const { email, password } = parse(
      z.object({ email: z.string().trim().min(1), password: z.string().min(1) }),
      req.body,
    );
    const row = db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?').get(email) as
      | (User & { password_hash: string })
      | undefined;
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new ApiError(401, 'invalid_credentials', 'That email and password do not match an account.');
    }
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
      const userId = currentUser(res).id;
      const row = db
        .prepare(
          `SELECT d.owner_id, s.role AS share_role FROM documents d
           LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = ?
           WHERE d.id = ?`,
        )
        .get(userId, String(req.params.id)) as { owner_id: string; share_role: Role | null } | undefined;
      const role = row && (row.owner_id === userId ? 'owner' : row.share_role);
      if (!role) throw new ApiError(404, 'not_found', 'This document does not exist or has not been shared with you.');
      if (ROLES.indexOf(role) < ROLES.indexOf(minimum)) {
        throw new ApiError(
          403,
          'forbidden',
          minimum === 'owner' ? 'Only the owner can do that.' : 'You have view-only access to this document.',
        );
      }
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
  function readCurrent(id: string, baseVersion: number): StoredContent {
    const current = db
      .prepare('SELECT content, version, updated_at, updated_by FROM documents WHERE id = ?')
      .get(id) as unknown as StoredContent;
    if (current.version !== baseVersion) {
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

  function takeSnapshot(id: string, current: StoredContent): void {
    db.prepare('INSERT INTO document_versions (document_id, version, content, saved_at, saved_by) VALUES (?, ?, ?, ?, ?)').run(
      id,
      current.version,
      current.content,
      current.updated_at,
      current.updated_by,
    );
    db.prepare(
      `DELETE FROM document_versions WHERE document_id = ? AND id NOT IN
       (SELECT id FROM document_versions WHERE document_id = ? ORDER BY id DESC LIMIT ?)`,
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

  api.post('/documents/import', (req, res, next) => {
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
    res.json({ version: body.baseVersion + 1, updatedAt: now });
  });

  // --- Version history ------------------------------------------------------

  api.get('/documents/:id/versions', requireRole('editor'), (req, res) => {
    const versions = db
      .prepare(
        `SELECT v.id, v.version, v.saved_at AS savedAt, u.name AS savedBy FROM document_versions v
         JOIN users u ON u.id = v.saved_by WHERE v.document_id = ? ORDER BY v.id DESC`,
      )
      .all(String(req.params.id));
    res.json({ versions });
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
    res.json({ document: loadDetail(id, userId) });
  });

  api.delete('/documents/:id', requireRole('owner'), (req, res) => {
    db.prepare('DELETE FROM documents WHERE id = ?').run(String(req.params.id));
    res.status(204).end();
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
      z.object({ email: z.string().trim().min(1, 'Enter an email address.'), role: z.enum(['viewer', 'editor']) }),
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
    res.json({ shares: listShares(id) });
  });

  api.delete('/documents/:id/shares/:userId', requireRole('owner'), (req, res) => {
    const id = String(req.params.id);
    db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?').run(id, String(req.params.userId));
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
      console.error(error);
      res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on the server.' } });
    }
  });

  return app;
}
