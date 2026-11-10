import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveChange, LiveMessage, LivePeer } from '../../shared/api.ts';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting';
type Selection = LivePeer['selection'];

const MAX_BACKOFF_MS = 30_000;
const SEND_INTERVAL_MS = 80;

/** Keeps a socket open for one document. Losing it only costs presence: saving never depends on it. */
export function useLive(documentId: string, active: boolean, onChanged: (what: LiveChange) => void) {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [peers, setPeers] = useState<LivePeer[]>([]);
  const socket = useRef<WebSocket | null>(null);
  const selection = useRef<Selection>(null);
  const sendTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const flushSelection = useCallback(() => {
    sendTimer.current = undefined;
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: 'selection', selection: selection.current }));
    }
  }, []);

  useEffect(() => {
    if (!active) {
      setPeers([]);
      return;
    }
    let stopped = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${scheme}://${window.location.host}/api/documents/${documentId}/live`);
      socket.current = ws;
      ws.onopen = () => {
        attempts = 0;
        setStatus('live');
        flushSelection();
        // Anything may have changed while the connection was down.
        changed.current('document');
        changed.current('comments');
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as LiveMessage;
        if (message.type === 'presence') setPeers(message.peers);
        else changed.current(message.what);
      };
      ws.onclose = (event) => {
        if (stopped) return;
        setPeers([]);
        if (event.code >= 4400) {
          // The server has ended this for good. A poll turns that into the right message.
          changed.current('access');
          return;
        }
        setStatus('reconnecting');
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempts);
        attempts += 1;
        retry = setTimeout(connect, delay * (0.75 + Math.random() / 2));
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(sendTimer.current);
      sendTimer.current = undefined;
      socket.current?.close(1000);
      socket.current = null;
    };
  }, [documentId, active, flushSelection]);

  const sendSelection = useCallback(
    (next: Selection) => {
      selection.current = next;
      if (sendTimer.current === undefined) sendTimer.current = setTimeout(flushSelection, SEND_INTERVAL_MS);
    },
    [flushSelection],
  );

  return { status, peers, sendSelection };
}
