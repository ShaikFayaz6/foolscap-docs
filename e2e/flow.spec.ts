import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { expect, test, type Browser, type Page } from '@playwright/test';

const PORT = 4179;
const CSRF = { 'x-requested-with': 'foolscap' };
const dataDir = mkdtempSync(join(tmpdir(), 'foolscap-e2e-'));
let server: ChildProcess | undefined;

async function startServer(): Promise<void> {
  server = spawn(process.execPath, ['server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: join(dataDir, 'e2e.db') },
    stdio: 'inherit',
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const up = await fetch(`http://localhost:${PORT}/api/auth/me`).catch(() => null);
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function killServer(): Promise<void> {
  const exited = new Promise((resolve) => server?.once('exit', resolve));
  // A hard kill, so this also proves saved work does not depend on a clean shutdown.
  server?.kill('SIGKILL');
  await exited;
}

test.beforeAll(startServer);
test.afterAll(async () => {
  await killServer();
  rmSync(dataDir, { recursive: true, force: true });
});

async function signIn(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'Your pile' })).toBeVisible();
  return page;
}

const editorOf = (page: Page) => page.getByRole('textbox', { name: 'Document text' });
const expectSaved = (page: Page) => expect(page.getByTestId('save-state')).toHaveText(/^Saved/);

