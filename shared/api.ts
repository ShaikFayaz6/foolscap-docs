import type { DocJson } from './schema.ts';
import type { Role, ShareRole } from './limits.ts';
import type { Anchor } from './anchors.ts';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  role: Role;
  owner: { name: string; email: string };
  shareCount: number;
  updatedAt: string;
  updatedBy: string;
}

export interface DocumentDetail extends DocumentSummary {
  content: DocJson;
  version: number;
}

export interface Share {
  userId: string;
  name: string;
  email: string;
  role: ShareRole;
}

export interface VersionSummary {
  id: number;
  version: number;
  name: string | null;
  savedAt: string;
  savedBy: string;
}

export interface LivePeer {
  id: string;
  userId: string;
  name: string;
  selection: { from: number; to: number } | null;
}

export type LiveChange = 'document' | 'comments' | 'access';

export type LiveMessage = { type: 'presence'; peers: LivePeer[] } | { type: 'changed'; what: LiveChange };

export interface CommentAuthor {
  id: string;
  name: string;
}

export interface CommentReply {
  id: number;
  author: CommentAuthor;
  body: string;
  createdAt: string;
}

export interface CommentThread {
  id: number;
  author: CommentAuthor;
  body: string;
  anchor: Anchor;
  resolved: boolean;
  createdAt: string;
  replies: CommentReply[];
}

export interface SaveResult {
  version: number;
  updatedAt: string;
}

export interface ImportResult {
  document: DocumentDetail;
  notes: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; currentVersion?: number };
}
