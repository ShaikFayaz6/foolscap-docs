import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db.ts';
import { AVERY, BLAKE, doc, startHarness, type Harness } from './helpers.ts';

const CSRF = { 'x-requested-with': 'foolscap' };
const JSON_TYPE = { 'content-type': 'application/json' };

describe('cross-site request protection', () => {
  let h: Harness;
  let id: string;
  before(async () => {
    h = await startHarness();
    id = (await h.avery.createDocument('Target')).body.document.id;
  });
  after(() => h.close());

  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    fetch(h.base + path, {
      method,
      headers: { cookie: h.avery.cookie, ...JSON_TYPE, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  for (const [method, path, body] of [
    ['POST', '/api/documents', {}],
    ['PATCH', '/api/documents/ID', { title: 'Hacked' }],
    ['PUT', '/api/documents/ID/shares', { email: BLAKE, role: 'editor' }],
    ['DELETE', '/api/documents/ID', undefined],
    ['POST', '/api/auth/logout', undefined],
  ] as const) {
    it(`blocks ${method} ${path} without the app's header`, async () => {
      const response = await call(method, path.replace('ID', id), {}, body);
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'csrf_rejected');
    });
  }

  it('blocks a request from another origin even with the header', async () => {
    const response = await call('PATCH', `/api/documents/${id}`, { ...CSRF, origin: 'https://evil.example' }, { title: 'Hacked' });
    assert.equal(response.status, 403);
    assert.equal((await h.avery.request('GET', `/api/documents/${id}`)).body.document.title, 'Target');
  });

  it('allows a same-origin request, and reads without the header', async () => {
    const response = await call('PATCH', `/api/documents/${id}`, { ...CSRF, origin: h.base }, { title: 'Renamed' });
    assert.equal(response.status, 200);
    assert.equal((await call('GET', `/api/documents/${id}`, {})).status, 200);
  });
});

describe('rate limits', () => {
  it('locks out repeated failed logins with the standard error shape', async () => {
    const h = await startHarness({ app: { rateLimits: { login: { limit: 3, windowMs: 60_000 } } } });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.equal((await h.anonymous.request('POST', '/api/auth/login', { email: AVERY, password: 'wrong-password' })).status, 401);
      }
      const blocked = await h.anonymous.request('POST', '/api/auth/login', { email: AVERY, password: 'wrong-password' });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error.code, 'rate_limited');
    } finally {
      await h.close();
    }
  });

  it('does not count successful logins', async () => {
    const h = await startHarness({ app: { rateLimits: { login: { limit: 2, windowMs: 60_000 } } } });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await h.avery.login(AVERY)).status, 200);
    } finally {
      await h.close();
    }
  });

  it('limits uploads per person, not across everyone', async () => {
    const h = await startHarness({ app: { rateLimits: { upload: { limit: 1, windowMs: 60_000 } } } });
    try {
      assert.equal((await h.avery.upload('a.txt', 'hello')).status, 201);
      const blocked = await h.avery.upload('b.txt', 'hello');
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error.code, 'rate_limited');
      assert.equal((await h.blake.upload('c.txt', 'hello')).status, 201);
    } finally {
      await h.close();
    }
  });

  it('limits exports per person', async () => {
    const h = await startHarness({ app: { rateLimits: { export: { limit: 1, windowMs: 60_000 } } } });
    try {
      const { id } = (await h.avery.createDocument('E')).body.document;
      assert.equal((await h.avery.download(`/api/documents/${id}/export?format=pdf`)).status, 200);
      assert.equal((await h.avery.download(`/api/documents/${id}/export?format=pdf`)).status, 429);
    } finally {
      await h.close();
    }
  });
});

