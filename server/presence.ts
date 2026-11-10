import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import { roleFor, SESSION_COOKIE, userForToken } from './access.ts';
import type { Db } from './db.ts';
import type { LiveChange, LiveMessage, LivePeer } from '../shared/api.ts';

/** How the HTTP routes tell people with a document open that something changed. */
export interface LiveEvents {
  changed(documentId: string, what: Exclude<LiveChange, 'access'>): void;
  accessChanged(documentId: string): void;
}

export const NO_LIVE_EVENTS: LiveEvents = { changed() {}, accessChanged() {} };

interface Connection extends LivePeer {
  socket: WebSocket;
  documentId: string;
  token: string;
  alive: boolean;
  windowStart: number;
  windowCount: number;
}

interface Options {
  heartbeatMs?: number;
}

const PATH = /^\/api\/documents\/([^/]+)\/live$/;
const MAX_PER_DOCUMENT = 25;
const MAX_PER_USER = 6;
const RATE_WINDOW_MS = 5000;
const RATE_LIMIT = 150;
const BROADCAST_DELAY_MS = 40;

/** Close codes at or above 4400 tell the client not to reconnect. */
export const CLOSE_NO_ACCESS = 4403;
export const CLOSE_SIGNED_OUT = 4401;

const position = z.number().int().nonnegative().max(100_000_000);
const clientMessage = z.object({
  type: z.literal('selection'),
  selection: z.object({ from: position, to: position }).nullable(),
});

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** Cookies travel on WebSocket upgrades from any site, so the origin has to be checked by hand. */
function sameOrigin(request: IncomingMessage): boolean {
  try {
    return new URL(request.headers.origin ?? '').host === request.headers.host;
  } catch {
    return false;
  }
}

export class PresenceHub implements LiveEvents {
  private readonly db: Db;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly rooms = new Map<string, Set<Connection>>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(db: Db, options: Options = {}) {
    this.db = db;
    this.heartbeat = setInterval(() => this.checkConnections(), options.heartbeatMs ?? 30_000);
    this.heartbeat.unref();
  }

  attach(server: Server): void {
    server.on('upgrade', (request, socket, head) => {
      socket.on('error', () => socket.destroy());
      try {
        this.upgrade(request, socket, head);
      } catch {
        refuse(socket, 500, 'Internal Server Error');
      }
    });
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const documentId = PATH.exec((request.url ?? '').split('?')[0]!)?.[1];
    if (!documentId) {
      refuse(socket, 404, 'Not Found');
      return;
    }
    if (!sameOrigin(request)) {
      refuse(socket, 403, 'Forbidden');
      return;
    }
    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const user = userForToken(this.db, token);
    if (!token || !user) {
      refuse(socket, 401, 'Unauthorized');
      return;
    }
    if (!roleFor(this.db, documentId, user.id)) {
      refuse(socket, 404, 'Not Found');
      return;
    }
    const room = this.rooms.get(documentId);
    const mine = [...(room ?? [])].filter((connection) => connection.userId === user.id).length;
    if ((room?.size ?? 0) >= MAX_PER_DOCUMENT || mine >= MAX_PER_USER) {
      refuse(socket, 429, 'Too Many Requests');
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      const connection: Connection = {
        id: randomUUID(),
        userId: user.id,
        name: user.name,
        selection: null,
        socket: ws,
        documentId,
        token,
        alive: true,
        windowStart: Date.now(),
        windowCount: 0,
      };
      this.join(connection);
    });
  }

  private join(connection: Connection): void {
    const { socket, documentId } = connection;
    let room = this.rooms.get(documentId);
    if (!room) {
      room = new Set();
      this.rooms.set(documentId, room);
    }
    room.add(connection);
    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('message', (data) => this.receive(connection, data));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => this.leave(connection));
    this.scheduleBroadcast(documentId);
  }

  private leave(connection: Connection): void {
    const room = this.rooms.get(connection.documentId);
    if (!room?.delete(connection)) return;
    if (room.size === 0) this.rooms.delete(connection.documentId);
    else this.scheduleBroadcast(connection.documentId);
  }

  private receive(connection: Connection, data: RawData): void {
    const now = Date.now();
    if (now - connection.windowStart > RATE_WINDOW_MS) {
      connection.windowStart = now;
      connection.windowCount = 0;
    }
    connection.windowCount += 1;
    if (connection.windowCount > RATE_LIMIT) {
      connection.socket.close(1008, 'too many messages');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    const message = clientMessage.safeParse(parsed);
    if (!message.success) return;
    connection.selection = message.data.selection;
    this.scheduleBroadcast(connection.documentId);
  }

  /** Bursts of cursor movement become one update. */
  private scheduleBroadcast(documentId: string): void {
    if (this.pending.has(documentId)) return;
    const timer = setTimeout(() => {
      this.pending.delete(documentId);
      const room = this.rooms.get(documentId);
      if (!room) return;
      const peers = [...room].map(({ id, userId, name, selection }): LivePeer => ({ id, userId, name, selection }));
      this.send(room, { type: 'presence', peers });
    }, BROADCAST_DELAY_MS);
    timer.unref();
    this.pending.set(documentId, timer);
  }

  private send(connections: Iterable<Connection>, message: LiveMessage): void {
    const text = JSON.stringify(message);
    for (const { socket } of connections) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }
  }

  changed(documentId: string, what: Exclude<LiveChange, 'access'>): void {
    const room = this.rooms.get(documentId);
    if (room) this.send(room, { type: 'changed', what });
  }

  /** Re-reads every open connection's role, and removes anyone who has lost access. */
  accessChanged(documentId: string): void {
    const room = this.rooms.get(documentId);
    if (!room) return;
    for (const connection of room) {
      if (!roleFor(this.db, documentId, connection.userId)) connection.socket.close(CLOSE_NO_ACCESS, 'access removed');
    }
    this.send(room, { type: 'changed', what: 'access' });
  }

  private checkConnections(): void {
    for (const room of this.rooms.values()) {
      for (const connection of room) {
        if (!connection.alive) {
          connection.socket.terminate();
          continue;
        }
        connection.alive = false;
        connection.socket.ping();
        // Catches what no route announces, such as a session expiring.
        if (!userForToken(this.db, connection.token)) connection.socket.close(CLOSE_SIGNED_OUT, 'signed out');
        else if (!roleFor(this.db, connection.documentId, connection.userId)) connection.socket.close(CLOSE_NO_ACCESS, 'access removed');
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const room of this.rooms.values()) {
      for (const { socket } of room) socket.terminate();
    }
    this.rooms.clear();
    this.wss.close();
  }
}
