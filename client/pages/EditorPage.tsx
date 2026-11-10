import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import type { DocumentDetail } from '../../shared/api.ts';
import { documentExtensions } from '../../shared/schema.ts';
import { MAX_TITLE_LENGTH } from '../../shared/limits.ts';
import { api, ApiRequestError } from '../lib/api.ts';
import { clockTime, firstName } from '../lib/format.ts';
import { useAutosave, type SaveStatus } from '../lib/useAutosave.ts';
import { ToolRail } from '../components/ToolRail.tsx';
import { ShareDialog } from '../components/ShareDialog.tsx';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { HistoryDialog } from '../components/HistoryDialog.tsx';

const POLL_MS = 8000;

type Load =
  | { state: 'loading' }
  | { state: 'ready'; document: DocumentDetail }
  | { state: 'failed'; notFound: boolean; message: string };

export function EditorPage() {
  const { id = '' } = useParams();
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const fetchDocument = useCallback(() => {
    setLoad({ state: 'loading' });
    api.getDocument(id).then(
      (document) => setLoad({ state: 'ready', document }),
      (error: ApiRequestError) => setLoad({ state: 'failed', notFound: error.status === 404, message: error.message }),
    );
  }, [id]);

  useEffect(fetchDocument, [fetchDocument]);

  if (load.state === 'loading') return <div className="center-state" aria-busy="true">Finding that page…</div>;
  if (load.state === 'failed') {
    return (
      <main className="center-state">
        <h1>{load.notFound ? "This page isn't in your pile" : "This document didn't load"}</h1>
        <p>{load.message}</p>
        <p className="center-actions">
          {!load.notFound && (
            <button className="button" onClick={fetchDocument}>
              Try again
            </button>
          )}
          <Link className="button" to="/">
            Back to your pile
          </Link>
        </p>
      </main>
    );
  }
  return <DocumentEditor key={load.document.id} initial={load.document} />;
}

function statusLabel(status: SaveStatus, savedAt: string): string {
  switch (status) {
    case 'saved':
      return `Saved ${clockTime(savedAt)}`;
    case 'unsaved':
      return 'Unsaved changes';
    case 'saving':
      return 'Saving…';
    case 'retrying':
      return 'Save failed, retrying…';
    default:
      return 'Save failed';
  }
}

