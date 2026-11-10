import { useState, type FormEvent } from 'react';
import type { CommentThread } from '../../shared/api.ts';
import type { Anchor } from '../../shared/anchors.ts';
import { hasRole, type Role } from '../../shared/limits.ts';
import type { ApiRequestError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.ts';
import { firstName, timeAgo } from '../lib/format.ts';

export interface PlacedThread extends CommentThread {
  detached: boolean;
}

interface Props {
  threads: PlacedThread[] | null;
  role: Role;
  loadError: string;
  draft: Anchor | null;
  activeId: number | null;
  onCancelDraft: () => void;
  onPost: (body: string, anchor: Anchor) => Promise<void>;
  onReply: (commentId: number, body: string) => Promise<void>;
  onResolve: (commentId: number, resolved: boolean) => Promise<void>;
  onDelete: (commentId: number) => Promise<void>;
  onSelect: (thread: PlacedThread) => void;
  onClose: () => void;
}

const failure = (caught: unknown) => (caught as ApiRequestError).message;

function Composer({
  label,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit(body);
      setBody('');
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <textarea aria-label={label} placeholder={label} required maxLength={5000} rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="composer-actions">
        {onCancel && (
          <button className="link-button" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="button button-small" type="submit" disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function CommentsPanel(props: Props) {
  const { threads, role, loadError, draft, activeId, onCancelDraft, onPost, onReply, onResolve, onDelete, onSelect, onClose } = props;
  const { user } = useAuth();
  const [showResolved, setShowResolved] = useState(false);
  const [actionError, setActionError] = useState('');
  const canComment = hasRole(role, 'commenter');
  const resolvedCount = threads?.filter((thread) => thread.resolved).length ?? 0;
  const visible = threads?.filter((thread) => showResolved || !thread.resolved) ?? [];

  const act = (action: () => Promise<void>) => {
    setActionError('');
    action().catch((caught) => setActionError(failure(caught)));
  };

  return (
    <aside className="comments-panel" aria-label="Comments">
      <header className="comments-head">
        <h2>Comments</h2>
        <button type="button" className="link-button" onClick={onClose}>
          Close
        </button>
      </header>

      {loadError && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}

      {draft && (
        <div className="thread is-active">
          <blockquote className="thread-quote">{draft.quote}</blockquote>
          <Composer label="Add a comment" submitLabel="Comment" onSubmit={(body) => onPost(body, draft)} onCancel={onCancelDraft} />
        </div>
      )}

      {threads && visible.length === 0 && !draft && (
        <p className="comments-empty">
          {canComment ? 'No open comments. Select some text and press Comment to start one.' : 'No open comments on this page.'}
        </p>
      )}

      <ul className="thread-list">
        {visible.map((thread) => {
          const mine = thread.author.id === user?.id;
          const canResolve = hasRole(role, 'editor') || (canComment && mine);
          const canDelete = role === 'owner' || (canComment && mine);
          return (
            <li key={thread.id} className={`thread ${thread.id === activeId ? 'is-active' : ''} ${thread.resolved ? 'is-resolved' : ''}`}>
              <button type="button" className="thread-quote-button" onClick={() => onSelect(thread)}>
                <blockquote className="thread-quote">{thread.anchor.quote}</blockquote>
              </button>
              {thread.detached && <p className="thread-detached">The text this was about has changed.</p>}
              <p className="thread-byline">
                <strong>{firstName(thread.author.name)}</strong> {timeAgo(thread.createdAt)}
              </p>
              <p className="thread-body">{thread.body}</p>
              {thread.replies.map((reply) => (
                <div className="reply" key={reply.id}>
                  <p className="thread-byline">
                    <strong>{firstName(reply.author.name)}</strong> {timeAgo(reply.createdAt)}
                  </p>
                  <p className="thread-body">{reply.body}</p>
                </div>
              ))}
              {canComment && !thread.resolved && <Composer label="Reply" submitLabel="Reply" onSubmit={(body) => onReply(thread.id, body)} />}
              {(canResolve || canDelete) && (
                <div className="thread-actions">
                  {canResolve && (
                    <button type="button" className="link-button" onClick={() => act(() => onResolve(thread.id, !thread.resolved))}>
                      {thread.resolved ? 'Reopen' : 'Resolve'}
                    </button>
                  )}
                  {canDelete && (
                    <button type="button" className="link-button" onClick={() => act(() => onDelete(thread.id))}>
                      Delete
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {resolvedCount > 0 && (
        <button type="button" className="link-button" onClick={() => setShowResolved((current) => !current)}>
          {showResolved ? 'Hide' : 'Show'} resolved ({resolvedCount})
        </button>
      )}
    </aside>
  );
}
