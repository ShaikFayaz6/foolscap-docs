import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../app.ts';
import { openDatabase, type Db } from '../db.ts';
import { DEMO_PASSWORD } from '../../shared/demo.ts';

export const AVERY = 'avery@foolscap.test';
export const BLAKE = 'blake@foolscap.test';
export const CASEY = 'casey@foolscap.test';

export const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** A signed-in HTTP client talking to a real listening server. */
export class Client {
  cookie = '';
  readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  async request(method: string, path: string, body?: unknown) {
    const isForm = body instanceof FormData;
    const response = await fetch(this.base + path, {
      method,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      },
      body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }

  async login(email: string, password = DEMO_PASSWORD) {
    const result = await this.request('POST', '/api/auth/login', { email, password });
    this.cookie = result.headers.get('set-cookie')?.split(';')[0] ?? '';
    return result;
  }

  upload(filename: string, data: Uint8Array | string) {
    const form = new FormData();
    form.append('file', new Blob([data as BlobPart]), filename);
    return this.request('POST', '/api/documents/import', form);
  }

  createDocument(title = 'Plan') {
    return this.request('POST', '/api/documents', { title });
  }

  share(id: string, email: string, role: string) {
    return this.request('PUT', `/api/documents/${id}/shares`, { email, role });
  }
}

export interface Harness {
  db: Db;
  server: Server;
  base: string;
  avery: Client;
  blake: Client;
  casey: Client;
  anonymous: Client;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const db = openDatabase(':memory:', { seedWelcomeDoc: false });
  const server = await new Promise<Server>((resolve) => {
    const listening = createApp(db).listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const [avery, blake, casey] = [new Client(base), new Client(base), new Client(base)] as const;
  await Promise.all([avery.login(AVERY), blake.login(BLAKE), casey.login(CASEY)]);
  return {
    db,
    server,
    base,
    avery,
    blake,
    casey,
    anonymous: new Client(base),
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
