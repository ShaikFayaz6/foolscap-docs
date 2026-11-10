import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { convertUpload } from '../importer.ts';
import { normalizeContent } from '../content.ts';
import { toMarkdown, toPdf, type DocNode } from '../exporter.ts';
import { BLAKE, startHarness, type Harness } from './helpers.ts';

const text = (value: string, ...marks: string[]): DocNode => ({
  type: 'text',
  text: value,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
});
const p = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content });
const heading = (level: number, ...content: DocNode[]): DocNode => ({ type: 'heading', attrs: { level }, content });
const item = (...content: DocNode[]): DocNode => ({ type: 'listItem', content });
const bullets = (...content: DocNode[]): DocNode => ({ type: 'bulletList', content });
const numbers = (...content: DocNode[]): DocNode => ({ type: 'orderedList', attrs: { start: 1 }, content });
const docOf = (...content: DocNode[]): DocNode => ({ type: 'doc', content });

const canonical = (doc: DocNode) => JSON.parse(normalizeContent(doc).serialized);

async function roundTrip(doc: DocNode) {
  const markdown = toMarkdown(doc);
  const converted = await convertUpload('x.md', Buffer.from(markdown));
  return { markdown, result: JSON.parse(normalizeContent(converted.content).serialized) };
}

async function assertRoundTrips(doc: DocNode) {
  const { markdown, result } = await roundTrip(doc);
  assert.deepEqual(result, canonical(doc), `Markdown was:\n${markdown}`);
}

describe('Markdown export', () => {
  it('writes headings, lists and inline formatting as readable Markdown', () => {
    const markdown = toMarkdown(
      docOf(
        heading(1, text('Title')),
        p(text('plain '), text('bold', 'bold'), text(' '), text('slanted', 'italic'), text(' '), text('under', 'underline')),
        bullets(item(p(text('one'))), item(p(text('two')))),
        numbers(item(p(text('first')))),
      ),
    );
    assert.equal(markdown, '# Title\n\nplain **bold** *slanted* <u>under</u>\n\n- one\n- two\n\n1. first\n');
  });

  const cases: [string, DocNode][] = [
    ['every heading level', docOf(heading(1, text('a')), heading(2, text('b')), heading(3, text('c')))],
    ['combined marks', docOf(p(text('all', 'bold', 'italic', 'underline')))],
    ['overlapping marks', docOf(p(text('a', 'bold'), text('b', 'bold', 'italic'), text('c', 'italic')))],
    ['strike and code', docOf(p(text('gone', 'strike'), text(' and '), text('x = 1', 'code')))],
    ['marks against punctuation and inside words', docOf(p(text('a'), text('(b)', 'bold'), text('c')), p(text('un'), text('believ', 'italic'), text('able')), p(text('('), text('x', 'bold'), text(').')))],
    ['nested lists', docOf(bullets(item(p(text('a')), numbers(item(p(text('b')), bullets(item(p(text('c')))))))))],
    ['adjacent lists stay separate', docOf(bullets(item(p(text('a')))), bullets(item(p(text('b')))))],
    ['a numbered list with a custom start', docOf({ type: 'orderedList', attrs: { start: 7 }, content: [item(p(text('a'))), item(p(text('b')))] })],
    ['hard breaks, also inside marks', docOf(p(text('a', 'bold'), { type: 'hardBreak' }, text('b', 'bold')))],
    ['blockquotes', docOf({ type: 'blockquote', content: [p(text('a')), p(text('b'))] })],
    ['code blocks containing backticks', docOf({ type: 'codeBlock', attrs: { language: 'js' }, content: [text('a ``` b')] })],
    ['horizontal rules', docOf(p(text('a')), { type: 'horizontalRule' }, p(text('b')))],
    ['text that looks like Markdown', docOf(p(text('# not a heading')), p(text('- not a list')), p(text('1. not numbered')), p(text('*not em* _nor this_ `nor code` [no](link) <u>no</u> &amp; \\')))],
  ];
  for (const [name, doc] of cases) {
    it(`round-trips ${name}`, () => assertRoundTrips(doc));
  }

  it('moves spaces outside marks, because delimiters must touch their text', () => {
    assert.equal(toMarkdown(docOf(p(text('a'), text(' b ', 'bold'), text('c')))), 'a **b** c\n');
  });

  it('accepts only bare inline tags on import', async () => {
    const { content } = await convertUpload('x.md', Buffer.from('<strong onclick="x">a</strong> <em>b</em> <div>c</div>'));
    const nodes = (content.content?.[0]?.content ?? []) as DocNode[];
    assert.deepEqual(nodes.filter((node) => node.marks).map((node) => node.text), ['b']);
  });

  it('keeps pasted-looking HTML as text, and an empty document as an empty file', async () => {
    const { markdown } = await roundTrip(docOf(p(text('<script>alert(1)</script>'))));
    assert.ok(markdown.includes('\\<script\\>'));
    assert.equal(toMarkdown(docOf({ type: 'paragraph' })), '');
  });
});