test('create, format, share, import, conflict and restart', async ({ browser }) => {
  const avery = await signIn(browser, 'Avery');
  const blake = await signIn(browser, 'Blake');
  const casey = await signIn(browser, 'Casey');

  await test.step('owned and shared documents look different', async () => {
    await expect(avery.locator('.doc-row', { hasText: 'Welcome to Foolscap' }).getByText('Yours')).toBeVisible();
    await expect(blake.locator('.doc-row', { hasText: 'Welcome to Foolscap' }).getByText('From Avery')).toBeVisible();
    await expect(casey.getByText('A clean desk')).toBeVisible();
  });

  await avery.getByRole('button', { name: 'New document' }).click();
  await expect(avery).toHaveURL(/\/d\//);
  const url = avery.url();

  await test.step('rename and write with formatting', async () => {
    await avery.getByLabel('Document title').fill('Launch notes');
    await avery.getByLabel('Document title').press('Enter');

    await editorOf(avery).click();
    await avery.getByRole('button', { name: 'Heading 1' }).click();
    await avery.keyboard.type('Launch plan');
    await avery.keyboard.press('Enter');
    await avery.getByRole('button', { name: 'Underline' }).click();
    await avery.keyboard.type('underlined');
    await avery.getByRole('button', { name: 'Underline' }).click();
    await avery.keyboard.type(' then ');
    await avery.getByRole('button', { name: 'Bold' }).click();
    await avery.keyboard.type('bold');
    await avery.getByRole('button', { name: 'Bold' }).click();
    await avery.getByRole('button', { name: 'Italic' }).click();
    await avery.keyboard.type(' italic');
    await avery.getByRole('button', { name: 'Italic' }).click();
    await avery.keyboard.press('Enter');
    await avery.getByRole('button', { name: 'Bulleted list' }).click();
    await avery.keyboard.type('first bullet');
    await avery.keyboard.press('Enter');
    await avery.keyboard.press('Enter');
    await avery.getByRole('button', { name: 'Numbered list' }).click();
    await avery.keyboard.type('first number');
    await expectSaved(avery);
  });

  const expectFormatting = async (page: Page) => {
    await expect(page.getByLabel('Document title')).toHaveValue('Launch notes');
    const body = editorOf(page);
    await expect(body.locator('h1')).toHaveText('Launch plan');
    await expect(body.locator('u')).toHaveText('underlined');
    await expect(body.locator('strong')).toHaveText('bold');
    await expect(body.locator('em')).toHaveText(' italic');
    await expect(body.locator('ul li')).toHaveText('first bullet');
    await expect(body.locator('ol li')).toHaveText('first number');
  };

  await test.step('reopening keeps the title and formatting', async () => {
    await avery.reload();
    await expectFormatting(avery);
  });

  const documentId = url.split('/d/')[1]!;

  await test.step('other users cannot reach an unshared document', async () => {
    await casey.goto(url);
    await expect(casey.getByRole('heading', { name: "This page isn't in your pile" })).toBeVisible();
    expect((await casey.request.get(`/api/documents/${documentId}`)).status()).toBe(404);
  });

  await test.step('a viewer can read but the UI and the server block edits', async () => {
    await avery.getByRole('button', { name: 'Share' }).click();
    await avery.getByLabel("Person's email").fill('blake@foolscap.test');
    await avery.locator('.share-form select').selectOption('viewer');
    await avery.locator('.share-form').getByRole('button', { name: 'Share' }).click();
    await expect(avery.locator('.share-list').getByText('Blake Okafor')).toBeVisible();
    await avery.getByRole('button', { name: 'Done' }).click();

    await blake.reload();
    await expect(blake.locator('.doc-row', { hasText: 'Launch notes' }).getByText('you can view')).toBeVisible();
    await blake.getByRole('link', { name: /Launch notes/ }).click();
    await expectFormatting(blake);
    await expect(editorOf(blake)).toHaveAttribute('contenteditable', 'false');
    await expect(blake.getByRole('toolbar', { name: 'Formatting' })).toHaveCount(0);
    await expect(blake.getByRole('button', { name: /^Share/ })).toHaveCount(0);

    // Regression: merely clicking must not change a document that ends in a list.
    const versionBefore = (await (await blake.request.get(`/api/documents/${documentId}`)).json()).document.version;
    await editorOf(blake).click();
    await blake.getByLabel('Document title').click();
    await editorOf(blake).click();
    await blake.waitForTimeout(1500);
    await expect(blake.getByRole('alert')).toHaveCount(0);
    expect((await (await blake.request.get(`/api/documents/${documentId}`)).json()).document.version).toBe(versionBefore);

    const attempt = await blake.request.put(`/api/documents/${documentId}/content`, {
      headers: CSRF, data: { content: { type: 'doc', content: [{ type: 'paragraph' }] }, baseVersion: 1 },
    });
    expect(attempt.status()).toBe(403);
  });

  await test.step('an upgraded editor can write, and the owner sees it', async () => {
    await avery.getByRole('button', { name: /^Share/ }).click();
    const roleSaved = avery.waitForResponse((r) => r.url().endsWith('/shares') && r.request().method() === 'PUT');
    await avery.getByLabel('Access for Blake Okafor').selectOption('editor');
    await roleSaved;
    await avery.getByRole('button', { name: 'Done' }).click();

    await blake.reload();
    await editorOf(blake).click();
    await blake.keyboard.press('Control+End');
    await blake.keyboard.type(' from Blake');
    await expectSaved(blake);
    await expect(editorOf(avery).locator('ol li')).toHaveText('first number from Blake', { timeout: 15_000 });
    await expect(avery.getByText(/Blake updated this page/)).toBeVisible();
  });

  await test.step('a stale save shows a conflict and can be resolved', async () => {
    // Avery types first: an idle page would simply take the other save live, with no conflict.
    await editorOf(avery).click();
    await avery.keyboard.press('Control+End');
    await avery.keyboard.type(' mine');

    const current = await (await blake.request.get(`/api/documents/${documentId}`)).json();
    const saved = await blake.request.put(`/api/documents/${documentId}/content`, {
      headers: CSRF, data: { content: current.document.content, baseVersion: current.document.version },
    });
    expect(saved.status()).toBe(200);
    await expect(avery.getByText('Someone saved a newer version')).toBeVisible();
    await avery.getByRole('button', { name: 'Replace with mine' }).click();
    await expectSaved(avery);
    await expect(avery.getByText('Someone saved a newer version')).toHaveCount(0);
  });

  await test.step('history restores an earlier version, and the restore can be undone', async () => {
    const restoreTop = async () => {
      await avery.getByRole('button', { name: 'History' }).click();
      await expect(avery.getByRole('textbox', { name: 'Version preview' })).toBeVisible();
      await avery.getByRole('button', { name: 'Restore this version' }).click();
      await expect(avery.getByRole('heading', { name: 'Earlier versions' })).toHaveCount(0);
    };
    await restoreTop();
    await expect(editorOf(avery).locator('ol li')).toHaveText('first number from Blake');
    await expect(avery.getByText('Earlier version restored')).toBeVisible();
    await restoreTop();
    await expect(editorOf(avery).locator('ol li')).toHaveText('first number from Blake mine');
    await avery.reload();
    await expect(editorOf(avery).locator('ol li')).toHaveText('first number from Blake mine');
  });

  await test.step('imports .md and .docx, and rejects other types', async () => {
    // The shared header is on the editor page too.
    await expect(avery.locator('.masthead').getByText(/Avery/)).toBeVisible();
    await avery.getByRole('button', { name: /^Account: Avery/ }).click();
    await expect(avery.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await avery.keyboard.press('Escape');
    await expect(avery.getByRole('button', { name: 'Sign out' })).toBeHidden();
    await avery.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(avery.getByText('.txt, .md or .docx, up to 2 MB', { exact: false }).first()).toBeVisible();
    const input = avery.getByTestId('import-input');

    await input.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('x') });
    await expect(avery.getByRole('alert')).toContainText('.txt, .md or .docx');

    await input.setInputFiles({
      name: 'Imported notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# From markdown\n\n- **strong** item\n\n![p](x.png)\n'),
    });
    await expect(avery).toHaveURL(/\/d\//);
    await expect(avery.getByLabel('Document title')).toHaveValue('Imported notes');
    await expect(editorOf(avery).locator('h1')).toHaveText('From markdown');
    await expect(editorOf(avery).locator('li strong')).toHaveText('strong');
    await expect(avery.getByText('1 image was left out')).toBeVisible();

    await editorOf(avery).click();
    await avery.keyboard.press('Control+End');
    await avery.keyboard.type(' edited');
    await expectSaved(avery);

    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      '_rels/.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Word bold</w:t></w:r></w:p></w:body></w:document>',
    );
    await avery.getByRole('link', { name: 'Home', exact: true }).click();
    await avery.getByTestId('import-input').setInputFiles({
      name: 'Brief.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: await zip.generateAsync({ type: 'nodebuffer' }),
    });
    await expect(avery.getByLabel('Document title')).toHaveValue('Brief');
    await expect(editorOf(avery).locator('strong')).toHaveText('Word bold');
  });

  await test.step('everything survives a hard server restart', async () => {
    await killServer();
    await startServer();

    await avery.goto(url);
    await expect(editorOf(avery).locator('h1')).toHaveText('Launch plan');
    await expect(editorOf(avery).locator('u')).toHaveText('underlined');
    await expect(editorOf(avery).locator('ol li')).toHaveText('first number from Blake mine');

    await blake.goto('/');
    await expect(blake.locator('.doc-row', { hasText: 'Launch notes' }).getByText('you can edit')).toBeVisible();
    await casey.goto(url);
    await expect(casey.getByRole('heading', { name: "This page isn't in your pile" })).toBeVisible();
  });
});

