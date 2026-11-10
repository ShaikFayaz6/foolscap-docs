import type { Anchor } from '../../shared/anchors.ts';
import type {
  ApiErrorBody,
  AppConfig,
  CommentThread,
  DocumentDetail,
  DocumentSummary,
  ImportResult,
  SaveResult,
  Share,
  User,
  VersionSummary,
} from '../../shared/api.ts';
import type { ShareRole } from '../../shared/limits.ts';
import type { DocJson } from '../../shared/schema.ts';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'foolscap', ...(body === undefined || isForm ? {} : { 'content-type': 'application/json' }) },
      body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, 'network', "Can't reach the server. Check your connection and try again.");
  }
  if (response.status === 204) return undefined as T;

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON responses (a proxy error page, for example) fall through to the generic message.
  }
  if (!response.ok) {
    const error = (data as ApiErrorBody | null)?.error;
    if (response.status === 401 && error?.code === 'not_signed_in') onUnauthorized();
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'server_error',
      error?.message ?? 'Something went wrong on the server. Please try again.',
    );
  }
  return data as T;
}

export const api = {
  config: () => request<AppConfig>('GET', '/config'),
  me: () => request<{ user: User }>('GET', '/auth/me').then((r) => r.user),
  login: (email: string, password: string) =>
    request<{ user: User }>('POST', '/auth/login', { email, password }).then((r) => r.user),
  logout: () => request<void>('POST', '/auth/logout'),

  listDocuments: () => request<{ documents: DocumentSummary[] }>('GET', '/documents').then((r) => r.documents),
  createDocument: () => request<{ document: DocumentDetail }>('POST', '/documents', {}).then((r) => r.document),
  getDocument: (id: string) => request<{ document: DocumentDetail }>('GET', `/documents/${id}`).then((r) => r.document),
  renameDocument: (id: string, title: string) =>
    request<{ title: string; updatedAt: string }>('PATCH', `/documents/${id}`, { title }),
  saveContent: (id: string, content: unknown, baseVersion: number) =>
    request<SaveResult>('PUT', `/documents/${id}/content`, { content, baseVersion }),
  deleteDocument: (id: string) => request<void>('DELETE', `/documents/${id}`),
  importFile: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<ImportResult>('POST', '/documents/import', form);
  },

  listVersions: (id: string) =>
    request<{ versions: VersionSummary[] }>('GET', `/documents/${id}/versions`).then((r) => r.versions),
  nameVersion: (id: string, name: string) =>
    request<{ versions: VersionSummary[] }>('POST', `/documents/${id}/versions`, { name }).then((r) => r.versions),
  getVersion: (id: string, versionId: number) =>
    request<{ content: DocJson }>('GET', `/documents/${id}/versions/${versionId}`).then((r) => r.content),
  restoreVersion: (id: string, versionId: number, baseVersion: number) =>
    request<{ document: DocumentDetail }>('POST', `/documents/${id}/versions/${versionId}/restore`, { baseVersion }).then(
      (r) => r.document,
    ),

  listComments: (id: string) => request<{ comments: CommentThread[] }>('GET', `/documents/${id}/comments`).then((r) => r.comments),
  addComment: (id: string, body: string, anchor: Anchor) =>
    request<{ comments: CommentThread[] }>('POST', `/documents/${id}/comments`, { body, anchor }).then((r) => r.comments),
  replyToComment: (id: string, commentId: number, body: string) =>
    request<{ comments: CommentThread[] }>('POST', `/documents/${id}/comments/${commentId}/replies`, { body }).then((r) => r.comments),
  setCommentResolved: (id: string, commentId: number, resolved: boolean) =>
    request<{ comments: CommentThread[] }>('PATCH', `/documents/${id}/comments/${commentId}`, { resolved }).then((r) => r.comments),
  deleteComment: (id: string, commentId: number) =>
    request<{ comments: CommentThread[] }>('DELETE', `/documents/${id}/comments/${commentId}`).then((r) => r.comments),

  async exportDocument(id: string, format: 'markdown' | 'pdf'): Promise<Blob> {
    let response: Response;
    try {
      response = await fetch(`/api/documents/${id}/export?format=${format}`, { credentials: 'same-origin' });
    } catch {
      throw new ApiRequestError(0, 'network', "Can't reach the server. Check your connection and try again.");
    }
    if (response.ok) return response.blob();
    const error = ((await response.json().catch(() => null)) as ApiErrorBody | null)?.error;
    throw new ApiRequestError(response.status, error?.code ?? 'server_error', error?.message ?? 'The export failed. Please try again.');
  },

  listShares: (id: string) => request<{ shares: Share[] }>('GET', `/documents/${id}/shares`).then((r) => r.shares),
  share: (id: string, email: string, role: ShareRole) =>
    request<{ shares: Share[] }>('PUT', `/documents/${id}/shares`, { email, role }).then((r) => r.shares),
  unshare: (id: string, userId: string) =>
    request<{ shares: Share[] }>('DELETE', `/documents/${id}/shares/${userId}`).then((r) => r.shares),
};