describe('PDF export', () => {
  async function inspect(data: Buffer) {
    const loaded = await getDocument({ data: new Uint8Array(data), disableFontFace: true, verbosity: 0 }).promise;
    const pages = [];
    for (let number = 1; number <= loaded.numPages; number += 1) {
      const page = await loaded.getPage(number);
      const content = await page.getTextContent();
      const operators = await page.getOperatorList();
      pages.push({
        items: content.items.filter((entry) => 'str' in entry && entry.str.trim()) as { str: string; fontName: string; height: number; transform: number[] }[],
        // pdf.js folds a stroked path into a constructPath operation that names its paint.
        strokes: operators.fnArray.filter((fn, index) => fn === OPS.stroke || (fn === OPS.constructPath && operators.argsArray[index][0] === OPS.stroke)).length,
      });
    }
    return { pages, numPages: loaded.numPages, metadata: await loaded.getMetadata() };
  }
  const find = (items: { str: string }[], value: string) => {
    const match = items.find((entry) => entry.str.includes(value));
    assert.ok(match, `"${value}" is not in the PDF: ${items.map((entry) => entry.str).join(' | ')}`);
    return match as { str: string; fontName: string; height: number; transform: number[] };
  };

  it('renders headings larger, and marks with different fonts and lines', async () => {
    const data = await toPdf(
      docOf(
        heading(1, text('Big heading')),
        p(text('plain words')),
        p(text('heavy words', 'bold')),
        p(text('slanted words', 'italic')),
        p(text('lined words', 'underline')),
      ),
      'Report',
    );
    assert.equal(data.subarray(0, 5).toString(), '%PDF-');
    const { pages, metadata } = await inspect(data);
    const { items, strokes } = pages[0]!;
    assert.ok(find(items, 'Big heading').height > find(items, 'plain words').height * 1.5);
    const fonts = new Set(['plain words', 'heavy words', 'slanted words'].map((value) => find(items, value).fontName));
    assert.equal(fonts.size, 3);
    assert.equal(strokes, 1, 'the underlined run draws one line');
    assert.equal((metadata.info as { Title: string }).Title, 'Report');
  });

  it('draws list markers and indents nested items', async () => {
    const { pages } = await inspect(
      await toPdf(docOf(numbers(item(p(text('outer')), bullets(item(p(text('inner'))))), item(p(text('second'))))), 'L'),
    );
    const { items } = pages[0]!;
    assert.ok(find(items, '1.'));
    assert.ok(find(items, '2.'));
    assert.ok(find(items, '◦'), 'a nested list uses the second bullet style');
    assert.ok(find(items, 'inner').transform[4]! > find(items, 'outer').transform[4]!);
  });

  it('flows long documents onto more pages', async () => {
    const long = docOf(...Array.from({ length: 120 }, (_, index) => p(text(`Paragraph number ${index}`))));
    const { numPages, pages } = await inspect(await toPdf(long, 'Long'));
    assert.ok(numPages >= 3);
    assert.ok(find(pages.at(-1)!.items, 'Paragraph number 119'));
  });

  it('copes with an empty document and very deep lists', async () => {
    assert.equal((await inspect(await toPdf(docOf({ type: 'paragraph' }), 'Empty'))).numPages, 1);
    let nested = bullets(item(p(text('deepest'))));
    for (let depth = 0; depth < 30; depth += 1) nested = bullets(item(p(text('level')), nested));
    assert.ok(find((await inspect(await toPdf(docOf(nested), 'Deep'))).pages[0]!.items, 'deepest'));
  });
});

describe('export route', () => {
  let h: Harness;
  let id: string;
  const save = (content: DocNode) => h.avery.request('PUT', `/api/documents/${id}/content`, { content, baseVersion: 1 });

  before(async () => {
    h = await startHarness();
    id = (await h.avery.createDocument('Q3 / "final" report é')).body.document.id;
    await save(docOf(heading(1, text('Results')), p(text('Up', 'bold'))));
  });
  after(() => h.close());

  it('sends Markdown as a download with a safe filename', async () => {
    const result = await h.avery.download(`/api/documents/${id}/export?format=markdown`);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type')!, /text\/markdown/);
    const disposition = result.headers.get('content-disposition')!;
    assert.match(disposition, /^attachment; filename="Q3/);
    assert.ok(disposition.includes("filename*=UTF-8''Q3%20final%20report%20%C3%A9.md"), disposition);
    assert.equal(result.data.toString(), '# Results\n\n**Up**\n');
  });

  it('sends a PDF that a viewer can download', async () => {
    await h.avery.share(id, BLAKE, 'viewer');
    const result = await h.blake.download(`/api/documents/${id}/export?format=pdf`);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'application/pdf');
    assert.equal(result.data.subarray(0, 5).toString(), '%PDF-');
  });

  it('rejects an unknown format with the standard error shape', async () => {
    const result = await h.avery.request('GET', `/api/documents/${id}/export?format=exe`);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_request');
  });
});
