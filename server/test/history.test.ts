import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BLAKE, CASEY, doc, startHarness, type Client, type Harness } from './helpers.ts';

describe('version history', () => {
  let h: Harness;
  let id: string;

  const get = async (client: Client = h.avery) => (await client.request('GET', `/api/documents/${id}`)).body.document;
  const save = async (client: Client, text: string) =>
    client.request('PUT', `/api/documents/${id}/content`, { content: doc(text), baseVersion: (await get(client)).version });
  const list = async (client: Client = h.avery) => (await client.request('GET', `/api/documents/${id}/versions`)).body.versions;
  const textOf = (content: { content: { content: { text: string }[] }[] }) => content.content[0]!.content[0]!.text;
  const ageSnapshots = () =>
    h.db.prepare("UPDATE document_versions SET saved_at = '2020-01-01T00:00:00.000Z' WHERE document_id = ?").run(id);

  before(async () => {
    h = await startHarness();
  });
  beforeEach(async () => {
    id = (await h.avery.createDocument('Tracked')).body.document.id;
  });
  after(() => h.close());

  it('checkpoints rather than recording every autosave', async () => {
    await save(h.avery, 'one');
    await save(h.avery, 'two');
    await save(h.avery, 'three');
    const versions = await list();
    assert.equal(versions.length, 1, 'empty start is skipped; only the first real text is checkpointed');
    const { content } = (await h.avery.request('GET', `/api/documents/${id}/versions/${versions[0].id}`)).body;
    assert.equal(textOf(content), 'one');
  });

  it('checkpoints again once the interval has passed', async () => {
    await save(h.avery, 'one');
    await save(h.avery, 'two');
    ageSnapshots();
    await save(h.avery, 'three');
    assert.equal((await list()).length, 2);
  });

  it('always keeps the previous author\'s text when someone else edits', async () => {
    await h.avery.share(id, BLAKE, 'editor');
    await save(h.avery, 'avery text');
    await save(h.blake, 'blake text');
    await save(h.avery, 'avery again');
    const versions = await list();
    assert.deepEqual(versions.map((v: { savedBy: string }) => v.savedBy), ['Blake Okafor', 'Avery Lindqvist']);
  });

  it('restores an earlier version, and the restore can itself be undone', async () => {
    await save(h.avery, 'original');
    ageSnapshots();
    await save(h.avery, 'second');
    await save(h.avery, 'latest');
    const original = (await list()).at(-1);

    const current = await get();
    const restored = await h.avery.request('POST', `/api/documents/${id}/versions/${original.id}/restore`, { baseVersion: current.version });
    assert.equal(restored.status, 200);
    assert.equal(textOf(restored.body.document.content), 'original');
    assert.equal(restored.body.document.version, current.version + 1);

    const replaced = (await list())[0];
    const undo = await h.avery.request('POST', `/api/documents/${id}/versions/${replaced.id}/restore`, { baseVersion: current.version + 1 });
    assert.equal(textOf(undo.body.document.content), 'latest');
  });

  it('keeps named versions when automatic checkpoints are pruned', async () => {
    await save(h.avery, 'worth keeping');
    const named = await h.avery.request('POST', `/api/documents/${id}/versions`, { name: 'Sent to legal' });
    assert.equal(named.status, 201);
    for (let index = 0; index < 34; index += 1) {
      ageSnapshots();
      await save(h.avery, `edit ${index}`);
    }
    const versions = await list();
    assert.equal(versions.filter((v: { name: string | null }) => v.name === null).length, 30);
    const kept = versions.find((v: { name: string | null }) => v.name === 'Sent to legal');
    const { content } = (await h.avery.request('GET', `/api/documents/${id}/versions/${kept.id}`)).body;
    assert.equal(textOf(content), 'worth keeping');
  });

  it('validates version names', async () => {
    assert.equal((await h.avery.request('POST', `/api/documents/${id}/versions`, { name: '   ' })).status, 400);
    assert.equal((await h.avery.request('POST', `/api/documents/${id}/versions`, { name: 'x'.repeat(101) })).status, 400);
  });

  it('refuses a restore based on a stale version, changing nothing', async () => {
    await save(h.avery, 'one');
    await save(h.avery, 'two');
    const [version] = await list();
    const { version: currentVersion } = await get();
    const result = await h.avery.request('POST', `/api/documents/${id}/versions/${version.id}/restore`, { baseVersion: currentVersion - 1 });
    assert.equal(result.status, 409);
    assert.equal(textOf((await get()).content), 'two');
  });

  it('allows owners and editors only', async () => {
    await save(h.avery, 'one');
    await save(h.avery, 'two');
    const [version] = await list();
    const { version: baseVersion } = await get();
    const paths: [string, string, unknown?][] = [
      ['GET', `/api/documents/${id}/versions`],
      ['GET', `/api/documents/${id}/versions/${version.id}`],
      ['POST', `/api/documents/${id}/versions/${version.id}/restore`, { baseVersion }],
    ];
    await h.avery.share(id, BLAKE, 'viewer');
    for (const [method, path, body] of paths) {
      assert.equal((await h.blake.request(method, path, body)).status, 403, `viewer ${method} ${path}`);
      assert.equal((await h.casey.request(method, path, body)).status, 404, `stranger ${method} ${path}`);
      assert.equal((await h.anonymous.request(method, path, body)).status, 401, `anonymous ${method} ${path}`);
    }
    assert.equal((await get()).version, baseVersion);
    await h.avery.request('GET', `/api/documents/${id}/shares`);
    assert.ok(CASEY);
  });

  it('cannot read or restore another document\'s version through a document you can edit', async () => {
    await save(h.avery, 'secret one');
    await save(h.avery, 'secret two');
    const [secret] = await list();

    const blakesDoc = (await h.blake.createDocument('Mine')).body.document;
    const read = await h.blake.request('GET', `/api/documents/${blakesDoc.id}/versions/${secret.id}`);
    assert.equal(read.status, 404);
    const restore = await h.blake.request('POST', `/api/documents/${blakesDoc.id}/versions/${secret.id}/restore`, { baseVersion: blakesDoc.version });
    assert.equal(restore.status, 404);
  });

  it('deletes history along with the document, and answers 404 for a malformed id', async () => {
    await save(h.avery, 'one');
    await save(h.avery, 'two');
    assert.equal((await h.avery.request('GET', `/api/documents/${id}/versions/not-a-number`)).status, 404);
    await h.avery.request('DELETE', `/api/documents/${id}`);
    const { n } = h.db.prepare('SELECT COUNT(*) n FROM document_versions WHERE document_id = ?').get(id) as { n: number };
    assert.equal(n, 0);
  });
});