test('comments: anchored threads, replies and resolve across two users and roles', async ({ browser }) => {
  const owner = await signIn(browser, 'Avery');
  const commenter = await signIn(browser, 'Blake');

  await owner.getByRole('button', { name: 'New document' }).click();
  await expect(owner).toHaveURL(/\/d\//);
  const url = owner.url();
  const documentId = url.split('/d/')[1]!;
  await editorOf(owner).click();
  await owner.keyboard.type('Quarterly results improved sharply');
  await expectSaved(owner);

  const share = async (role: string) => {
    const response = await owner.request.put(`/api/documents/${documentId}/shares`, { headers: CSRF, data: { email: 'blake@foolscap.test', role } });
    expect(response.status()).toBe(200);
  };
  await share('commenter');

  await commenter.goto(url);
  await expect(editorOf(commenter)).toHaveAttribute('contenteditable', 'false');
  await expect(commenter.getByRole('button', { name: 'Bold' })).toHaveCount(0);
  const commentTool = commenter.getByRole('button', { name: 'Comment on selected text' });
  await expect(commentTool).toBeDisabled();

  await editorOf(commenter).getByText('Quarterly results improved sharply').dblclick({ position: { x: 90, y: 10 } });
  await expect(commentTool).toBeEnabled();
  await commentTool.click();
  await commenter.getByRole('textbox', { name: 'Add a comment' }).fill('Is this audited?');
  await commenter.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(editorOf(commenter).locator('.comment-mark')).toHaveText('results');
  await expect(commenter.getByText('Is this audited?')).toBeVisible();

  await owner.reload();
  await expect(editorOf(owner).locator('.comment-mark')).toHaveText('results');
  await editorOf(owner).locator('.comment-mark').click();
  await expect(owner.getByText('Is this audited?')).toBeVisible();
  await owner.getByRole('textbox', { name: 'Reply' }).fill('Yes, last week');
  await owner.getByRole('button', { name: 'Reply', exact: true }).click();

  await commenter.reload();
  await commenter.getByRole('button', { name: /^Comments/ }).click();
  await expect(commenter.getByText('Yes, last week')).toBeVisible();

  await test.step('the anchor survives editing before it, and saves never conflict with comments', async () => {
    await editorOf(owner).press('Control+Home');
    await owner.keyboard.type('Update: ');
    await expectSaved(owner);
    await owner.reload();
    await expect(editorOf(owner).locator('.comment-mark')).toHaveText('results');
  });

  await test.step('a viewer can read comments but gets no way to write', async () => {
    await share('viewer');
    await commenter.reload();
    await commenter.getByRole('button', { name: /^Comments/ }).click();
    await expect(commenter.getByText('Is this audited?')).toBeVisible();
    await expect(commenter.getByRole('textbox', { name: 'Reply' })).toHaveCount(0);
    await expect(commenter.getByRole('toolbar')).toHaveCount(0);
  });

  await test.step('resolving removes the highlight and hides the thread', async () => {
    await owner.getByRole('button', { name: /^Comments/ }).click();
    await owner.getByRole('button', { name: 'Resolve' }).click();
    await expect(editorOf(owner).locator('.comment-mark')).toHaveCount(0);
    await expect(owner.getByText('Is this audited?')).toHaveCount(0);
    await owner.getByRole('button', { name: /Show resolved/ }).click();
    await expect(owner.getByText('Is this audited?')).toBeVisible();
  });
});

test('exports what is on screen, including edits not yet autosaved', async ({ browser }) => {
  const page = await signIn(browser, 'Avery');
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page).toHaveURL(/\/d\//);
  await page.getByRole('textbox', { name: 'Document title' }).fill('Export me');
  await expect(page).toHaveTitle('Export me · Foolscap');
  await editorOf(page).click();
  await page.getByRole('button', { name: 'Heading 1' }).click();
  await page.keyboard.type('Plan');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.type('Ship it');

  const exportAs = async (label: string) => {
    await page.getByText('Export', { exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: label }).click()]);
    return download;
  };

  const markdown = await exportAs('Markdown (.md)');
  expect(markdown.suggestedFilename()).toBe('Export me.md');
  expect(readFileSync(await markdown.path(), 'utf8')).toBe('# Plan\n\n**Ship it**\n');

  const pdf = await exportAs('PDF (.pdf)');
  expect(pdf.suggestedFilename()).toBe('Export me.pdf');
  expect(readFileSync(await pdf.path()).subarray(0, 5).toString()).toBe('%PDF-');
});

