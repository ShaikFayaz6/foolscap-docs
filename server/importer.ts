import { extname } from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { Marked } from 'marked';
import { generateJSON } from '@tiptap/html/server';
import { documentExtensions, type DocJson } from '../shared/schema.ts';
import { IMPORT_RULES_TEXT, MAX_TITLE_LENGTH } from '../shared/limits.ts';
import { ApiError } from './errors.ts';

const MAX_DOCX_EXPANDED_BYTES = 50 * 1024 * 1024;

export interface Converted {
  title: string;
  content: DocJson;
  notes: string[];
}

function unreadable(message: string): ApiError {
  return new ApiError(422, 'unreadable_file', message);
}

export function titleFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const title = base.slice(0, base.length - extname(base).length).trim();
  return title.slice(0, MAX_TITLE_LENGTH) || 'Untitled';
}

function decodeText(buffer: Buffer): string {
  let text: string;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(buffer);
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(buffer);
  } else {
    if (buffer.includes(0)) throw unreadable('This file looks binary, not text. Check that it really is a text file.');
    text = new TextDecoder('utf-8').decode(buffer);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Control characters (other than tab and newlines) are never meaningful in a document.
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function requireContent(text: string): void {
  if (!text.trim()) throw unreadable('This file is empty, so there is nothing to import.');
}

/** A blank line starts a new paragraph; a single newline stays a line break. */
function textToDoc(text: string): DocJson {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .filter((block) => block.trim());
  return {
    type: 'doc',
    content: paragraphs.map((block) => ({
      type: 'paragraph',
      content: block
        .split('\n')
        .flatMap((line, index) => [
          ...(index > 0 ? [{ type: 'hardBreak' }] : []),
          ...(line ? [{ type: 'text', text: line }] : []),
        ]),
    })),
  };
}

function htmlToDoc(html: string): DocJson {
  // The document schema only has three heading levels; keep deeper headings as headings.
  return generateJSON(html.replace(/<(\/?)h[456]\b/g, '<$1h3'), documentExtensions) as DocJson;
}

function droppedNotes(images: number, tables: number): string[] {
  const notes: string[] = [];
  if (images) notes.push(`${images} image${images > 1 ? 's were' : ' was'} left out: Foolscap documents are text only.`);
  if (tables) notes.push(`${tables} table${tables > 1 ? 's were' : ' was'} flattened into plain paragraphs.`);
  return notes;
}

async function markdownToDoc(text: string): Promise<{ content: DocJson; notes: string[] }> {
  let images = 0;
  let tables = 0;
  const marked = new Marked({
    gfm: true,
    // Raw HTML in markdown never reaches the HTML parser. The exception is bare
    // inline-format tags with no attributes, which Foolscap's own export can write.
    renderer: { html: ({ text }) => (/^<\/?(?:u|s|em|strong)>$/i.test(text.trim()) ? text : '') },
    walkTokens(token) {
      if (token.type === 'image') images += 1;
      if (token.type === 'table') tables += 1;
    },
  });
  const html = await marked.parse(text);
  // Marked ends every code block with a newline that was not in the source.
  return { content: htmlToDoc(html.replace(/\n<\/code><\/pre>/g, '</code></pre>')), notes: droppedNotes(images, tables) };
}

async function assertSafeDocx(buffer: Buffer): Promise<void> {
  const notADocx = 'This is not a valid .docx file. If it is an older .doc file, save it as .docx first.';
  if (buffer.subarray(0, 2).toString('latin1') !== 'PK') throw unreadable(notADocx);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw unreadable(notADocx);
  }
  if (!zip.file('word/document.xml')) throw unreadable(notADocx);
  // Refuse zip bombs using the sizes in the archive, before anything is inflated.
  let expanded = 0;
  zip.forEach((_path, entry) => {
    const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
    expanded += data?.uncompressedSize ?? 0;
  });
  if (expanded > MAX_DOCX_EXPANDED_BYTES) {
    throw new ApiError(413, 'file_too_large', 'This .docx expands to more than 50 MB, which is too large to import.');
  }
}

async function docxToDoc(buffer: Buffer): Promise<{ content: DocJson; notes: string[] }> {
  await assertSafeDocx(buffer);
  let images = 0;
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer },
      {
        styleMap: ['u => u'],
        convertImage: mammoth.images.imgElement(async () => {
          images += 1;
          return { src: '' };
        }),
      },
    );
    html = result.value;
  } catch {
    throw unreadable('This .docx could not be read. It may be damaged or password protected.');
  }
  const tables = html.match(/<table\b/g)?.length ?? 0;
  const withoutImages = html.replace(/<img\b[^>]*>/g, '');
  return { content: htmlToDoc(withoutImages), notes: droppedNotes(images, tables) };
}

function hasText(doc: DocJson): boolean {
  return JSON.stringify(doc).includes('"text":');
}

export async function convertUpload(filename: string, buffer: Buffer): Promise<Converted> {
  const extension = extname(filename).toLowerCase();
  const title = titleFromFilename(filename);
  let content: DocJson;
  let notes: string[] = [];

  if (extension === '.txt') {
    const text = decodeText(buffer);
    requireContent(text);
    content = textToDoc(text);
  } else if (extension === '.md') {
    const text = decodeText(buffer);
    requireContent(text);
    ({ content, notes } = await markdownToDoc(text));
  } else if (extension === '.docx') {
    ({ content, notes } = await docxToDoc(buffer));
  } else {
    throw new ApiError(
      415,
      'unsupported_file_type',
      `${extension ? `${extension} files aren't` : "Files without an extension aren't"} supported. Upload ${IMPORT_RULES_TEXT}.`,
    );
  }

  if (!hasText(content)) throw unreadable('No readable text was found in this file.');
  return { title, content, notes };
}
