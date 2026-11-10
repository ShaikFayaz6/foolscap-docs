import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AVERY, BLAKE, CASEY, Client, doc, startHarness, type Harness } from './helpers.ts';

describe('authentication', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.close());

  it('rejects a wrong password with no session cookie', async () => {
    const result = await h.anonymous.request('POST', '/api/auth/login', { email: AVERY, password: 'nope' });
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('set-cookie'), null);
  });

  it('marks the session cookie httpOnly', async () => {
    const result = await new Client(h.base).login(BLAKE);
    assert.match(result.headers.get('set-cookie') ?? '', /HttpOnly/i);
  });

  it('refuses every document route without a session', async () => {
    const calls: [string, string][] = [
      ['GET', '/api/documents'],
      ['POST', '/api/documents'],
      ['POST', '/api/documents/import'],
      ['GET', '/api/documents/some-id'],
      ['PUT', '/api/documents/some-id/content'],
      ['GET', '/api/documents/some-id/shares'],
    ];
    for (const [method, path] of calls) {
      const result = await h.anonymous.request(method, path);
      assert.equal(result.status, 401, `${method} ${path}`);
    }
  });

  it('invalidates the session on logout', async () => {
    const client = new Client(h.base);
    await client.login(CASEY);
    assert.equal((await client.request('GET', '/api/auth/me')).status, 200);
    const cookie = client.cookie;
    await client.request('POST', '/api/auth/logout');
    client.cookie = cookie;
    assert.equal((await client.request('GET', '/api/auth/me')).status, 401);
  });
});