function DocumentEditor({ initial }: { initial: DocumentDetail }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [document, setDocument] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [titleError, setTitleError] = useState('');
  const [sharing, setSharing] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lostAccess, setLostAccess] = useState(false);
  const [remoteNote, setRemoteNote] = useState('');
  const [importNotice, setImportNotice] = useState(
    location.state as { importedFrom?: string; notes?: string[]; fresh?: boolean } | null,
  );
  const titleFocused = useRef(false);
  const savedTitle = useRef(initial.title);
  const titleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const editorRef = useRef<Editor | null>(null);
  // Kept as an immutable document so the last edits can still be saved after the editor unmounts.
  const latestDoc = useRef<{ toJSON(): unknown } | null>(null);

  // Router state is one-shot: a reload should not bring the import notice back.
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);

  const canEdit = document.role !== 'viewer' && !lostAccess;
  const save = useAutosave(initial.id, initial.version, initial.updatedAt, () => latestDoc.current?.toJSON());

  const editor = useEditor({
    extensions: [...documentExtensions, Placeholder.configure({ placeholder: 'Start writing…' })],
    content: initial.content,
    editable: initial.role !== 'viewer',
    autofocus: importNotice?.fresh ? 'start' : false,
    editorProps: { attributes: { class: 'prose', 'aria-label': 'Document text' } },
    onCreate: ({ editor: created }) => {
      latestDoc.current = created.state.doc;
    },
    onUpdate: ({ editor: updated }) => {
      latestDoc.current = updated.state.doc;
      save.markDirty();
    },
  });
  editorRef.current = editor;

  useEffect(() => {
    editor?.setEditable(canEdit, false);
  }, [editor, canEdit]);

  const applyRemote = useCallback(
    (latest: DocumentDetail) => {
      const current = editorRef.current;
      if (!current) return;
      const { from, to } = current.state.selection;
      current.commands.setContent(latest.content, { emitUpdate: false });
      latestDoc.current = current.state.doc;
      const end = current.state.doc.content.size;
      current.commands.setTextSelection({ from: Math.min(from, end), to: Math.min(to, end) });
      save.adopt(latest.version, latest.updatedAt);
    },
    [save.adopt],
  );

  // A light poll keeps open pages current. It is not co-editing: see ARCHITECTURE.md.
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (window.document.hidden || lostAccess) return;
      try {
        const latest = await api.getDocument(initial.id);
        if (stopped) return;
        setDocument((current) => ({ ...current, role: latest.role, shareCount: latest.shareCount }));
        if (!titleFocused.current) {
          setTitle(latest.title);
          savedTitle.current = latest.title;
        }
        if (latest.version > save.currentVersion() && save.isIdle()) {
          applyRemote(latest);
          setRemoteNote(`${firstName(latest.updatedBy)} updated this page at ${clockTime(latest.updatedAt)}.`);
        }
      } catch (error) {
        if (!stopped && (error as ApiRequestError).status === 404) setLostAccess(true);
      }
    };
    const timer = setInterval(() => void poll(), POLL_MS);
    // Coming back to a background tab should not wait for the next tick.
    const onVisibilityChange = () => void poll();
    window.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [initial.id, lostAccess, applyRemote, save.currentVersion, save.isIdle]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save.flush();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save.flush]);

  const saveTitle = useCallback(
    async (value: string) => {
      clearTimeout(titleTimer.current);
      if (value === savedTitle.current) return;
      try {
        await api.renameDocument(initial.id, value);
        savedTitle.current = value;
        setTitleError('');
      } catch (error) {
        setTitleError((error as ApiRequestError).message);
      }
    },
    [initial.id],
  );

  function changeTitle(value: string) {
    setTitle(value);
    clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => void saveTitle(value), 600);
  }

  function blurTitle() {
    titleFocused.current = false;
    if (!canEdit) return;
    const value = title.trim() || 'Untitled';
    setTitle(value);
    void saveTitle(value);
  }

  async function leave() {
    const saved = await save.flush();
    if (saved || lostAccess || save.status === 'gone') navigate('/');
    else setConfirmLeave(true);
  }

  async function restoreVersion(versionId: number) {
    if (!(await save.flush())) throw new Error('Your latest changes could not be saved, so nothing was restored.');
    const restored = await api.restoreVersion(initial.id, versionId, save.currentVersion());
    applyRemote(restored);
    setRemoteNote('Earlier version restored. The text it replaced is now in History.');
    setHistoryOpen(false);
  }

  async function loadLatest() {
    const latest = await api.getDocument(initial.id);
    applyRemote(latest);
    setTitle(latest.title);
  }

  async function keepMine() {
    const latest = await api.getDocument(initial.id);
    await save.overwrite(latest.version);
  }

  const banner = bannerFor(save.status, save.errorMessage, lostAccess);
  const isOwner = document.role === 'owner';

  return (
    <div className="editor-page">
      <header className="editor-bar">
        <button className="back" onClick={leave}>
          <span aria-hidden="true">←</span> Your pile
        </button>
        <input
          className="title-input"
          aria-label="Document title"
          value={title}
          maxLength={MAX_TITLE_LENGTH}
          readOnly={!canEdit}
          onFocus={() => {
            titleFocused.current = true;
          }}
          onChange={(e) => changeTitle(e.target.value)}
          onBlur={blurTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              editor?.commands.focus();
            }
          }}
        />
        <div className="editor-bar-right">
          {canEdit && (
            <span className={`save-state save-${save.status}`} role="status" data-testid="save-state">
              {statusLabel(save.status, save.savedAt)}
            </span>
          )}
          {canEdit && (
            <button className="link-button" onClick={() => setHistoryOpen(true)}>
              History
            </button>
          )}
          {isOwner ? (
            <>
              <span className="tag tag-owned">Yours</span>
              <button className="button button-primary" onClick={() => setSharing(true)}>
                Share{document.shareCount > 0 ? ` · ${document.shareCount}` : ''}
              </button>
            </>
          ) : (
            <span className="tag tag-shared">
              From {firstName(document.owner.name)} · {document.role === 'editor' ? 'can edit' : 'view only'}
            </span>
          )}
        </div>
      </header>

      {banner && (
        <div className="notice notice-error notice-bar" role="alert">
          <p>{banner.text}</p>
          {save.status === 'conflict' && !lostAccess && (
            <span className="notice-actions">
              <button className="button" onClick={loadLatest}>
                Load their version
              </button>
              <button className="button" onClick={keepMine}>
                Replace with mine
              </button>
            </span>
          )}
          {save.status === 'signed-out' && (
            <Link className="button" to="/login" reloadDocument>
              Sign in again
            </Link>
          )}
        </div>
      )}
      {titleError && (
        <div className="notice notice-error notice-bar" role="alert">
          <p>The title wasn't saved. {titleError}</p>
        </div>
      )}
      {remoteNote && (
        <div className="notice notice-bar">
          <p>{remoteNote}</p>
          <button className="link-button" onClick={() => setRemoteNote('')}>
            Dismiss
          </button>
        </div>
      )}
      {importNotice?.importedFrom && (
        <div className="notice notice-bar">
          <p>
            Imported from {importNotice.importedFrom}. {importNotice.notes?.join(' ')}
          </p>
          <button className="link-button" onClick={() => setImportNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className={`desk ${canEdit ? '' : 'is-readonly'}`}>
        {canEdit && editor && <ToolRail editor={editor} />}
        <main className="pad">
          {!canEdit && !lostAccess && <p className="readonly-note">You can read this page, but only {firstName(document.owner.name)} or an editor can change it.</p>}
          <EditorContent editor={editor} />
        </main>
      </div>

      {historyOpen && (
        <HistoryDialog documentId={document.id} onRestore={restoreVersion} onClose={() => setHistoryOpen(false)} />
      )}

      {confirmLeave && (
        <ConfirmDialog
          title="Leave without saving?"
          body="Your latest changes could not be saved and will be lost if you leave this page."
          cancelLabel="Stay here"
          confirmLabel="Leave anyway"
          onConfirm={() => navigate('/')}
          onCancel={() => setConfirmLeave(false)}
        />
      )}

      {sharing && (
        <ShareDialog
          documentId={document.id}
          title={title}
          onClose={(shareCount) => {
            setSharing(false);
            if (shareCount !== null) setDocument((current) => ({ ...current, shareCount }));
          }}
        />
      )}
    </div>
  );
}

function bannerFor(status: SaveStatus, message: string, lostAccess: boolean): { text: string } | null {
  if (lostAccess || status === 'gone') {
    return { text: 'You no longer have access to this document, so changes here can no longer be saved.' };
  }
  switch (status) {
    case 'conflict':
      return { text: 'Someone saved a newer version while you were editing. Your latest changes are not saved yet.' };
    case 'read-only':
      return { text: 'Your access changed to view only, so your latest changes could not be saved.' };
    case 'signed-out':
      return { text: 'Your session ended, so your latest changes are not saved. Copy anything you need, then sign in again.' };
    case 'rejected':
      return { text: `Your latest changes could not be saved. ${message}` };
    case 'retrying':
      return { text: "Can't reach the server. Keep this tab open: your changes will save as soon as it's back." };
    default:
      return null;
  }
}
