import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.ts';

describe('persistence', () => {
  it('keeps data across close and reopen, and seeds only once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foolscap-'));
    const path = join(dir, 'test.db');
    try {
      const first = openDatabase(path);
      const before = first.prepare('SELECT id, title FROM documents').all();
      first.close();
      assert.equal(before.length, 1);

      const second = openDatabase(path);
      assert.deepEqual(second.prepare('SELECT id, title FROM documents').all(), before);
      const { n } = second.prepare('SELECT COUNT(*) n FROM users').get() as { n: number };
      assert.equal(n, 3);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
