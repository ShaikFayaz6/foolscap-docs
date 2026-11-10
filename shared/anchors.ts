import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * A comment points at text, not at a place in the document's structure. It
 * records the quoted text with a little context on each side, and finds it
 * again on load. Comments therefore live outside the document, need no write
 * access, and cannot cause a save conflict. If the quoted text is later
 * rewritten, the comment is kept and shown as detached.
 */
export interface Anchor {
  from: number;
  to: number;
  quote: string;
  prefix: string;
  suffix: string;
}

const CONTEXT_LENGTH = 32;
export const MAX_QUOTE_LENGTH = 2000;

/** The document as plain text, with the document position of each character. */
function flatten(doc: ProseMirrorNode): { text: string; positions: number[] } {
  let text = '';
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      const value = node.text ?? '';
      for (let index = 0; index < value.length; index += 1) positions.push(pos + index);
      text += value;
    } else if ((node.isBlock || node.type.name === 'hardBreak') && text && !text.endsWith('\n')) {
      text += '\n';
      positions.push(pos);
    }
  });
  return { text, positions };
}

export function createAnchor(doc: ProseMirrorNode, from: number, to: number): Anchor | null {
  const { text, positions } = flatten(doc);
  const start = positions.findIndex((position) => position >= from);
  if (start === -1) return null;
  let end = start;
  while (end < positions.length && positions[end]! < to) end += 1;
  const quote = text.slice(start, end);
  if (!quote.trim()) return null;
  return {
    from,
    to,
    quote: quote.slice(0, MAX_QUOTE_LENGTH),
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + CONTEXT_LENGTH),
  };
}

function sharedEnd(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
  return count;
}

function sharedStart(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1;
  return count;
}

/** Finds the best current match for an anchor, or null if its text no longer exists. */
export function resolveAnchor(doc: ProseMirrorNode, anchor: Anchor): { from: number; to: number } | null {
  const { text, positions } = flatten(doc);
  let best = -1;
  let bestScore = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = text.indexOf(anchor.quote); index !== -1; index = text.indexOf(anchor.quote, index + 1)) {
    const before = text.slice(Math.max(0, index - CONTEXT_LENGTH), index);
    const after = text.slice(index + anchor.quote.length, index + anchor.quote.length + CONTEXT_LENGTH);
    const score = sharedEnd(before, anchor.prefix) + sharedStart(after, anchor.suffix);
    const distance = Math.abs(positions[index]! - anchor.from);
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      best = index;
      bestScore = score;
      bestDistance = distance;
    }
  }
  if (best === -1) return null;
  return { from: positions[best]!, to: positions[best + anchor.quote.length - 1]! + 1 };
}
