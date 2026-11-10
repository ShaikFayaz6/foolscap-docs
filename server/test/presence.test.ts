import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { LiveMessage, LivePeer } from '../../shared/api.ts';
import { CLOSE_NO_ACCESS, CLOSE_SIGNED_OUT } from '../presence.ts';
import { BLAKE, CASEY, doc, startHarness, type Client, type Harness } from './helpers.ts';

/** A WebSocket client that can wait for the message or close it expects. */
class Live {
  readonly socket: WebSocket;
  readonly messages: LiveMessage[] = [];
  closeCode: number | undefined;
  private waiters: (() => void)[] = [];

  constructor(url: string, headers: Record<string, string>) {
    this.socket = new WebSocket(url, { headers });
    this.socket.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()));
      this.wake();
    });
    this.socket.on('close', (code) => {
      this.closeCode = code;
      this.wake();
    });
    this.socket.on('error', () => {});
  }

  private wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async until<T>(check: () => T | undefined | false, label: string, timeoutMs = 2000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      const left = deadline - Date.now();
      if (left <= 0) assert.fail(`Timed out waiting for ${label}. Got ${JSON.stringify(this.messages.slice(-3))}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  open() {
    return new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      this.socket.once('error', reject);
    });
  }

  latestPeers(): LivePeer[] | undefined {
    return this.messages.findLast((message) => message.type === 'presence')?.peers;
  }

  peers(label: string, test: (peers: LivePeer[]) => boolean) {
    return this.until(() => {
      const peers = this.latestPeers();
      return peers && test(peers) && peers;
    }, label);
  }

  sawChange(what: string) {
    return this.until(() => this.messages.some((message) => message.type === 'changed' && message.what === what), `a ${what} change`);
  }

  closed() {
    return this.until(() => this.closeCode, 'the socket to close');
  }

  select(selection: { from: number; to: number } | null) {
    this.socket.send(JSON.stringify({ type: 'selection', selection }));
  }
}

describe('live presence', () => {
  let h: Harness;
  let id: string;
  let open: Live[];

  const connectAs = (client: Client, documentId = id, origin = client.base) => {
    const live = new Live(`${client.base.replace('http', 'ws')}/api/documents/${documentId}/live`, {
      ...(client.cookie ? { cookie: client.cookie } : {}),
      ...(origin ? { origin } : {}),
    });
    open.push(live);
    return live;
  };
  const join = async (client: Client, documentId?: string) => {
    const live = connectAs(client, documentId);
    await live.open();
    return live;
  };

  before(async () => {
    h = await startHarness();
  });
  beforeEach(async () => {
    open = [];
    id = (await h.avery.createDocument('Live')).body.document.id;
  });
  afterEach(() => {
    for (const live of open) live.socket.terminate();
  });
  after(() => h.close());

  it('refuses connections without a session, the right origin, or access', async () => {
    await assert.rejects(connectAs(h.anonymous).open(), /HTTP 401/);
    await assert.rejects(connectAs(h.avery, id, 'https://evil.example').open(), /HTTP 403/);
    await assert.rejects(connectAs(h.avery, id, '').open(), /HTTP 403/);
    await assert.rejects(connectAs(h.casey).open(), /HTTP 404/);
    await assert.rejects(connectAs(h.avery, 'does-not-exist').open(), /HTTP 404/);
  });

  it('shows who else is here, with their selection, and removes them on leaving', async () => {
    await h.avery.share(id, BLAKE, 'viewer');
    const avery = await join(h.avery);
    await avery.peers('Avery alone', (peers) => peers.length === 1);
    const blake = await join(h.blake);
    const both = await avery.peers('both people', (peers) => peers.length === 2);
    assert.deepEqual(both.map((peer) => peer.name).sort(), ['Avery Lindqvist', 'Blake Okafor']);
    assert.ok(!JSON.stringify(both).includes('@'), 'email addresses are not sent to other people');

    blake.select({ from: 3, to: 9 });
    await avery.peers('the selection', (peers) => peers.some((peer) => peer.selection?.from === 3 && peer.selection.to === 9));

    blake.socket.close();
    await avery.peers('Blake leaving', (peers) => peers.length === 1 && peers[0]!.name === 'Avery Lindqvist');
  });

  it('keeps documents separate', async () => {
    const other = (await h.avery.createDocument('Other')).body.document.id;
    const here = await join(h.avery);
    await here.peers('one here', (peers) => peers.length === 1);
    const elsewhere = await join(h.avery, other);
    await elsewhere.peers('one there', (peers) => peers.length === 1);
    elsewhere.select({ from: 1, to: 1 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(here.latestPeers()!.length, 1);
    assert.equal(here.latestPeers()![0]!.selection, null);
  });

  it('announces saves and comments as they happen', async () => {
    const live = await join(h.avery);
    await h.avery.request('PUT', `/api/documents/${id}/content`, { content: doc('x'), baseVersion: 1 });
    await live.sawChange('document');
    await h.avery.request('POST', `/api/documents/${id}/comments`, { body: 'hi', anchor: { from: 1, to: 2, quote: 'x', prefix: '', suffix: '' } });
    await live.sawChange('comments');
  });

  it('does not announce a save that was rejected', async () => {
    const live = await join(h.avery);
    await h.avery.request('PUT', `/api/documents/${id}/content`, { content: doc('x'), baseVersion: 99 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!live.messages.some((message) => message.type === 'changed'));
  });

  it('disconnects someone the moment their access is revoked, and leaves others connected', async () => {
    await h.avery.share(id, BLAKE, 'editor');
    await h.avery.share(id, CASEY, 'viewer');
    const blake = await join(h.blake);
    const casey = await join(h.casey);
    const { userId } = (await h.avery.request('GET', `/api/documents/${id}/shares`)).body.shares.find((share: { email: string }) => share.email === BLAKE);
    await h.avery.request('DELETE', `/api/documents/${id}/shares/${userId}`);
    assert.equal(await blake.closed(), CLOSE_NO_ACCESS);
    await casey.sawChange('access');
    assert.equal(casey.socket.readyState, WebSocket.OPEN);
  });

  it('tells a person when their role changes, without disconnecting them', async () => {
    await h.avery.share(id, BLAKE, 'editor');
    const blake = await join(h.blake);
    await h.avery.share(id, BLAKE, 'viewer');
    await blake.sawChange('access');
    assert.equal(blake.socket.readyState, WebSocket.OPEN);
  });

  it('disconnects everyone when the document is deleted', async () => {
    const avery = await join(h.avery);
    await h.avery.request('DELETE', `/api/documents/${id}`);
    assert.equal(await avery.closed(), CLOSE_NO_ACCESS);
  });

  it('ignores malformed messages', async () => {
    const live = await join(h.avery);
    await live.peers('joined', (peers) => peers.length === 1);
    live.socket.send('not json');
    live.socket.send(JSON.stringify({ type: 'selection', selection: { from: -1, to: 'x' } }));
    live.socket.send(JSON.stringify({ type: 'admin' }));
    live.select({ from: 2, to: 2 });
    await live.peers('the valid message', (peers) => peers[0]!.selection?.from === 2);
    assert.equal(live.socket.readyState, WebSocket.OPEN);
  });

  it('closes a connection that sends oversized messages or floods', async () => {
    const big = await join(h.avery);
    big.socket.send('x'.repeat(2048));
    assert.equal(await big.closed(), 1009);

    const flood = await join(h.avery);
    for (let index = 0; index < 200; index += 1) flood.select({ from: index, to: index });
    assert.equal(await flood.closed(), 1008);
  });

  it('limits how many connections one person can hold on a document', async () => {
    for (let index = 0; index < 6; index += 1) await join(h.avery);
    await assert.rejects(connectAs(h.avery).open(), /HTTP 429/);
  });
});

describe('live presence heartbeat', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ heartbeatMs: 40 });
  });
  after(() => h.close());

  const connect = async (client: Client, id: string) => {
    const live = new Live(`${client.base.replace('http', 'ws')}/api/documents/${id}/live`, { cookie: client.cookie, origin: client.base });
    await live.open();
    return live;
  };

  it('notices access removed directly in the database', async () => {
    const { id } = (await h.avery.createDocument('A')).body.document;
    await h.avery.share(id, BLAKE, 'viewer');
    const blake = await connect(h.blake, id);
    h.db.prepare('DELETE FROM document_shares WHERE document_id = ?').run(id);
    assert.equal(await blake.closed(), CLOSE_NO_ACCESS);
  });

  it('closes the connection when the session ends', async () => {
    const { id } = (await h.casey.createDocument('C')).body.document;
    const casey = await connect(h.casey, id);
    await h.casey.request('POST', '/api/auth/logout');
    assert.equal(await casey.closed(), CLOSE_SIGNED_OUT);
  });

  it('drops a client that stops answering pings, and tells the others', async () => {
    const { id } = (await h.avery.createDocument('B')).body.document;
    const silent = await connect(h.avery, id);
    (silent.socket as unknown as { pong(): void }).pong = () => {};
    // Stop reading pings at the transport level, as a dead network would.
    (silent.socket as unknown as { _socket: { pause(): void } })._socket.pause();
    await h.avery.share(id, BLAKE, 'viewer');
    const blake = await connect(h.blake, id);
    await blake.peers('the silent client to go', (peers) => peers.length === 1 && peers[0]!.name.startsWith('Blake'));
    silent.socket.terminate();
  });
});
