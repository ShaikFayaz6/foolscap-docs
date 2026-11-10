import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

export interface DocNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string }[];
  content?: DocNode[];
}

const has = (node: DocNode, mark: string) => node.marks?.some((item) => item.type === mark) ?? false;

/** Inline nodes split at hard breaks, since a break cannot sit inside a Markdown mark. */
function inlineLines(nodes: DocNode[] = []): DocNode[][] {
  const lines: DocNode[][] = [[]];
  for (const node of nodes) {
    if (node.type === 'hardBreak') lines.push([]);
    else if (node.type === 'text') lines[lines.length - 1]!.push(node);
  }
  return lines;
}

// --- Markdown ---------------------------------------------------------------

type MarkSyntax = [mark: string, open: string, close: string, htmlTag: string];

/** Outermost first. Fixed order so neighbouring runs share their outer marks. */
const MARK_ORDER: MarkSyntax[] = [
  ['bold', '**', '**', 'strong'],
  ['italic', '*', '*', 'em'],
  ['strike', '~~', '~~', 's'],
  ['underline', '<u>', '</u>', 'u'], // Markdown has no underline; inline HTML is the portable way to keep it.
];

const escapeText = (text: string) => text.replace(/\n/g, ' ').replace(/[\\`*_[\]<>~&]/g, '\\$&');

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const isWord = (char: string) => /[\p{L}\p{N}]/u.test(char);

/** CommonMark only honours a delimiter when the characters on its two sides allow it. */
function delimiterHolds(outside: string, inside: string): boolean {
  if (!outside || /\s/.test(outside)) return true;
  if (/[*~`]/.test(outside)) return false;
  return !isWord(outside) || isWord(inside);
}

/** Delimiters must touch the text, so whitespace at the edges moves outside them. */
function wrap(inner: string, [, open, close, tag]: MarkSyntax, before: string, after: string): string {
  const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  if (!body) return inner;
  const holds = (lead || delimiterHolds(before, body[0]!)) && (trail || delimiterHolds(after, body.at(-1)!));
  return holds ? `${lead}${open}${body}${close}${trail}` : `${lead}<${tag}>${body}</${tag}>${trail}`;
}

function renderRuns(runs: DocNode[], level: number): string {
  if (level === MARK_ORDER.length) {
    return runs.map((run) => (has(run, 'code') ? codeSpan(run.text ?? '') : escapeText(run.text ?? ''))).join('');
  }
  const syntax = MARK_ORDER[level]!;
  const segments: { marked: boolean; inner: string }[] = [];
  for (let start = 0; start < runs.length; ) {
    const marked = has(runs[start]!, syntax[0]);
    let end = start;
    while (end < runs.length && has(runs[end]!, syntax[0]) === marked) end += 1;
    segments.push({ marked, inner: renderRuns(runs.slice(start, end), level + 1) });
    start = end;
  }
  return segments
    .map(({ marked, inner }, index) =>
      marked ? wrap(inner, syntax, segments[index - 1]?.inner.at(-1) ?? '', segments[index + 1]?.inner[0] ?? '') : inner,
    )
    .join('');
}

