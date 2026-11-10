import type { DocJson } from './schema.ts';
import type { Role, ShareRole } from './limits.ts';

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
  savedAt: string;
  savedBy: string;
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
