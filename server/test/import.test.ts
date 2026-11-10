import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { convertUpload } from '../importer.ts';
import { MAX_UPLOAD_BYTES } from '../../shared/limits.ts';
import { BLAKE, startHarness, type Harness } from './helpers.ts';

type J = { type: string; attrs?: Record<string, unknown>; text?: string; marks?: { type: string }[]; content?: J[] };
const nodes = (doc: unknown) => (doc as J).content!;
const textOf = (node: J): string => node.text ?? (node.content ?? []).map(textOf).join('');

/** Builds a minimal but real .docx around the given word/document.xml body. */
export async function makeDocx(body: string, extra: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  for (const [name, value] of Object.entries(extra)) zip.file(name, value);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('file conversion', () => {
  it('turns .txt blank lines into paragraphs and keeps single newlines as breaks', async () => {
    const { content, title } = await convertUpload('notes.txt', Buffer.from('one\r\ntwo\r\n\r\nthree'));
    assert.equal(title, 'notes');
    const paragraphs = nodes(content);
    assert.equal(paragraphs.length, 2);
    assert.deepEqual(paragraphs[0]!.content!.map((n) => n.type), ['text', 'hardBreak', 'text']);
    assert.equal(textOf(paragraphs[1]!), 'three');
  });

  it('decodes UTF-8 BOM and UTF-16 text', async () => {
    const bom = await convertUpload('a.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo')]));
    assert.equal(textOf(nodes(bom.content)[0]!), 'héllo');
    const utf16 = await convertUpload('b.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wörld', 'utf16le')]));
    assert.equal(textOf(nodes(utf16.content)[0]!), 'wörld');
  });

  it('maps markdown headings, marks and lists onto the schema', async () => {
    const md = '# Title\n\nSome **bold** and *italic*.\n\n- a\n- b\n\n1. x\n2. y\n\n##### Deep\n';
    const [heading, paragraph, bullets, ordered, deep] = nodes((await convertUpload('m.md', Buffer.from(md))).content);
    assert.deepEqual([heading!.type, heading!.attrs!.level], ['heading', 1]);
    assert.ok(paragraph!.content!.some((n) => n.marks?.[0]?.type === 'bold' && n.text === 'bold'));
    assert.ok(paragraph!.content!.some((n) => n.marks?.[0]?.type === 'italic'));
    assert.equal(bullets!.type, 'bulletList');
    assert.equal(ordered!.type, 'orderedList');
    assert.deepEqual([deep!.type, deep!.attrs!.level], ['heading', 3]);
  });

  it('drops raw HTML from markdown and reports images', async () => {
    const md = 'Safe text\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![pic](a.png)\n';
    const { content, notes } = await convertUpload('x.md', Buffer.from(md));
    const serialized = JSON.stringify(content);
    assert.ok(serialized.includes('Safe text'));
    assert.ok(!/alert|onerror|script/.test(serialized));
    assert.ok(notes.some((note) => note.includes('image')));
  });

  it('keeps heading, bold and underline from a .docx', async () => {
    const docx = await makeDocx(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report</w:t></w:r></w:p>
       <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>strong</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>under</w:t></w:r></w:p>`,
    );
    const { content, title } = await convertUpload('Q3 Report.DOCX', docx);
    assert.equal(title, 'Q3 Report');
    const [heading, paragraph] = nodes(content);
    assert.equal(heading!.type, 'heading');
    const marks = paragraph!.content!.map((n) => n.marks?.[0]?.type);
    assert.deepEqual(marks, ['bold', 'underline']);
  });

  it('keeps bulleted and numbered lists from .docx numbering definitions, and reports tables', async () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const level = (format: string) => `<w:lvl w:ilvl="0"><w:numFmt w:val="${format}"/><w:lvlText w:val="x"/></w:lvl>`;
    const item = (numId: number, text: string) =>
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const docx = await makeDocx(
      `${item(1, 'bullet one')}${item(1, 'bullet two')}<w:p><w:r><w:t>between</w:t></w:r></w:p>${item(2, 'number one')}
       <w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
      {
        'word/_rels/document.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
        'word/numbering.xml': `<?xml version="1.0"?><w:numbering ${W}>
          <w:abstractNum w:abstractNumId="0">${level('bullet')}</w:abstractNum>
          <w:abstractNum w:abstractNumId="1">${level('decimal')}</w:abstractNum>
          <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
          <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
        </w:numbering>`,
      },
    );
    const { content, notes } = await convertUpload('lists.docx', docx);
    const [bullets, between, ordered] = nodes(content);
    assert.equal(bullets!.type, 'bulletList');
    assert.equal(bullets!.content!.length, 2);
    assert.equal(textOf(between!), 'between');
    assert.equal(ordered!.type, 'orderedList');
    assert.ok(JSON.stringify(content).includes('cell'), 'table text is kept');
    assert.ok(notes.some((note) => note.includes('table')));
  });

  it('rejects a renamed non-docx, and a zip that is not a word document', async () => {
    await assert.rejects(convertUpload('fake.docx', Buffer.from('plain text')), { status: 422 });
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    await assert.rejects(convertUpload('z.docx', await zip.generateAsync({ type: 'nodebuffer' })), { status: 422 });
  });

  it('refuses a docx that expands far beyond its upload size', async () => {
    const docx = await makeDocx('<w:p><w:r><w:t>x</w:t></w:r></w:p>', { 'word/bomb.xml': 'a'.repeat(60 * 1024 * 1024) });
    assert.ok(docx.length < MAX_UPLOAD_BYTES);
    await assert.rejects(convertUpload('bomb.docx', docx), { status: 413 });
  });

  it('rejects binary content disguised as text, and empty files', async () => {
    await assert.rejects(convertUpload('a.txt', Buffer.from([1, 0, 2, 0])), { status: 422 });
    await assert.rejects(convertUpload('a.md', Buffer.from('  \n ')), { status: 422 });
  });
});

