import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** A visual overlay on the document that is never part of its saved content. */
function createLayer(name: string) {
  const key = new PluginKey<DecorationSet>(name);
  return {
    plugin: new Plugin<DecorationSet>({
      key,
      state: {
        init: () => DecorationSet.empty,
        apply: (transaction, set) => (transaction.getMeta(key) as DecorationSet | undefined) ?? set.map(transaction.mapping, transaction.doc),
      },
      props: { decorations: (state) => key.getState(state) },
    }),
    set(editor: Editor, build: (doc: ProseMirrorNode) => Decoration[]) {
      const { state, view } = editor;
      view.dispatch(state.tr.setMeta(key, DecorationSet.create(state.doc, build(state.doc))).setMeta('addToHistory', false));
    },
  };
}

export const commentLayer = createLayer('foolscapComments');
export const cursorLayer = createLayer('foolscapCursors');

export const Layers = Extension.create({
  name: 'foolscapLayers',
  addProseMirrorPlugins: () => [commentLayer.plugin, cursorLayer.plugin],
});

export { Decoration };
