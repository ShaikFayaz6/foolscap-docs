import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DocumentSummary } from '../../shared/api.ts';
import { IMPORT_EXTENSIONS, IMPORT_RULES_TEXT, MAX_UPLOAD_BYTES } from '../../shared/limits.ts';
import { api, type ApiRequestError } from '../lib/api.ts';
import { firstName, timeAgo } from '../lib/format.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { peerColor } from '../components/PeopleHere.tsx';
import { initials, usePageTitle, useToast } from '../lib/ui.tsx';

type Filter = 'all' | 'mine' | 'shared';

const ROLE_WORDS = { editor: 'can edit', commenter: 'can comment', viewer: 'can view' } as const;

function clientSideProblem(file: File): string | null {
  const lower = file.name.toLowerCase();
  if (!IMPORT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return `"${file.name}" can't be imported. Upload ${IMPORT_RULES_TEXT}.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) return `"${file.name}" is over the limit. Upload ${IMPORT_RULES_TEXT}.`;
  return null;
}

/** A small stack of pages, drawn for empty states. */
function EmptyArt() {
  return (
    <svg className="empty-art" viewBox="0 0 120 96" width="120" height="96" aria-hidden="true">
      <rect x="30" y="14" width="56" height="72" rx="3" transform="rotate(-8 58 50)" fill="var(--desk-deep)" stroke="var(--rule)" />
      <rect x="34" y="10" width="56" height="72" rx="3" fill="var(--pad)" stroke="var(--rule)" />
      <line x1="44" y1="10" x2="44" y2="82" stroke="var(--margin)" strokeOpacity="0.6" strokeWidth="1.5" />
      {[24, 34, 44, 54, 64].map((y, index) => (
        <line key={y} x1="50" y1={y} x2={index === 4 ? 70 : 82} y2={y} stroke="var(--rule)" strokeWidth="2" strokeLinecap="round" />
      ))}
      <circle cx="92" cy="74" r="12" fill="var(--accent)" />
      <path d="M92 68v12M86 74h12" stroke="#fff8ec" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function LibraryPage() {
  const navigate = useNavigate();
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'title'>('recent');
  const toast = useToast();
  usePageTitle('Your pile');
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
      toast(`Deleted "${target.title}"`);
    } catch (error) {
      setActionError(`Couldn't delete "${target.title}". ${(error as ApiRequestError).message}`);
    }
  }

  const needle = query.trim().toLowerCase();
  const visible = (documents ?? [])
    .filter((d) => filter === 'all' || (filter === 'mine') === (d.role === 'owner'))
    .filter((d) => !needle || d.title.toLowerCase().includes(needle) || d.owner.name.toLowerCase().includes(needle))
    .sort((a, b) => (sort === 'title' ? a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) : b.updatedAt.localeCompare(a.updatedAt)));
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
      <AppHeader />

      <main className="library-main">
        <div className="library-head">
          <h1>Your pile</h1>
          <div className="library-actions">
            <button type="button" className="button button-primary button-icon" onClick={createDocument} disabled={busy !== null}>
              <Icon name="plus" />
              {busy === 'create' ? 'Creating…' : 'New document'}
            </button>
            <button type="button" className="button button-icon" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
              <Icon name="upload" />
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
            <button type="button" className="link-button" onClick={() => setActionError('')}>
              Dismiss
            </button>
          </div>
        )}

        <div className="library-toolbar">
          <div className="filters" role="group" aria-label="Filter documents">
            {(
              [
                ['all', 'Everything'],
                ['mine', 'Yours'],
                ['shared', 'Shared with you'],
              ] as const
            ).map(([value, label]) => (
              <button type="button" key={value} className="filter" aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {label} <span className="filter-count">{counts[value]}</span>
              </button>
            ))}
          </div>
          <div className="library-tools">
            <label className="search-field">
              <span className="visually-hidden">Search documents</span>
              <Icon name="search" className="search-icon" />
              <input type="search" placeholder="Search by title or owner" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <label className="sort-field">
              <span className="visually-hidden">Sort documents</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'title')}>
                <option value="recent">Last edited</option>
                <option value="title">Title A–Z</option>
              </select>
            </label>
          </div>
        </div>

        {loadError ? (
          <div className="empty" role="alert">
            <h2>Your documents didn't load</h2>
            <p>{loadError}</p>
            <button type="button" className="button" onClick={load}>
              Try again
            </button>
          </div>
        ) : documents === null ? (
          <ul className="doc-list" aria-busy="true">
            <li className="visually-hidden">Fetching your pile…</li>
            {[62, 48, 70, 40].map((width) => (
              <li key={width} className="doc-row doc-row-skeleton" aria-hidden="true">
                <span className="skeleton skeleton-icon" />
                <span className="doc-skeleton-text">
                  <span className="skeleton skeleton-line" style={{ width: `${width}%`, height: 14 }} />
                  <span className="skeleton skeleton-line" style={{ width: '30%', height: 10 }} />
                </span>
                <span className="skeleton skeleton-pill" />
              </li>
            ))}
          </ul>
        ) : visible.length === 0 ? (
          <div className="empty">
            <EmptyArt />
            {needle ? (
              <>
                <h2>No documents match "{query.trim()}"</h2>
                <p>Try a different word, or clear the search.</p>
                <button type="button" className="button" onClick={() => setQuery('')}>
                  Clear search
                </button>
              </>
            ) : filter === 'shared' ? (
              <>
                <h2>Nothing shared with you yet</h2>
                <p>When someone shares a document with you, it shows up here.</p>
              </>
            ) : (
              <>
                <h2>A clean desk</h2>
                <p>Start a new document, or import something you already have.</p>
                <button type="button" className="button button-primary button-icon" onClick={createDocument} disabled={busy !== null}>
                  <Icon name="plus" />
                  Start writing
                </button>
              </>
            )}
          </div>
        ) : (
          <ul className="doc-list">
            {visible.map((document) => (
              <li key={document.id} className={`doc-row ${document.role === 'owner' ? 'is-owned' : 'is-shared'}`}>
                <span className="doc-icon" aria-hidden="true">
                  <Icon name="file" size={20} />
                </span>
                <Link className="doc-link" to={`/d/${document.id}`}>
                  <span className="doc-title">{document.title}</span>
                  <span className="doc-meta">
                    Edited {timeAgo(document.updatedAt)} by {firstName(document.updatedBy)}
                  </span>
                </Link>
                <span className="doc-ownership">
                  <span className="avatar avatar-small" style={{ background: peerColor(document.owner.name) }} title={`Owner: ${document.owner.name}`} aria-hidden="true">
                    {initials(document.owner.name)}
                  </span>
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
                    <button type="button" className="icon-button" aria-label={`Delete ${document.title}`} title="Delete" onClick={() => setPendingDelete(document)}>
                      <Icon name="trash" />
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
