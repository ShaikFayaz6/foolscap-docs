import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DocumentSummary } from '../../shared/api.ts';
import { IMPORT_EXTENSIONS, IMPORT_RULES_TEXT, MAX_UPLOAD_BYTES } from '../../shared/limits.ts';
import { api, ApiRequestError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.ts';
import { firstName, timeAgo } from '../lib/format.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';

type Filter = 'all' | 'mine' | 'shared';

const ROLE_WORDS = { editor: 'can edit', viewer: 'can view' } as const;

function clientSideProblem(file: File): string | null {
  const lower = file.name.toLowerCase();
  if (!IMPORT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return `"${file.name}" can't be imported. Upload ${IMPORT_RULES_TEXT}.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) return `"${file.name}" is over the limit. Upload ${IMPORT_RULES_TEXT}.`;
  return null;
}

export function LibraryPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<'create' | 'import' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentSummary | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoadError('');
    api.listDocuments().then(setDocuments, (error: ApiRequestError) => setLoadError(error.message));
  }, []);

  useEffect(load, [load]);

  async function createDocument() {
    setBusy('create');
    setActionError('');
    try {
      const document = await api.createDocument();
      navigate(`/d/${document.id}`, { state: { fresh: true } });
    } catch (error) {
      setActionError((error as ApiRequestError).message);
      setBusy(null);
    }
  }

  async function importFile(file: File) {
    setActionError('');
    const problem = clientSideProblem(file);
    if (problem) {
      setActionError(problem);
      return;
    }
    setBusy('import');
    try {
      const { document, notes } = await api.importFile(file);
      navigate(`/d/${document.id}`, { state: { importedFrom: file.name, notes } });
    } catch (error) {
      setActionError(`Couldn't import "${file.name}". ${(error as ApiRequestError).message}`);
      setBusy(null);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void importFile(file);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      await api.deleteDocument(target.id);
      setDocuments((current) => current?.filter((d) => d.id !== target.id) ?? null);
    } catch (error) {
      setActionError(`Couldn't delete "${target.title}". ${(error as ApiRequestError).message}`);
    }
  }

  async function signOut() {
    await api.logout().catch(() => {});
    setUser(null);
  }

  const visible = documents?.filter((d) => filter === 'all' || (filter === 'mine') === (d.role === 'owner')) ?? [];
  const counts = {
    all: documents?.length ?? 0,
    mine: documents?.filter((d) => d.role === 'owner').length ?? 0,
    shared: documents?.filter((d) => d.role !== 'owner').length ?? 0,
  };

  return (
    <div
      className={`library ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="masthead">
        <span className="wordmark">Foolscap</span>
        <div className="masthead-user">
          <span>{user?.name}</span>
          <button className="link-button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="library-main">
        <div className="library-head">
          <h1>Your pile</h1>
          <div className="library-actions">
            <button className="button button-primary" onClick={createDocument} disabled={busy !== null}>
              {busy === 'create' ? 'Creating…' : 'New document'}
            </button>
            <button className="button" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
              {busy === 'import' ? 'Importing…' : 'Import a file'}
            </button>
            <input
              ref={fileInput}
              data-testid="import-input"
              type="file"
              hidden
              accept={IMPORT_EXTENSIONS.join(',')}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void importFile(file);
              }}
            />
          </div>
        </div>
        <p className="import-rules">Import {IMPORT_RULES_TEXT}, or drop a file anywhere on this page. It opens as a new document.</p>

        {actionError && (
          <div className="notice notice-error" role="alert">
            <p>{actionError}</p>
            <button className="link-button" onClick={() => setActionError('')}>
              Dismiss
            </button>
          </div>
        )}

        <div className="filters" role="group" aria-label="Filter documents">
          {(
            [
              ['all', 'Everything'],
              ['mine', 'Yours'],
              ['shared', 'Shared with you'],
            ] as const
          ).map(([value, label]) => (
            <button key={value} className="filter" aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {label} <span className="filter-count">{counts[value]}</span>
            </button>
          ))}
        </div>

        {loadError ? (
          <div className="empty" role="alert">
            <h2>Your documents didn't load</h2>
            <p>{loadError}</p>
            <button className="button" onClick={load}>
              Try again
            </button>
          </div>
        ) : documents === null ? (
          <div className="empty" aria-busy="true">
            <p>Fetching your pile…</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">
            {filter === 'shared' ? (
              <>
                <h2>Nothing shared with you yet</h2>
                <p>When someone shares a document with you, it shows up here.</p>
              </>
            ) : (
              <>
                <h2>A clean desk</h2>
                <p>Start a new document, or import something you already have.</p>
              </>
            )}
          </div>
        ) : (
          <ul className="doc-list">
            {visible.map((document) => (
              <li key={document.id} className={`doc-row ${document.role === 'owner' ? 'is-owned' : 'is-shared'}`}>
                <Link className="doc-link" to={`/d/${document.id}`}>
                  <span className="doc-title">{document.title}</span>
                  <span className="doc-meta">
                    Edited {timeAgo(document.updatedAt)} by {firstName(document.updatedBy)}
                  </span>
                </Link>
                <span className="doc-ownership">
                  {document.role === 'owner' ? (
                    <>
                      <span className="tag tag-owned">Yours</span>
                      {document.shareCount > 0 && (
                        <span className="tag-note">
                          shared with {document.shareCount} {document.shareCount === 1 ? 'person' : 'people'}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="tag tag-shared">From {firstName(document.owner.name)}</span>
                      <span className="tag-note">you {ROLE_WORDS[document.role]}</span>
                    </>
                  )}
                </span>
                <span className="doc-actions">
                  {document.role === 'owner' && (
                    <button className="link-button" aria-label={`Delete ${document.title}`} onClick={() => setPendingDelete(document)}>
                      Delete
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </main>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <p>Drop to import: {IMPORT_RULES_TEXT}</p>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.title}"?`}
          body={
            pendingDelete.shareCount > 0
              ? `This also removes it for the ${pendingDelete.shareCount} ${pendingDelete.shareCount === 1 ? 'person' : 'people'} you shared it with. It can't be undone.`
              : "This can't be undone."
          }
          confirmLabel="Delete document"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