test('presence: shows who is here, live updates, and recovers after the server restarts', async ({ browser }) => {
  const avery = await signIn(browser, 'Avery');
  const blake = await signIn(browser, 'Blake');
  await avery.getByRole('button', { name: 'New document' }).click();
  await expect(avery).toHaveURL(/\/d\//);
  const url = avery.url();
  const id = url.split('/d/')[1]!;
  await editorOf(avery).click();
  await avery.keyboard.type('Shared words');
  await expectSaved(avery);
  await avery.request.put(`/api/documents/${id}/shares`, { headers: CSRF, data: { email: 'blake@foolscap.test', role: 'editor' } });

  const blakeIsHere = avery.getByRole('status', { name: /Also here: Blake/ });
  await expect(blakeIsHere).toHaveCount(0);
  await blake.goto(url);
  await expect(blakeIsHere).toBeVisible();
  await expect(blake.getByRole('status', { name: /Also here: Avery/ })).toBeVisible();

  await test.step('a remote cursor appears where the other person is', async () => {
    await editorOf(blake).click();
    await blake.keyboard.press('Control+End');
    await expect(editorOf(avery).locator('.remote-caret')).toHaveAttribute('data-name', 'Blake');
    await avery.getByRole('textbox', { name: 'Document title' }).click();
    await expect(editorOf(blake).locator('.remote-caret')).toHaveCount(0);
  });

  await test.step('a save appears for the other person well before the poll', async () => {
    await blake.keyboard.type(' from Blake');
    await expectSaved(blake);
    await expect(editorOf(avery)).toContainText('Shared words from Blake', { timeout: 4000 });
  });

  await test.step('a role change reaches the open page at once', async () => {
    await avery.request.put(`/api/documents/${id}/shares`, { headers: CSRF, data: { email: 'blake@foolscap.test', role: 'viewer' } });
    await expect(editorOf(blake)).toHaveAttribute('contenteditable', 'false', { timeout: 4000 });
  });

  await test.step('leaving removes the person', async () => {
    await blake.goto('/');
    await expect(blakeIsHere).toHaveCount(0);
    await blake.goto(url);
    await expect(blakeIsHere).toBeVisible();
  });

  await test.step('losing the server shows Reconnecting, and presence returns with it', async () => {
    await killServer();
    await expect(avery.getByText('Reconnecting…')).toBeVisible();
    await startServer();
    await expect(blakeIsHere).toBeVisible({ timeout: 40_000 });
    await expect(avery.getByText('Reconnecting…')).toHaveCount(0);
  });
});

test('pasted and stored markup stays inert', async ({ browser }) => {
  const page = await signIn(browser, 'Blake');
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page).toHaveURL(/\/d\//);
  const documentId = page.url().split('/d/')[1]!;

  await editorOf(page).click();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData(
      'text/html',
      '<p onclick="window.__xss=1">safe <b>bold</b></p><img src=x onerror="window.__xss=2"><script>window.__xss=3</script><iframe src="javascript:window.__xss=4"></iframe>',
    );
    document.querySelector('.prose')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editorOf(page).locator('strong')).toHaveText('bold');
  await expectSaved(page);
  await expect(editorOf(page).locator('img, iframe, script, [onclick]')).toHaveCount(0);

  const saved = (await (await page.request.get(`/api/documents/${documentId}`)).json()).document;
  expect(JSON.stringify(saved.content)).not.toMatch(/onerror|onclick|iframe|__xss/);

  const payload = '<img src=x onerror="window.__xss=5">';
  const put = await page.request.put(`/api/documents/${documentId}/content`, {
    headers: CSRF, data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: payload }] }] }, baseVersion: saved.version },
  });
  expect(put.status()).toBe(200);
  await page.reload();
  await expect(editorOf(page)).toHaveText(payload);
  await expect(editorOf(page).locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('shows a retrying state offline and saves when the server returns', async ({ browser }) => {
  const page = await signIn(browser, 'Casey');
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page).toHaveURL(/\/d\//);
  await editorOf(page).click();
  await page.keyboard.type('before');
  await expectSaved(page);

  await killServer();
  await page.keyboard.type(' during outage');
  await expect(page.getByTestId('save-state')).toHaveText('Save failed, retrying…');
  await expect(page.getByText("Can't reach the server")).toBeVisible();

  await startServer();
  await expectSaved(page).catch(() => expect(page.getByTestId('save-state')).toHaveText(/^Saved/, { timeout: 35_000 }));
  await page.reload();
  await expect(editorOf(page)).toHaveText('before during outage');
});
