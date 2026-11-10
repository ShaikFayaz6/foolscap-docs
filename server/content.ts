import { getSchema } from '@tiptap/core';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { documentExtensions, type DocJson } from '../shared/schema.ts';
import { MAX_CONTENT_BYTES } from '../shared/limits.ts';
import { ApiError } from './errors.ts';

export const schema = getSchema(documentExtensions);
const MAX_DEPTH = 64;

function assertDepth(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error('nested too deeply');
  const children = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  for (const child of children) assertDepth(child, depth + 1);
}

/** The schema checks attribute names but not values, so the few that exist are checked here. */
function assertSafeAttrs(node: ProseMirrorNode): void {
  const { level, language, start, type } = node.attrs;
  const name = node.type.name;
  const valid =
    (name !== 'heading' || [1, 2, 3].includes(level)) &&
    (name !== 'codeBlock' || language === null || (typeof language === 'string' && /^[\w+#.-]{1,32}$/.test(language))) &&
    (name !== 'orderedList' || (Number.isInteger(start) && (type === null || /^[1aAiI]$/.test(String(type)))));
  if (!valid) throw new Error('invalid attribute');
}

/**
 * Validates editor JSON against the same ProseMirror schema the browser uses,
 * and returns the normalized form. Unknown nodes, unknown marks and invalid
 * structure are rejected, so a hand-crafted request cannot store a document
 * that the editor would crash on.
 */
export function normalizeContent(input: unknown): { json: DocJson; serialized: string } {
  let json: DocJson;
  try {
    assertDepth(input);
    const node = ProseMirrorNode.fromJSON(schema, input as Record<string, unknown>);
    if (node.type.name !== 'doc') throw new Error('root must be a doc');
    node.check();
    node.descendants(assertSafeAttrs);
    json = node.toJSON() as DocJson;
  } catch {
    throw new ApiError(422, 'invalid_content', 'This document contains content Foolscap cannot store.');
  }
  const serialized = JSON.stringify(json);
  if (Buffer.byteLength(serialized) > MAX_CONTENT_BYTES) {
    throw new ApiError(413, 'content_too_large', 'This document is too large to save (5 MB of content at most).');
  }
  return { json, serialized };
}
