import { useEffect, useRef, useState, type FormEvent } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { VersionSummary } from '../../shared/api.ts';
import { documentExtensions, type DocJson } from '../../shared/schema.ts';
import { api, ApiRequestError } from '../lib/api.ts';
import { firstName, timeAgo } from '../lib/format.ts';

function Preview({ content }: { content: DocJson }) {
  const editor = useEditor({
    extensions: documentExtensions,
    content,
    editable: false,
    editorProps: { attributes: { class: 'prose', 'aria-label': 'Version preview' } },
  });
  return <EditorContent editor={editor} />;
}

interface Props {
  documentId: string;
  onName: (name: string) => Promise<VersionSummary[]>;
  onRestore: (versionId: number) => Promise<void>;
  onClose: () => void;
}

export function HistoryDialog({ documentId, onName, onRestore, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [selected, setSelected] = useState<VersionSummary | null>(null);
  const [preview, setPreview] = useState<{ id: number; content: DocJson } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function select(version: VersionSummary) {
    setSelected(version);
    setError('');
    api.getVersion(documentId, version.id).then(
      (content) => setPreview({ id: version.id, content }),
      (caught: ApiRequestError) => setError(caught.message),
    );
  }

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    api.listVersions(documentId).then(
      (list) => {
        setVersions(list);
        if (list[0]) select(list[0]);
      },
      (caught: ApiRequestError) => setError(caught.message),
    );
  }, [documentId]);

  async function saveNamed(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const list = await onName(name);
      setVersions(list);
      setName('');
      if (list[0]) select(list[0]);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await onRestore(selected.id);
    } catch (caught) {
      setError((caught as Error).message);
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="dialog dialog-wide" aria-labelledby="history-heading" onCancel={onClose}>
      <h2 id="history-heading">Earlier versions</h2>
      <form className="history-name" onSubmit={saveNamed}>
        <input aria-label="Version name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Name the current version, e.g. Sent to legal" required />
        <button className="button" type="submit" disabled={busy}>
          Save version
        </button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {versions === null && !error && <p aria-busy="true">Loading…</p>}
      {versions?.length === 0 && (
        <p className="history-empty">
          Nothing to go back to yet. Foolscap keeps a checkpoint every few minutes while a page changes, and whenever someone else edits it.
        </p>
      )}
      {versions && versions.length > 0 && (
        <div className="history">
          <ul className="history-list">
            {versions.map((version) => (
              <li key={version.id}>
                <button className="history-item" aria-pressed={selected?.id === version.id} onClick={() => select(version)}>
                  <span className={version.name ? 'history-named' : undefined}>{version.name ?? timeAgo(version.savedAt)}</span>
                  <small>{version.name ? timeAgo(version.savedAt) : firstName(version.savedBy)}</small>
                </button>
              </li>
            ))}
          </ul>
          <div className="history-preview">{preview && <Preview key={preview.id} content={preview.content} />}</div>
        </div>
      )}

      <div className="dialog-actions">
        <button className="button" onClick={onClose}>
          Close
        </button>
        {selected && (
          <button className="button button-primary" disabled={busy || !preview} onClick={restore}>
            {busy ? 'Restoring…' : 'Restore this version'}
          </button>
        )}
      </div>
    </dialog>
  );
}
