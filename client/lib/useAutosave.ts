import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ApiRequestError } from './api.ts';

export type SaveStatus =
  | 'saved'
  | 'unsaved'
  | 'saving'
  | 'retrying'
  | 'conflict'
  | 'read-only'
  | 'gone'
  | 'signed-out'
  | 'rejected';

const SAVE_DELAY_MS = 800;
const MAX_RETRY_MS = 30_000;

/**
 * Debounced, serialized saving. At most one request is in flight, edits made
 * meanwhile are sent afterwards, and transient failures retry with backoff.
 * Failures that retrying cannot fix halt saving until the person decides.
 */
export function useAutosave(docId: string, initialVersion: number, initialSavedAt: string, readContent: () => unknown) {
  const [status, setStatusState] = useState<SaveStatus>('saved');
  const [savedAt, setSavedAt] = useState(initialSavedAt);
  const [errorMessage, setErrorMessage] = useState('');
  const state = useRef({
    version: initialVersion,
    dirty: false,
    halted: false,
    attempt: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    inFlight: null as Promise<boolean> | null,
    readContent,
  });
  state.current.readContent = readContent;

  const setStatus = useCallback((next: SaveStatus) => setStatusState(next), []);

  const flush = useCallback((): Promise<boolean> => {
    const s = state.current;
    clearTimeout(s.timer);
    if (s.inFlight) return s.inFlight.then(() => flush());
    if (!s.dirty) return Promise.resolve(!s.halted);
    if (s.halted) return Promise.resolve(false);

    s.dirty = false;
    setStatus('saving');
    const request = api.saveContent(docId, s.readContent(), s.version).then(
      (result) => {
        s.version = result.version;
        s.attempt = 0;
        setSavedAt(result.updatedAt);
        if (s.dirty) {
          setStatus('unsaved');
          s.timer = setTimeout(flush, SAVE_DELAY_MS);
        } else {
          setStatus('saved');
        }
        return true;
      },
      (error: ApiRequestError) => {
        s.dirty = true;
        setErrorMessage(error.message);
        const halts: Record<number, SaveStatus> = { 401: 'signed-out', 403: 'read-only', 404: 'gone', 409: 'conflict' };
        const halting = halts[error.status] ?? (error.status === 413 || error.status === 422 ? 'rejected' : null);
        if (halting) {
          s.halted = true;
          setStatus(halting);
        } else {
          setStatus('retrying');
          s.timer = setTimeout(flush, Math.min(1000 * 2 ** s.attempt, MAX_RETRY_MS));
          s.attempt += 1;
        }
        return false;
      },
    );
    s.inFlight = request.finally(() => {
      s.inFlight = null;
    });
    return s.inFlight;
  }, [docId, setStatus]);

  const markDirty = useCallback(() => {
    const s = state.current;
    s.dirty = true;
    if (s.halted) return;
    setStatus('unsaved');
    clearTimeout(s.timer);
    s.timer = setTimeout(flush, SAVE_DELAY_MS);
  }, [flush, setStatus]);

  /** Accepts a version loaded from the server, leaving nothing pending. */
  const adopt = useCallback(
    (version: number, updatedAt: string) => {
      const s = state.current;
      clearTimeout(s.timer);
      Object.assign(s, { version, dirty: false, halted: false, attempt: 0 });
      setSavedAt(updatedAt);
      setStatus('saved');
    },
    [setStatus],
  );

  /** Replaces whatever is on the server with the local text, knowingly. */
  const overwrite = useCallback(
    (latestVersion: number) => {
      const s = state.current;
      Object.assign(s, { version: latestVersion, dirty: true, halted: false, attempt: 0 });
      return flush();
    },
    [flush],
  );

  const isIdle = useCallback(() => !state.current.dirty && !state.current.inFlight, []);
  const currentVersion = useCallback(() => state.current.version, []);

  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!isIdle()) event.preventDefault();
    };
    const retryNow = () => {
      void flush();
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    window.addEventListener('online', retryNow);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeLeaving);
      window.removeEventListener('online', retryNow);
      // Leaving the page within the app still saves the last edits.
      void flush();
      clearTimeout(state.current.timer);
    };
  }, [flush, isIdle]);

  return { status, savedAt, errorMessage, markDirty, flush, adopt, overwrite, isIdle, currentVersion };
}
