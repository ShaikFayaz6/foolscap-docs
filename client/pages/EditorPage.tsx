import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import type { CommentThread, DocumentDetail } from '../../shared/api.ts';
import { createAnchor, resolveAnchor, type Anchor } from '../../shared/anchors.ts';
import { commentLayer, cursorLayer, Decoration, Layers } from '../lib/layers.ts';
import { useAuth } from '../lib/auth.ts';
import { useLive } from '../lib/useLive.ts';
import { otherPeople, peerColor, PeopleHere } from '../components/PeopleHere.tsx';
import { CommentsPanel, type PlacedThread } from '../components/CommentsPanel.tsx';
import { documentExtensions } from '../../shared/schema.ts';
import { hasRole, MAX_TITLE_LENGTH, ROLE_LABELS, type ShareRole } from '../../shared/limits.ts';
import { api, type ApiRequestError } from '../lib/api.ts';
import { clockTime, firstName } from '../lib/format.ts';
import { useAutosave, type SaveStatus } from '../lib/useAutosave.ts';
import { ToolRail } from '../components/ToolRail.tsx';
import { ShareDialog } from '../components/ShareDialog.tsx';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { HistoryDialog } from '../components/HistoryDialog.tsx';
import { AppHeader } from '../components/AppHeader.tsx';
import { Icon } from '../components/Icon.tsx';
import { usePageTitle, usePopover, useToast } from '../lib/ui.tsx';

const POLL_MS = 8000;
const LIVE_POLL_MS = 30_000;

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
  usePageTitle(load.state === 'ready' ? undefined : load.state === 'loading' ? 'Loading' : load.notFound ? 'Not found' : "Couldn't load");

  if (load.state === 'loading') {
    return (
      <div className="page-with-header" aria-busy="true">
        <AppHeader />
        <span className="visually-hidden">Finding that page…</span>
        <EditorSkeleton />
      </div>
    );
  }
  if (load.state === 'failed') {
    return (
      <div className="page-with-header">
        <AppHeader />
        <main className="center-state">
        <h1>{load.notFound ? "This page isn't in your pile" : "This document didn't load"}</h1>
        <p>{load.message}</p>
        <p className="center-actions">
          {!load.notFound && (
            <button type="button" className="button" onClick={fetchDocument}>
              Try again
            </button>
          )}
          <Link className="button" to="/">
            Back to your pile
          </Link>
        </p>
        </main>
      </div>
    );
  }
  return <DocumentEditor key={load.document.id} initial={load.document} />;
}

const EXPORT_FORMATS = [
  ['markdown', 'Markdown (.md)'],
  ['pdf', 'PDF (.pdf)'],
] as const;

type ExportFormat = (typeof EXPORT_FORMATS)[number][0];

