import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Share } from '../../shared/api.ts';
import { DEMO_ACCOUNTS } from '../../shared/demo.ts';
import type { ShareRole } from '../../shared/limits.ts';
import { api, ApiRequestError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.ts';

interface Props {
  documentId: string;
  title: string;
  onClose: (shareCount: number | null) => void;
}

export function ShareDialog({ documentId, title, onClose }: Props) {
  const { user } = useAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ShareRole>('editor');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    api.listShares(documentId).then(setShares, (e: ApiRequestError) => setError(e.message));
  }, [documentId]);

  async function run(action: () => Promise<Share[]>): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      setShares(await action());
      return true;
    } catch (caught) {
      setError((caught as ApiRequestError).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (await run(() => api.share(documentId, email, role))) setEmail('');
  }

  const close = () => onClose(shares?.length ?? null);
  const suggestions = DEMO_ACCOUNTS.filter(
    (account) => account.email !== user?.email && !shares?.some((share) => share.email === account.email),
  );

  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="share-heading" onCancel={close}>
      <h2 id="share-heading">Share "{title}"</h2>

      <form className="share-form" onSubmit={add}>
        <label className="share-email">
          Person's email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@foolscap.test" />
        </label>
        <label>
          Access
          <select value={role} onChange={(e) => setRole(e.target.value as ShareRole)}>
            <option value="editor">Can edit</option>
            <option value="viewer">Can view</option>
          </select>
        </label>
        <button className="button button-primary" type="submit" disabled={busy}>
          Share
        </button>
      </form>

      {suggestions.length > 0 && (
        <p className="share-suggestions">
          Demo accounts:{' '}
          {suggestions.map((account) => (
            <button key={account.email} className="link-button" type="button" onClick={() => setEmail(account.email)}>
              {account.email}
            </button>
          ))}
        </p>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <h3>Who has access</h3>
      <ul className="share-list">
        <li>
          <span>
            {user?.name} <small>{user?.email}</small>
          </span>
          <span className="share-owner">Owner</span>
        </li>
        {shares === null && !error && <li aria-busy="true">Loading…</li>}
        {shares?.map((share) => (
          <li key={share.userId}>
            <span>
              {share.name} <small>{share.email}</small>
            </span>
            <span className="share-controls">
              <select
                aria-label={`Access for ${share.name}`}
                value={share.role}
                disabled={busy}
                onChange={(e) => run(() => api.share(documentId, share.email, e.target.value as ShareRole))}
              >
                <option value="editor">Can edit</option>
                <option value="viewer">Can view</option>
              </select>
              <button
                className="link-button"
                disabled={busy}
                aria-label={`Remove ${share.name}`}
                onClick={() => run(() => api.unshare(documentId, share.userId))}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="dialog-actions">
        <button className="button" onClick={close}>
          Done
        </button>
      </div>
    </dialog>
  );
}
