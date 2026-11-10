import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

/**
 * The single definition of what a Foolscap document may contain. The browser
 * editor renders with it, the API validates saves against it and the importer
 * converts into it, so the three cannot drift apart.
 */
export const documentExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    // Links need a UI and a URL policy to be safe and useful; out of scope.
    link: false,
    // It edits the document on the first interaction, so simply clicking would
    // trigger a save (and a false error for people with view-only access).
    trailingNode: false,
  }),
];

export type DocJson = JSONContent & { type: 'doc' };

export const EMPTY_DOC: DocJson = { type: 'doc', content: [{ type: 'paragraph' }] };