/** On narrow screens, the secondary editor actions live behind a "more" button. */
function MoreMenu({
  commentCount,
  canEdit,
  onComments,
  onHistory,
  onExport,
}: {
  commentCount: number;
  canEdit: boolean;
  onComments: () => void;
  onHistory: () => void;
  onExport: (format: ExportFormat) => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div className="more-menu" ref={ref}>
      <button
        type="button"
        className="bar-button bar-button-square"
        aria-label="More actions"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
        {commentCount > 0 && <span className="dot-badge" aria-hidden="true" />}
      </button>
      {open && (
        <div className="popover more-panel">
          <div className="popover-items">
            <button type="button" className="popover-item" onClick={run(onComments)}>
              <Icon name="comment" /> Comments
              {commentCount > 0 && <span className="count-badge">{commentCount}</span>}
            </button>
            {canEdit && (
              <button type="button" className="popover-item" onClick={run(onHistory)}>
                <Icon name="history" /> History
              </button>
            )}
          </div>
          <div className="popover-items">
            <p className="popover-label">Export</p>
            {EXPORT_FORMATS.map(([format, label]) => (
              <button type="button" key={format} className="popover-item" onClick={run(() => onExport(format))}>
                <Icon name="download" /> {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Grey placeholder shapes in the layout of the editor, shown while a document loads. */
function EditorSkeleton() {
  return (
    <div className="skeleton-editor" aria-hidden="true">
      <div className="skeleton-bar">
        <span className="skeleton skeleton-line" style={{ width: 90 }} />
        <span className="skeleton skeleton-title" />
        <span className="skeleton skeleton-pill" style={{ marginLeft: 'auto' }} />
        <span className="skeleton skeleton-pill" />
      </div>
      <div className="skeleton-pad">
        <span className="skeleton skeleton-heading" />
        {['96%', '88%', '92%', '64%', 'gap', '90%', '84%', '72%'].map((width) =>
          width === 'gap' ? <br key={width} /> : <span key={width} className="skeleton skeleton-line" style={{ width }} />,
        )}
      </div>
    </div>
  );
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
  // Where to go once the person agrees to leave with unsaved changes (home, or signing out).
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [threads, setThreads] = useState<CommentThread[] | null>(null);
  const [commentsError, setCommentsError] = useState('');
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [draftAnchor, setDraftAnchor] = useState<Anchor | null>(null);
  const [activeComment, setActiveComment] = useState<number | null>(null);
  const [docRevision, setDocRevision] = useState(0);
  const [exportError, setExportError] = useState('');
  const exportMenu = useRef<HTMLDetailsElement>(null);
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

  const canEdit = hasRole(document.role, 'editor') && !lostAccess;
  const canComment = hasRole(document.role, 'commenter') && !lostAccess;
  const save = useAutosave(initial.id, initial.version, initial.updatedAt, () => latestDoc.current?.toJSON());
  const { user } = useAuth();
  const toast = useToast();
  usePageTitle(title.trim() || 'Untitled');
  const pollNow = useRef<() => void>(() => {});
  const loadCommentsRef = useRef<() => void>(() => {});
  const live = useLive(initial.id, !lostAccess, (what) => {
    if (what === 'comments') loadCommentsRef.current();
    else pollNow.current();
  });
  const sendSelection = useRef(live.sendSelection);
  sendSelection.current = live.sendSelection;
  const people = otherPeople(live.peers, user?.id);

  const editor = useEditor({
    extensions: [...documentExtensions, Placeholder.configure({ placeholder: 'Start writing…' }), Layers],
    content: initial.content,
    editable: hasRole(initial.role, 'editor'),
    autofocus: importNotice?.fresh ? 'start' : false,
    editorProps: {
      attributes: { class: 'prose', 'aria-label': 'Document text' },
      handleDOMEvents: {
        click: (_view, event) => {
          const mark = (event.target as HTMLElement).closest('[data-comment-id]');
          if (mark) {
            setActiveComment(Number(mark.getAttribute('data-comment-id')));
            setCommentsOpen(true);
          }
          return false;
        },
      },
    },
    onCreate: ({ editor: created }) => {
      latestDoc.current = created.state.doc;
    },
    onUpdate: ({ editor: updated }) => {
      latestDoc.current = updated.state.doc;
      save.markDirty();
    },
    onSelectionUpdate: ({ editor: updated }) => {
      const { from, to } = updated.state.selection;
      sendSelection.current({ from, to });
    },
    onFocus: ({ editor: focused }) => {
      const { from, to } = focused.state.selection;
      sendSelection.current({ from, to });
    },
    onBlur: () => sendSelection.current(null),
  });
  editorRef.current = editor;

  useEffect(() => {
    editor?.setEditable(canEdit, false);
  }, [editor, canEdit]);

  const loadComments = useCallback(() => {
    api.listComments(initial.id).then(
      (list) => {
        setThreads(list);
        setCommentsError('');
      },
      (error: ApiRequestError) => setCommentsError(error.message),
    );
  }, [initial.id]);

  useEffect(loadComments, [loadComments]);
  loadCommentsRef.current = loadComments;

  // Positions come from each person's own copy, so they are clamped and may lag a moment behind.
  useEffect(() => {
    if (!editor || editor.view.composing) return;
    cursorLayer.set(editor, (doc) => {
      const size = doc.content.size;
      return live.peers
        .filter((peer) => peer.userId !== user?.id && peer.selection)
        .flatMap((peer) => {
          const color = peerColor(peer.name);
          const from = Math.min(peer.selection!.from, size);
          const to = Math.min(peer.selection!.to, size);
          const caret = window.document.createElement('span');
          caret.className = 'remote-caret';
          caret.style.setProperty('--peer', color);
          // The name is drawn with CSS, so it never becomes part of the page's text.
          caret.dataset.name = firstName(peer.name);
          return [
            ...(from < to ? [Decoration.inline(from, to, { style: `background: ${color}2e` })] : []),
            Decoration.widget(to, caret, { key: `${peer.id}:${to}:${color}`, side: -1 }),
          ];
        });
    });
  }, [editor, live.peers, user?.id, docRevision]);

  // Anchors are found again whenever comments change or a save settles the text.
  const placedThreads = useMemo<PlacedThread[] | null>(() => {
    if (!threads || !editor) return null;
    const placed = threads.map((thread) => {
      const place = resolveAnchor(editor.state.doc, thread.anchor);
      return { ...thread, detached: !place, order: place?.from ?? Number.MAX_SAFE_INTEGER };
    });
    return placed.sort((a, b) => a.order - b.order);
  }, [threads, editor, docRevision, save.savedAt]);

  const openThreadCount = placedThreads?.filter((thread) => !thread.resolved).length ?? 0;

  useEffect(() => {
    if (!editor || !threads) return;
    commentLayer.set(editor, (doc) =>
      threads.flatMap((thread) => {
        const place = thread.resolved ? null : resolveAnchor(doc, thread.anchor);
        if (!place) return [];
        return [
          Decoration.inline(place.from, place.to, {
            class: thread.id === activeComment ? 'comment-mark is-active' : 'comment-mark',
            'data-comment-id': String(thread.id),
          }),
        ];
      }),
    );
  }, [editor, threads, activeComment, docRevision, save.savedAt]);

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
      setDocRevision((revision) => revision + 1);
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
        loadComments();
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
    pollNow.current = () => void poll();
    // The socket announces changes, so polling is only the safety net while it is up.
    const timer = setInterval(() => void poll(), live.status === 'live' ? LIVE_POLL_MS : POLL_MS);
    // Coming back to a background tab should not wait for the next tick.
    const onVisibilityChange = () => void poll();
    window.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [initial.id, lostAccess, live.status, applyRemote, loadComments, save.currentVersion, save.isIdle]);

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

  async function leave(go: () => void) {
    const saved = await save.flush();
    if (saved || lostAccess || save.status === 'gone') go();
    else setPendingLeave(() => go);
  }

  function startComment() {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const anchor = createAnchor(editor.state.doc, from, to);
    if (!anchor) return;
    setDraftAnchor(anchor);
    setCommentsOpen(true);
  }

  function selectThread(thread: PlacedThread) {
    setActiveComment(thread.id);
    if (!editor || thread.detached) return;
    const place = resolveAnchor(editor.state.doc, thread.anchor);
    if (!place) return;
    const { node } = editor.view.domAtPos(place.from);
    (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  async function exportAs(format: 'markdown' | 'pdf') {
    setExportError('');
    // The server exports what is saved, so what's on screen has to be saved first.
    if (canEdit && !(await save.flush())) {
      setExportError('Your latest changes could not be saved, so nothing was exported.');
      return;
    }
    try {
      const blob = await api.exportDocument(initial.id, format);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `${title.trim() || 'Untitled'}.${format === 'pdf' ? 'pdf' : 'md'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast(`Downloaded ${link.download}`);
    } catch (error) {
      setExportError((error as ApiRequestError).message);
    }
  }

  async function nameVersion(name: string) {
    if (!(await save.flush())) throw new Error('Your latest changes could not be saved, so no version was created.');
    return api.nameVersion(initial.id, name);
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
      <AppHeader guard={(go) => void leave(go)} />
      <header className="editor-bar">
        <div className="editor-title">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <Link
              to="/"
              onClick={(event) => {
                event.preventDefault();
                void leave(() => navigate('/'));
              }}
            >
              {isOwner ? 'Your pile' : 'Shared with you'}
            </Link>
            <Icon name="chevronRight" size={14} />
          </nav>
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
        </div>
        <div className="editor-bar-right">
          <PeopleHere people={people} reconnecting={live.status === 'reconnecting'} />
          {canEdit && (
            <span className={`save-state save-${save.status}`} role="status" data-testid="save-state">
              {statusLabel(save.status, save.savedAt)}
            </span>
          )}
          <div className="bar-actions">
            <button type="button" className="bar-button" aria-expanded={commentsOpen} onClick={() => setCommentsOpen((open) => !open)}>
              <Icon name="comment" />
              Comments
              {openThreadCount > 0 && <span className="count-badge">{openThreadCount}</span>}
            </button>
            {canEdit && (
              <button type="button" className="bar-button" onClick={() => setHistoryOpen(true)}>
                <Icon name="history" />
                History
              </button>
            )}
            <details className="export-menu" ref={exportMenu}>
              <summary className="bar-button">
                <Icon name="download" />
                Export
                <Icon name="chevronDown" size={14} className="bar-chevron" />
              </summary>
              <div className="popover export-options">
                {EXPORT_FORMATS.map(([format, label]) => (
                  <button
                    type="button"
                    key={format}
                    className="popover-item"
                    onClick={() => {
                      exportMenu.current?.removeAttribute('open');
                      void exportAs(format);
                    }}
                  >
                    <Icon name="file" />
                    {label}
                  </button>
                ))}
              </div>
            </details>
          </div>
          <MoreMenu
            commentCount={openThreadCount}
            canEdit={canEdit}
            onComments={() => setCommentsOpen((open) => !open)}
            onHistory={() => setHistoryOpen(true)}
            onExport={(format) => void exportAs(format)}
          />
          {isOwner ? (
            <>
              <span className="tag tag-owned">Yours</span>
              <button type="button" className="button button-primary button-icon" onClick={() => setSharing(true)}>
                <Icon name="share" />
                Share{document.shareCount > 0 ? ` · ${document.shareCount}` : ''}
              </button>
            </>
          ) : (
            <span className="tag tag-shared">
              From {firstName(document.owner.name)} · {ROLE_LABELS[document.role as ShareRole].toLowerCase()}
            </span>
          )}
        </div>
      </header>

      {banner && (
        <div className="notice notice-error notice-bar" role="alert">
          <p>{banner.text}</p>
          {save.status === 'conflict' && !lostAccess && (
            <span className="notice-actions">
              <button type="button" className="button" onClick={loadLatest}>
                Load their version
              </button>
              <button type="button" className="button" onClick={keepMine}>
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
      {exportError && (
        <div className="notice notice-error notice-bar" role="alert">
          <p>The export failed. {exportError}</p>
          <button type="button" className="link-button" onClick={() => setExportError('')}>
            Dismiss
          </button>
        </div>
      )}
      {remoteNote && (
        <div className="notice notice-bar">
          <p>{remoteNote}</p>
          <button type="button" className="link-button" onClick={() => setRemoteNote('')}>
            Dismiss
          </button>
        </div>
      )}
      {importNotice?.importedFrom && (
        <div className="notice notice-bar">
          <p>
            Imported from {importNotice.importedFrom}. {importNotice.notes?.join(' ')}
          </p>
          <button type="button" className="link-button" onClick={() => setImportNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className={`desk ${canEdit ? '' : 'is-readonly'}`}>
        {canComment && editor && <ToolRail editor={editor} canEdit={canEdit} canComment={canComment} onComment={startComment} />}
        <main className="pad">
          {!canEdit && !lostAccess && (
            <p className="readonly-note">
              {document.role === 'commenter'
                ? 'You can read and comment on this page. Select text to leave a comment.'
                : `You can read this page, but only ${firstName(document.owner.name)} or an editor can change it.`}
            </p>
          )}
          <EditorContent editor={editor} />
        </main>
        {commentsOpen && (
          <CommentsPanel
            threads={placedThreads}
            role={lostAccess ? 'viewer' : document.role}
            loadError={commentsError}
            draft={draftAnchor}
            activeId={activeComment}
            onCancelDraft={() => setDraftAnchor(null)}
            onPost={async (body, anchor) => {
              setThreads(await api.addComment(initial.id, body, anchor));
              setDraftAnchor(null);
            }}
            onReply={async (commentId, body) => setThreads(await api.replyToComment(initial.id, commentId, body))}
            onResolve={async (commentId, resolved) => setThreads(await api.setCommentResolved(initial.id, commentId, resolved))}
            onDelete={async (commentId) => setThreads(await api.deleteComment(initial.id, commentId))}
            onSelect={selectThread}
            onClose={() => setCommentsOpen(false)}
          />
        )}
      </div>

      {historyOpen && (
        <HistoryDialog documentId={document.id} onName={nameVersion} onRestore={restoreVersion} onClose={() => setHistoryOpen(false)} />
      )}

      {pendingLeave && (
        <ConfirmDialog
          title="Leave without saving?"
          body="Your latest changes could not be saved and will be lost if you leave this page."
          cancelLabel="Stay here"
          confirmLabel="Leave anyway"
          onConfirm={() => {
            setPendingLeave(null);
            pendingLeave();
          }}
          onCancel={() => setPendingLeave(null)}
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