describe('document access control', () => {
  let h: Harness;
  let id: string;
  const saveAs = (client: Client, baseVersion: number, text = 'changed') =>
    client.request('PUT', `/api/documents/${id}/content`, { content: doc(text), baseVersion });
  const currentVersion = async () => (await h.avery.request('GET', `/api/documents/${id}`)).body.document.version as number;

  before(async () => {
    h = await startHarness();
    id = (await h.avery.createDocument('Private plan')).body.document.id;
  });
  after(() => h.close());

  it('hides an unshared document from other users on every route, as 404', async () => {
    const calls: [string, string, unknown?][] = [
      ['GET', `/api/documents/${id}`],
      ['PATCH', `/api/documents/${id}`, { title: 'hacked' }],
      ['PUT', `/api/documents/${id}/content`, { content: doc('hacked'), baseVersion: 1 }],
      ['DELETE', `/api/documents/${id}`],
      ['GET', `/api/documents/${id}/shares`],
      ['PUT', `/api/documents/${id}/shares`, { email: CASEY, role: 'editor' }],
    ];
    for (const [method, path, body] of calls) {
      const result = await h.casey.request(method, path, body);
      assert.equal(result.status, 404, `${method} ${path}`);
    }
    assert.deepEqual((await h.casey.request('GET', '/api/documents')).body.documents, []);
    assert.equal((await h.avery.request('GET', `/api/documents/${id}`)).body.document.title, 'Private plan');
  });

  it('lets a viewer read but not write', async () => {
    await h.avery.share(id, BLAKE, 'viewer');
    const read = await h.blake.request('GET', `/api/documents/${id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.document.role, 'viewer');

    assert.equal((await saveAs(h.blake, read.body.document.version)).status, 403);
    assert.equal((await h.blake.request('PATCH', `/api/documents/${id}`, { title: 'x' })).status, 403);
    const unchanged = (await h.avery.request('GET', `/api/documents/${id}`)).body.document;
    assert.equal(unchanged.content.content[0].content, undefined, 'content must be unchanged');
    assert.equal(unchanged.title, 'Private plan');
  });

  it('lets an editor write but not manage sharing or delete', async () => {
    await h.avery.share(id, BLAKE, 'editor');
    assert.equal((await saveAs(h.blake, await currentVersion(), 'from blake')).status, 200);
    assert.equal((await h.blake.request('PATCH', `/api/documents/${id}`, { title: 'Renamed' })).status, 200);

    assert.equal((await h.blake.request('GET', `/api/documents/${id}/shares`)).status, 403);
    assert.equal((await h.blake.share(id, CASEY, 'viewer')).status, 403);
    assert.equal((await h.blake.request('DELETE', `/api/documents/${id}`)).status, 403);
    assert.equal((await h.casey.request('GET', `/api/documents/${id}`)).status, 404);
  });

  it('distinguishes owned and shared documents in the list', async () => {
    const [mine] = (await h.avery.request('GET', '/api/documents')).body.documents;
    const [theirs] = (await h.blake.request('GET', '/api/documents')).body.documents;
    assert.equal(mine.role, 'owner');
    assert.equal(theirs.role, 'editor');
    assert.equal(theirs.owner.email, AVERY);
  });

  it('removes access immediately when a share is revoked', async () => {
    const { shares } = (await h.avery.request('GET', `/api/documents/${id}/shares`)).body;
    const removed = await h.avery.request('DELETE', `/api/documents/${id}/shares/${shares[0].userId}`);
    assert.deepEqual(removed.body.shares, []);
    assert.equal((await h.blake.request('GET', `/api/documents/${id}`)).status, 404);
    assert.equal((await saveAs(h.blake, await currentVersion())).status, 404);
  });

  it('gives useful errors for bad share requests', async () => {
    assert.equal((await h.avery.share(id, 'nobody@foolscap.test', 'viewer')).status, 404);
    assert.equal((await h.avery.share(id, AVERY, 'viewer')).status, 400);
    assert.equal((await h.avery.share(id, BLAKE, 'owner')).status, 400);
  });

  it('rejects a stale save instead of overwriting newer work', async () => {
    const version = await currentVersion();
    assert.equal((await saveAs(h.avery, version, 'first')).status, 200);
    const stale = await saveAs(h.avery, version, 'second');
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.currentVersion, version + 1);
    const { content } = (await h.avery.request('GET', `/api/documents/${id}`)).body.document;
    assert.equal(content.content[0].content[0].text, 'first');
  });

  it('rejects content outside the document schema', async () => {
    const version = await currentVersion();
    const invalid: unknown[] = [
      { type: 'doc', content: [{ type: 'iframe', attrs: { src: 'https://evil.test' } }] },
      { type: 'doc', content: [{ type: 'text', text: 'text directly in doc' }] },
      { type: 'paragraph' },
      'not an object',
    ];
    for (const content of invalid) {
      const result = await h.avery.request('PUT', `/api/documents/${id}/content`, { content, baseVersion: version });
      assert.equal(result.status, 422, JSON.stringify(content));
    }
    assert.equal(await currentVersion(), version);
  });

  it('checks attribute values and drops unknown attributes', async () => {
    const version = await currentVersion();
    const bad: unknown[] = [
      { type: 'doc', content: [{ type: 'heading', attrs: { level: 99 }, content: [{ type: 'text', text: 'x' }] }] },
      { type: 'doc', content: [{ type: 'codeBlock', attrs: { language: '"><script>' } }] },
      { type: 'doc', content: [{ type: 'orderedList', attrs: { start: 'x' }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] },
    ];
    for (const content of bad) {
      const result = await h.avery.request('PUT', `/api/documents/${id}/content`, { content, baseVersion: version });
      assert.equal(result.status, 422, JSON.stringify(content));
    }
    const sneaky = { type: 'doc', content: [{ type: 'paragraph', attrs: { onclick: 'alert(1)' }, content: [{ type: 'text', text: 'ok' }] }] };
    assert.equal((await h.avery.request('PUT', `/api/documents/${id}/content`, { content: sneaky, baseVersion: version })).status, 200);
    const stored = (await h.avery.request('GET', `/api/documents/${id}`)).body.document.content;
    assert.ok(!JSON.stringify(stored).includes('onclick'));
  });

  it('cascades sharing when the owner deletes a document', async () => {
    const created = (await h.avery.createDocument('Doomed')).body.document.id;
    await h.avery.share(created, BLAKE, 'editor');
    assert.equal((await h.avery.request('DELETE', `/api/documents/${created}`)).status, 204);
    assert.equal((await h.blake.request('GET', `/api/documents/${created}`)).status, 404);
    const { n } = h.db.prepare('SELECT COUNT(*) n FROM document_shares WHERE document_id = ?').get(created) as { n: number };
    assert.equal(n, 0);
  });
});
