import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import type { User } from '../shared/api.ts';
import type { Role } from '../shared/limits.ts';

export const SESSION_COOKIE = 'foolscap_session';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function userForToken(db: Db, token: unknown): User | undefined {
  if (typeof token !== 'string') return undefined;
  const user = db
    .prepare(
      `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), Date.now()) as User | undefined;
  return user && { ...user };
}

/** A user's role on a document, or null if they have none. HTTP and WebSocket both decide access here. */
export function roleFor(db: Db, documentId: string, userId: string): Role | null {
  const row = db
    .prepare(
      `SELECT d.owner_id, s.role AS share_role FROM documents d
       LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = ?
       WHERE d.id = ?`,
    )
    .get(userId, documentId) as { owner_id: string; share_role: Role | null } | undefined;
  if (!row) return null;
  return row.owner_id === userId ? 'owner' : row.share_role;
}