describe('operations', () => {
  let h: Harness;
  const lines: string[] = [];
  before(async () => {
    h = await startHarness({ app: { logger: pino({ level: 'info' }, { write: (line: string) => void lines.push(line) }) } });
  });
  after(() => h.close());

  it('reports health, and 503 when the database is gone', async () => {
    const healthy = await h.anonymous.request('GET', '/api/health');
    assert.equal(healthy.status, 200);
    assert.equal(healthy.body.database, 'up');

    const broken = await startHarness();
    broken.db.close();
    const down = await broken.anonymous.request('GET', '/api/health');
    assert.equal(down.status, 503);
    assert.equal(down.body.ok, false);
    broken.db.close = () => {};
    await broken.close();
  });

  it('sends security headers', async () => {
    const { headers } = await h.anonymous.request('GET', '/api/health');
    assert.match(headers.get('content-security-policy')!, /default-src 'self'/);
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-powered-by'), null);
    assert.equal(headers.get('strict-transport-security'), null, 'HSTS would break plain http on localhost');
    assert.ok(headers.get('x-request-id'));
  });

  it('logs requests as structured data, without content or credentials', async () => {
    const secretText = 'the-confidential-sentence';
    const { id } = (await h.avery.createDocument('Logged')).body.document;
    await h.avery.request('PUT', `/api/documents/${id}/content`, { content: doc(secretText), baseVersion: 1 });
    await h.avery.login(AVERY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entry = lines.map((line) => JSON.parse(line)).find((item) => item.path === `/api/documents/${id}/content`);
    assert.equal(entry.method, 'PUT');
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.ms, 'number');
    assert.ok(entry.userId);
    const all = lines.join('\n');
    assert.ok(!all.includes(secretText));
    assert.ok(!all.includes(h.avery.cookie.split('=')[1]!));
    assert.ok(!all.includes('foolscap-demo'));
  });

  it('answers unknown API routes in the standard error shape', async () => {
    const result = await h.avery.request('GET', '/api/nope');
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'not_found');
  });

  it('rejects oversized credentials before hashing them', async () => {
    const result = await h.anonymous.request('POST', '/api/auth/login', { email: AVERY, password: 'x'.repeat(5000) });
    assert.equal(result.status, 400);
  });
});

describe('secure deployment settings', () => {
  const login = (h: Harness) =>
    fetch(`${h.base}/api/auth/login`, {
      method: 'POST',
      headers: { ...CSRF, ...JSON_TYPE, 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ email: AVERY, password: 'foolscap-demo' }),
    });

  it('sends HSTS in production and marks cookies Secure behind a trusted proxy', async () => {
    const h = await startHarness({ app: { isProduction: true, trustProxy: 1 } });
    try {
      const response = await login(h);
      assert.match(response.headers.get('strict-transport-security')!, /max-age=/);
      const cookie = response.headers.get('set-cookie')!;
      assert.match(cookie, /Secure/);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
    } finally {
      await h.close();
    }
  });

  it('ignores forwarded headers when no proxy is trusted', async () => {
    const h = await startHarness();
    try {
      assert.doesNotMatch((await login(h)).headers.get('set-cookie')!, /Secure/);
    } finally {
      await h.close();
    }
  });
});

describe('configuration', () => {
  it('uses safe defaults', () => {
    const config = loadConfig({});
    assert.equal(config.port, 3000);
    assert.equal(config.trustProxy, 0);
    assert.equal(config.isProduction, false);
  });

  it('refuses invalid values, naming the setting', () => {
    assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
    assert.throws(() => loadConfig({ DEMO_PASSWORD: 'short' }), /DEMO_PASSWORD/);
    assert.throws(() => loadConfig({ SEED_DEMO_ACCOUNTS: 'maybe' }), /SEED_DEMO_ACCOUNTS/);
  });

  it('can start with no demo accounts', () => {
    const none = openDatabase(':memory:', { seedDemoAccounts: false });
    assert.deepEqual({ ...(none.prepare('SELECT COUNT(*) n FROM users').get() as object) }, { n: 0 });
    none.close();
  });

  it('exposes demo sign-in details only when demo accounts are on', async () => {
    const on = await startHarness({ app: { demo: { password: 'configured-pass', accounts: [{ email: AVERY, name: 'Avery' }] } } });
    const off = await startHarness({ app: { demo: null } });
    try {
      const enabled = await on.anonymous.request('GET', '/api/config');
      assert.equal(enabled.body.demo.password, 'configured-pass');
      assert.ok(!JSON.stringify(enabled.body).includes('password_hash'));
      assert.equal((await off.anonymous.request('GET', '/api/config')).body.demo, null);
    } finally {
      await on.close();
      await off.close();
    }
  });
});