/** Stops ordinary text at the start of a line from being read as block syntax. */
const escapeLineStart = (line: string) =>
  line
    .replace(/^[ \t]+/, '')
    .replace(/^[#+\-=]/, '\\$&')
    .replace(/^(\d{1,9})([.)])/, '$1\\$2');

const markdownInline = (nodes?: DocNode[]) =>
  inlineLines(nodes)
    .map((line) => escapeLineStart(renderRuns(line, 0)))
    .join('\\\n');

const indent = (text: string, prefix: string, first = prefix) =>
  text
    .split('\n')
    .map((line, index) => (index === 0 ? first + line : line ? prefix + line : line.trimEnd()))
    .join('\n');

function markdownItem(item: DocNode, marker: string): string {
  let body = '';
  for (const [index, block] of (item.content ?? []).entries()) {
    const text = markdownBlock(block, false);
    if (index > 0) body += block.type === 'bulletList' || block.type === 'orderedList' ? '\n' : '\n\n';
    body += text;
  }
  return indent(body, ' '.repeat(marker.length + 1), `${marker} `);
}

/** `alternate` picks the other list marker, or two adjacent lists would merge into one. */
function markdownBlock(node: DocNode, alternate: boolean): string {
  switch (node.type) {
    case 'heading': {
      const text = inlineLines(node.content)
        .map((line) => renderRuns(line, 0).trim())
        .join(' ')
        .replace(/#+$/, (hashes) => `\\${hashes}`);
      return text ? `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${text}` : '';
    }
    case 'paragraph':
      return markdownInline(node.content);
    case 'bulletList':
      return (node.content ?? []).map((item) => markdownItem(item, alternate ? '*' : '-')).join('\n');
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1);
      const delimiter = alternate ? ')' : '.';
      return (node.content ?? []).map((item, index) => markdownItem(item, `${start + index}${delimiter}`)).join('\n');
    }
    case 'blockquote':
      return indent(markdownBlocks(node.content), '> ').replace(/^$/gm, '>');
    case 'codeBlock': {
      const code = (node.content ?? []).map((child) => child.text ?? '').join('');
      const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `${fence}${(node.attrs?.language as string | null) ?? ''}\n${code}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    default:
      return '';
  }
}

function markdownBlocks(nodes: DocNode[] = []): string {
  const output: string[] = [];
  let alternate = false;
  nodes.forEach((node, index) => {
    alternate = index > 0 && nodes[index - 1]!.type === node.type && !alternate;
    const text = markdownBlock(node, alternate);
    if (text) output.push(text);
  });
  return output.join('\n\n');
}

export function toMarkdown(doc: DocNode): string {
  const text = markdownBlocks(doc.content);
  return text ? `${text}\n` : '';
}

// --- PDF --------------------------------------------------------------------

const fontPath = createRequire(import.meta.url);
const FONTS = {
  regular: 'DejaVuSerif.ttf',
  bold: 'DejaVuSerif-Bold.ttf',
  italic: 'DejaVuSerif-Italic.ttf',
  boldItalic: 'DejaVuSerif-BoldItalic.ttf',
  mono: 'DejaVuSansMono.ttf',
};

const MARGIN = 72;
const BODY_SIZE = 11;
const LINE_GAP = 3;
const BLOCK_GAP = 8;
const LIST_INDENT = 22;
const INK = '#23201b';
const SOFT = '#5f594f';
const HEADINGS: Record<number, { size: number; before: number }> = {
  1: { size: 22, before: 12 },
  2: { size: 17, before: 10 },
  3: { size: 14, before: 8 },
};
const BULLETS = ['•', '◦', '▪'];

type Pdf = InstanceType<typeof PDFDocument>;
interface Box {
  x: number;
  width: number;
  color: string;
}

function ensureRoom(pdf: Pdf, height: number): void {
  if (pdf.y + height > pdf.page.maxY()) pdf.addPage();
}

function fontFor(run: DocNode, baseBold: boolean): keyof typeof FONTS {
  if (has(run, 'code')) return 'mono';
  const bold = baseBold || has(run, 'bold');
  const italic = has(run, 'italic');
  return bold ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular';
}

function pdfInline(pdf: Pdf, nodes: DocNode[] | undefined, box: Box, size: number, bold: boolean): void {
  const runs = inlineLines(nodes).flatMap((line, index): DocNode[] => [...(index > 0 ? [{ type: 'text', text: '\n' }] : []), ...line]);
  pdf.fillColor(box.color);
  if (runs.length === 0) {
    pdf.font('regular').fontSize(size).text(' ', box.x, pdf.y, { width: box.width, lineGap: LINE_GAP });
    return;
  }
  runs.forEach((run, index) => {
    const options = {
      width: box.width,
      lineGap: LINE_GAP,
      continued: index < runs.length - 1,
      underline: has(run, 'underline'),
      strike: has(run, 'strike'),
    };
    pdf.font(fontFor(run, bold)).fontSize(has(run, 'code') ? size * 0.92 : size);
    if (index === 0) pdf.text(run.text ?? '', box.x, pdf.y, options);
    else pdf.text(run.text ?? '', options);
  });
}

function pdfList(pdf: Pdf, node: DocNode, box: Box, depth: number): void {
  // Very deep nesting stops indenting rather than squeezing the text column to nothing.
  const step = box.width > 140 ? LIST_INDENT : 0;
  const inner = { ...box, x: box.x + step, width: box.width - step };
  const start = Number(node.attrs?.start ?? 1);
  (node.content ?? []).forEach((item, index) => {
    ensureRoom(pdf, BODY_SIZE * 1.6);
    const y = pdf.y;
    const marker = node.type === 'orderedList' ? `${start + index}.` : BULLETS[depth % BULLETS.length]!;
    pdf.font('regular').fontSize(BODY_SIZE).fillColor(box.color);
    pdf.text(marker, Math.max(box.x, inner.x - 6 - pdf.widthOfString(marker)), y, { lineBreak: false });
    pdf.y = y;
    (item.content ?? []).forEach((block, blockIndex) => {
      if (blockIndex > 0 && block.type !== 'bulletList' && block.type !== 'orderedList') pdf.y += BLOCK_GAP / 2;
      pdfBlock(pdf, block, inner, depth + 1);
    });
    pdf.y += 2;
  });
}

function pdfBlock(pdf: Pdf, node: DocNode, box: Box, depth: number): void {
  switch (node.type) {
    case 'heading': {
      const { size, before } = HEADINGS[Number(node.attrs?.level ?? 1)] ?? HEADINGS[3]!;
      pdf.y += before;
      ensureRoom(pdf, size * 3.5); // Keep a heading with the first lines after it.
      pdfInline(pdf, node.content, box, size, true);
      pdf.y += BLOCK_GAP / 2;
      break;
    }
    case 'paragraph':
      pdfInline(pdf, node.content, box, BODY_SIZE, false);
      if (depth === 0) pdf.y += BLOCK_GAP;
      break;
    case 'bulletList':
    case 'orderedList':
      pdfList(pdf, node, box, depth);
      if (depth === 0) pdf.y += BLOCK_GAP - 2;
      break;
    case 'blockquote': {
      const inner = { x: box.x + 18, width: box.width - 18, color: SOFT };
      for (const child of node.content ?? []) pdfBlock(pdf, child, inner, 1);
      pdf.y += BLOCK_GAP;
      break;
    }
    case 'codeBlock': {
      const code = (node.content ?? []).map((child) => child.text ?? '').join('') || ' ';
      pdf.font('mono').fontSize(BODY_SIZE * 0.88).fillColor(box.color);
      pdf.text(code, box.x + 12, pdf.y, { width: box.width - 12, lineGap: LINE_GAP });
      pdf.y += BLOCK_GAP;
      break;
    }
    case 'horizontalRule': {
      ensureRoom(pdf, BLOCK_GAP * 2);
      const y = pdf.y + BLOCK_GAP / 2;
      pdf.moveTo(box.x, y).lineTo(box.x + box.width, y).lineWidth(0.75).strokeColor(SOFT).stroke();
      pdf.y = y + BLOCK_GAP;
      break;
    }
    default:
      break;
  }
}

export function toPdf(doc: DocNode, title: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'LETTER', margin: MARGIN, info: { Title: title, Creator: 'Foolscap' } });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    for (const [name, file] of Object.entries(FONTS)) pdf.registerFont(name, fontPath.resolve(`dejavu-fonts-ttf/ttf/${file}`));
    pdf.font('regular');
    const box = { x: MARGIN, width: pdf.page.width - MARGIN * 2, color: INK };
    for (const node of doc.content ?? []) pdfBlock(pdf, node, box, 0);
    pdf.end();
  });
}
