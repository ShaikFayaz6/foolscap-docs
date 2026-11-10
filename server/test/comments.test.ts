import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createAnchor, resolveAnchor } from '../../shared/anchors.ts';
import { schema } from '../content.ts';
import { BLAKE, CASEY, startHarness, type Harness } from './helpers.ts';

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const node = (...texts: string[]) => ProseMirrorNode.fromJSON(schema, { type: 'doc', content: texts.map(paragraph) });
const textAt = (doc: ProseMirrorNode, place: { from: number; to: number }) => doc.textBetween(place.from, place.to, '\n');

describe('comment anchors', () => {
  it('round-trips a selection', () => {
    const doc = node('The quick brown fox');
    const anchor = createAnchor(doc, 5, 10)!;
    assert.equal(anchor.quote, 'quick');
    assert.deepEqual(resolveAnchor(doc, anchor), { from: 5, to: 10 });
  });

  it('follows its text when content is added before it', () => {
    const anchor = createAnchor(node('The quick brown fox'), 5, 10)!;
    const edited = node('New opening paragraph', 'Well, the quick brown fox');
    assert.equal(textAt(edited, resolveAnchor(edited, anchor)!), 'quick');
  });

  it('picks the right occurrence of repeated text using its context', () => {
    const doc = node('red apple', 'green apple', 'blue apple');
    const anchor = createAnchor(doc, 18, 23)!;
    assert.equal(anchor.quote, 'apple');
    const edited = node('intro', 'red apple', 'green apple', 'blue apple');
    const place = resolveAnchor(edited, anchor)!;
    assert.equal(edited.textBetween(place.from - 6, place.to, '\n'), 'green apple');
  });

  it('spans paragraphs', () => {
    const doc = node('first line', 'second line');
    const anchor = createAnchor(doc, 7, 19)!;
    assert.equal(anchor.quote, 'line\nsecond');
    assert.deepEqual(resolveAnchor(doc, anchor), { from: 7, to: 19 });
  });

  it('reports detached when the text is gone, and refuses empty selections', () => {
    const anchor = createAnchor(node('keep this'), 1, 5)!;
    assert.equal(resolveAnchor(node('entirely different'), anchor), null);
    assert.equal(createAnchor(node('x'), 1, 1), null);
  });
});

describe('comments API', () => {
  let h: Harness;
  let id: string;
  const anchor = { from: 1, to: 4, quote: 'abc', prefix: '', suffix: 'def' };
  const post = (client: Harness['avery'], body = 'A thought') =>
    client.request('POST', `/api/documents/${id}/comments`, { body, anchor });

  before(async () => {
    h = await startHarness();
  });
  beforeEach(async () => {
    id = (await h.avery.createDocument('Discussed')).body.document.id;
  });
  after(() => h.close());

  it('lets a commenter comment and reply without changing the document', async () => {
    await h.avery.share(id, BLAKE, 'commenter');
    const created = await post(h.blake);
    assert.equal(created.status, 201);
    const [thread] = created.body.comments;
    assert.equal(thread.author.name, 'Blake Okafor');
    assert.deepEqual(thread.anchor, anchor);

    const replied = await h.avery.request('POST', `/api/documents/${id}/comments/${thread.id}/replies`, { body: 'Agreed' });
    assert.equal(replied.body.comments[0].replies[0].body, 'Agreed');
    assert.equal((await h.avery.request('GET', `/api/documents/${id}`)).body.document.version, 1);
  });

  it('lets a viewer read but not write', async () => {
    const [thread] = (await post(h.avery)).body.comments;
    await h.avery.share(id, BLAKE, 'viewer');
    assert.equal((await h.blake.request('GET', `/api/documents/${id}/comments`)).body.comments.length, 1);
    assert.equal((await post(h.blake)).status, 403);
    assert.equal((await h.blake.request('POST', `/api/documents/${id}/comments/${thread.id}/replies`, { body: 'x' })).status, 403);
    assert.equal((await h.blake.request('PATCH', `/api/documents/${id}/comments/${thread.id}`, { resolved: true })).status, 403);
  });

  it('limits resolving: a commenter only their own, an editor anyone\'s', async () => {
    const [byOwner] = (await post(h.avery)).body.comments;
    await h.avery.share(id, BLAKE, 'commenter');
    const url = (commentId: number) => `/api/documents/${id}/comments/${commentId}`;
    assert.equal((await h.blake.request('PATCH', url(byOwner.id), { resolved: true })).status, 403);

    const mine = (await post(h.blake)).body.comments.at(-1);
    assert.equal((await h.blake.request('PATCH', url(mine.id), { resolved: true })).status, 200);

    await h.avery.share(id, BLAKE, 'editor');
    const resolved = await h.blake.request('PATCH', url(byOwner.id), { resolved: true });
    assert.equal(resolved.body.comments[0].resolved, true);
    const reopened = await h.blake.request('PATCH', url(byOwner.id), { resolved: false });
    assert.equal(reopened.body.comments[0].resolved, false);
  });

  it('limits deleting to the author and the owner', async () => {
    const [byOwner] = (await post(h.avery)).body.comments;
    await h.avery.share(id, BLAKE, 'editor');
    await h.avery.share(id, CASEY, 'commenter');
    assert.equal((await h.blake.request('DELETE', `/api/documents/${id}/comments/${byOwner.id}`)).status, 403);
    const byCasey = (await post(h.casey)).body.comments.at(-1);
    assert.equal((await h.avery.request('DELETE', `/api/documents/${id}/comments/${byCasey.id}`)).status, 200);
    assert.equal((await h.avery.request('DELETE', `/api/documents/${id}/comments/${byOwner.id}`)).body.comments.length, 0);
  });

  it('cannot reach another document\'s comment through a document you can edit', async () => {
    const [secret] = (await post(h.avery)).body.comments;
    const blakesDoc = (await h.blake.createDocument('Mine')).body.document.id;
    assert.equal((await h.blake.request('POST', `/api/documents/${blakesDoc}/comments/${secret.id}/replies`, { body: 'x' })).status, 404);
    assert.equal((await h.blake.request('PATCH', `/api/documents/${blakesDoc}/comments/${secret.id}`, { resolved: true })).status, 404);
    assert.equal((await h.blake.request('DELETE', `/api/documents/${blakesDoc}/comments/${secret.id}`)).status, 404);
  });

  it('validates input', async () => {
    const call = (body: unknown) => h.avery.request('POST', `/api/documents/${id}/comments`, body);
    assert.equal((await call({ body: '   ', anchor })).status, 400);
    assert.equal((await call({ body: 'x'.repeat(5001), anchor })).status, 400);
    assert.equal((await call({ body: 'x', anchor: { ...anchor, quote: '' } })).status, 400);
    assert.equal((await call({ body: 'x', anchor: { ...anchor, from: -1 } })).status, 400);
    assert.equal((await call({ body: 'x' })).status, 400);
    assert.equal((await h.avery.request('PATCH', `/api/documents/${id}/comments/nope`, { resolved: true })).status, 404);
  });

  it('keeps markup in comments as plain text and deletes threads with the document', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    assert.equal((await post(h.avery, payload)).body.comments[0].body, payload);
    await h.avery.request('DELETE', `/api/documents/${id}`);
    const { n } = h.db.prepare('SELECT COUNT(*) n FROM comments WHERE document_id = ?').get(id) as { n: number };
    assert.equal(n, 0);
  });
});
