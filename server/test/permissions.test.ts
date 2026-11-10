import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasRole, type Role } from '../../shared/limits.ts';
import { MIGRATIONS, openDatabase } from '../db.ts';
import { BLAKE, Client, doc, startHarness, type Harness } from './helpers.ts';

interface Fixture {
  id: string;
  version: number;
  versionId: number;
  commentId?: number;
}
type Call = (client: Client, f: Fixture) => Promise<{ status: number }>;

/** Every document route, with the lowest role allowed to call it. */
const ROUTES: [string, Role, Call][] = [
  ['read document', 'viewer', (c, f) => c.request('GET', `/api/documents/${f.id}`)],
  ['save content', 'editor', (c, f) => c.request('PUT', `/api/documents/${f.id}/content`, { content: doc('new'), baseVersion: f.version })],
  ['rename', 'editor', (c, f) => c.request('PATCH', `/api/documents/${f.id}`, { title: 'New' })],
  ['delete document', 'owner', (c, f) => c.request('DELETE', `/api/documents/${f.id}`)],
  ['list shares', 'owner', (c, f) => c.request('GET', `/api/documents/${f.id}/shares`)],
  ['grant share', 'owner', (c, f) => c.request('PUT', `/api/documents/${f.id}/shares`, { email: 'casey@foolscap.test', role: 'viewer' })],
  ['list versions', 'editor', (c, f) => c.request('GET', `/api/documents/${f.id}/versions`)],
  ['name a version', 'editor', (c, f) => c.request('POST', `/api/documents/${f.id}/versions`, { name: 'Draft' })],
  ['read version', 'editor', (c, f) => c.request('GET', `/api/documents/${f.id}/versions/${f.versionId}`)],
  ['restore version', 'editor', (c, f) => c.request('POST', `/api/documents/${f.id}/versions/${f.versionId}/restore`, { baseVersion: f.version })],
];

describe('permissions per role', () => {
  let h: Harness;

  before(async () => {
    h = await startHarness();
  });
  after(() => h.close());

  async function fixture(role: Role | 'stranger' | 'anonymous'): Promise<Fixture> {
    const { id } = (await h.avery.createDocument('Matrix')).body.document;
    let version = 1;
    for (const text of ['one', 'two']) {
      version = (await h.avery.request('PUT', `/api/documents/${id}/content`, { content: doc(text), baseVersion: version })).body.version;
    }
    const versionId = (await h.avery.request('GET', `/api/documents/${id}/versions`)).body.versions[0].id;
    if (role === 'viewer' || role === 'commenter' || role === 'editor') await h.avery.share(id, BLAKE, role);
    return { id, version, versionId };
  }

  for (const [name, minimum, call] of ROUTES) {
    for (const role of ['owner', 'editor', 'commenter', 'viewer'] as const) {
      const allowed = hasRole(role, minimum);
      it(`${role} ${allowed ? 'can' : 'cannot'} ${name}`, async () => {
        const f = await fixture(role);
        const result = await call(role === 'owner' ? h.avery : h.blake, f);
        if (allowed) assert.ok(result.status >= 200 && result.status < 300, `got ${result.status}`);
        else assert.equal(result.status, 403);
      });
    }
    it(`a stranger gets 404 for ${name}`, async () => {
      assert.equal((await call(h.casey, await fixture('stranger'))).status, 404);
    });
    it(`an anonymous caller gets 401 for ${name}`, async () => {
      assert.equal((await call(h.anonymous, await fixture('anonymous'))).status, 401);
    });
  }

  it('lets the owner change and revoke a commenter', async () => {
    const f = await fixture('commenter');
    assert.equal((await h.blake.request('GET', `/api/documents/${f.id}`)).body.document.role, 'commenter');
    await h.avery.share(f.id, BLAKE, 'viewer');
    assert.equal((await h.blake.request('GET', `/api/documents/${f.id}`)).body.document.role, 'viewer');
    const { userId } = (await h.avery.request('GET', `/api/documents/${f.id}/shares`)).body.shares[0];
    await h.avery.request('DELETE', `/api/documents/${f.id}/shares/${userId}`);
    assert.equal((await h.blake.request('GET', `/api/documents/${f.id}`)).status, 404);
  });
});

describe('database migrations', () => {
  it('upgrades a first-version database and keeps its data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foolscap-migrate-'));
    const path = join(dir, 'old.db');
    try {
      const old = new DatabaseSync(path);
      old.exec(`${MIGRATIONS[0]} PRAGMA user_version = 1;`);
      old.exec(`
        INSERT INTO users VALUES ('u1', 'a@x.test', 'A', 'x:y'), ('u2', 'b@x.test', 'B', 'x:y');
        INSERT INTO documents VALUES ('d1', 'u1', 'Old', '{"type":"doc","content":[{"type":"paragraph"}]}', 3, 'now', 'now', 'u1');
        INSERT INTO document_shares VALUES ('d1', 'u2', 'editor', 'now');
      `);
      old.close();

      const upgraded = openDatabase(path);
      assert.deepEqual({ ...(upgraded.prepare('PRAGMA user_version').get() as object) }, { user_version: MIGRATIONS.length });
      assert.equal((upgraded.prepare('SELECT role FROM document_shares').get() as { role: string }).role, 'editor');
      upgraded.prepare("UPDATE document_shares SET role = 'commenter'").run();
      assert.equal((upgraded.prepare('SELECT version FROM documents').get() as { version: number }).version, 3);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
