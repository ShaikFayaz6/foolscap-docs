import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '../shared/demo.ts';

export type Db = DatabaseSync;

const SCHEMA = `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE documents (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id),
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL REFERENCES users(id)
  );
  CREATE INDEX documents_owner ON documents(owner_id);
  CREATE TABLE document_shares (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at  TEXT NOT NULL,
    PRIMARY KEY (document_id, user_id)
  );
  CREATE INDEX document_shares_user ON document_shares(user_id);
`;

const HISTORY_SCHEMA = `
  CREATE TABLE document_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    content     TEXT NOT NULL,
    saved_at    TEXT NOT NULL,
    saved_by    TEXT NOT NULL REFERENCES users(id)
  );
  CREATE INDEX document_versions_document ON document_versions(document_id, id);
`;

// SQLite cannot alter a CHECK constraint, so the table is rebuilt.
const COMMENTER_ROLE = `
  CREATE TABLE document_shares_new (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
    created_at  TEXT NOT NULL,
    PRIMARY KEY (document_id, user_id)
  );
  INSERT INTO document_shares_new SELECT document_id, user_id, role, created_at FROM document_shares;
  DROP TABLE document_shares;
  ALTER TABLE document_shares_new RENAME TO document_shares;
  CREATE INDEX document_shares_user ON document_shares(user_id);
`;

const NAMED_VERSIONS = 'ALTER TABLE document_versions ADD COLUMN name TEXT;';

const COMMENTS = `
  CREATE TABLE comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    author_id   TEXT NOT NULL REFERENCES users(id),
    body        TEXT NOT NULL,
    quote       TEXT NOT NULL,
    prefix      TEXT NOT NULL,
    suffix      TEXT NOT NULL,
    from_pos    INTEGER NOT NULL,
    to_pos      INTEGER NOT NULL,
    resolved    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX comments_document ON comments(document_id);
  CREATE TABLE comment_replies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    author_id  TEXT NOT NULL REFERENCES users(id),
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX comment_replies_comment ON comment_replies(comment_id);
`;

/** Applied in order, once each. PRAGMA user_version records how many have run. Never edit a shipped entry. */
export const MIGRATIONS = [SCHEMA, HISTORY_SCHEMA, COMMENTER_ROLE, NAMED_VERSIONS, COMMENTS];

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, 'hex'), 32), Buffer.from(hash, 'hex'));
}

const WELCOME_DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Welcome to Foolscap' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Avery owns this page and has shared it with Blake as an ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'editor' },
        { type: 'text', text: '. Casey cannot see it at all until someone shares it.' },
      ],
    },
    {
      type: 'bulletList',
      content: ['Changes save on their own', 'Formatting survives a restart', 'Access is checked on the server'].map(
        (text) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        }),
      ),
    },
  ],
};

export function openDatabase(path: string, options: { seedWelcomeDoc?: boolean } = {}): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');

  const { user_version: schemaVersion } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let index = schemaVersion; index < MIGRATIONS.length; index += 1) {
    db.exec(`BEGIN; ${MIGRATIONS[index]} PRAGMA user_version = ${index + 1}; COMMIT;`);
  }
  if (schemaVersion === 0) seed(db, options.seedWelcomeDoc ?? true);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return db;
}

function seed(db: Db, withWelcomeDoc: boolean): void {
  const passwordHash = hashPassword(DEMO_PASSWORD);
  const insert = db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');
  const ids = DEMO_ACCOUNTS.map((account) => {
    const id = randomUUID();
    insert.run(id, account.email, account.name, passwordHash);
    return id;
  });
  if (!withWelcomeDoc) return;

  const [avery, blake] = ids as [string, string];
  const docId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO documents (id, owner_id, title, content, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(docId, avery, 'Welcome to Foolscap', JSON.stringify(WELCOME_DOC), now, now, avery);
  db.prepare('INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(
    docId,
    blake,
    'editor',
    now,
  );
}