describe('POST /api/documents/import', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.close());

  it('creates an editable document owned by the uploader', async () => {
    const result = await h.blake.upload('Meeting.md', '# Agenda\n\nItem');
    assert.equal(result.status, 201);
    const id = result.body.document.id;
    assert.equal(result.body.document.title, 'Meeting');
    assert.equal(result.body.document.owner.email, BLAKE);
    const saved = await h.blake.request('PUT', `/api/documents/${id}/content`, {
      content: result.body.document.content,
      baseVersion: result.body.document.version,
    });
    assert.equal(saved.status, 200);
    assert.equal((await h.avery.request('GET', `/api/documents/${id}`)).status, 404);
  });

  it('keeps a non-ASCII filename intact', async () => {
    const result = await h.blake.upload('Résumé 日本語.txt', 'hello');
    assert.equal(result.body.document.title, 'Résumé 日本語');
  });

  it('rejects unsupported types, naming what is supported', async () => {
    for (const name of ['photo.png', 'report.pdf', 'noextension']) {
      const result = await h.blake.upload(name, 'data');
      assert.equal(result.status, 415, name);
      assert.match(result.body.error.message, /\.txt, \.md or \.docx/);
    }
  });

  it('rejects files over the limit with a 413', async () => {
    const result = await h.blake.upload('big.txt', 'x'.repeat(MAX_UPLOAD_BYTES + 1));
    assert.equal(result.status, 413);
    assert.match(result.body.error.message, /2 MB/);
  });

  it('accepts a file exactly at the limit', async () => {
    const result = await h.blake.upload('edge.txt', 'x'.repeat(MAX_UPLOAD_BYTES));
    assert.equal(result.status, 201);
  });

  it('explains a missing file', async () => {
    const result = await h.blake.request('POST', '/api/documents/import', new FormData());
    assert.equal(result.status, 400);
  });
});
