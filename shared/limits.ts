/** Limits shared by the UI (so it can explain them) and the API (which enforces them). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
export const MAX_TITLE_LENGTH = 200;
export const IMPORT_EXTENSIONS = ['.txt', '.md', '.docx'] as const;
export const IMPORT_RULES_TEXT = '.txt, .md or .docx, up to 2 MB';

export const ROLES = ['viewer', 'editor', 'owner'] as const;
export type Role = (typeof ROLES)[number];
export type ShareRole = Exclude<Role, 'owner'>;
