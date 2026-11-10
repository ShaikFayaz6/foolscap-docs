import { useEditorState, type Editor } from '@tiptap/react';
import type { ReactNode } from 'react';

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

const ICONS = {
  bullets: icon(
    <>
      <path d="M8 5h9M8 10h9M8 15h9" />
      <circle cx="3.5" cy="5" r=".9" fill="currentColor" />
      <circle cx="3.5" cy="10" r=".9" fill="currentColor" />
      <circle cx="3.5" cy="15" r=".9" fill="currentColor" />
    </>,
  ),
  numbers: icon(
    <>
      <path d="M8 5h9M8 10h9M8 15h9" />
      <path d="M2.5 3.5 4 3v4M2.5 12.5c.3-.9 2.3-.9 2.2.4 0 .9-2.3 1.9-2.3 3.1h2.5" strokeWidth="1.2" />
    </>,
  ),
  undo: icon(<path d="M7 4 3 8l4 4M3 8h9a4.5 4.5 0 0 1 0 9H8" />),
  redo: icon(<path d="m13 4 4 4-4 4M17 8H8a4.5 4.5 0 0 0 0 9h4" />),
};

interface ToolProps {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onRun: () => void;
  children: ReactNode;
}

function Tool({ label, shortcut, active, disabled, onRun, children }: ToolProps) {
  return (
    <button
      type="button"
      className="tool"
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      // Keeps the text selection in the editor when a tool is pressed.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

export function ToolRail({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      body: e.isActive('paragraph'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      bullets: e.isActive('bulletList'),
      numbers: e.isActive('orderedList'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();

  return (
    <div className="tool-rail" role="toolbar" aria-label="Formatting">
      <div className="tool-group">
        <Tool label="Body text" active={state.body} onRun={() => chain().setParagraph().run()}>
          <span className="tool-glyph tool-serif">Aa</span>
        </Tool>
        <Tool label="Heading 1" active={state.h1} onRun={() => chain().toggleHeading({ level: 1 }).run()}>
          <span className="tool-glyph">H1</span>
        </Tool>
        <Tool label="Heading 2" active={state.h2} onRun={() => chain().toggleHeading({ level: 2 }).run()}>
          <span className="tool-glyph">H2</span>
        </Tool>
        <Tool label="Heading 3" active={state.h3} onRun={() => chain().toggleHeading({ level: 3 }).run()}>
          <span className="tool-glyph">H3</span>
        </Tool>
      </div>
      <div className="tool-group">
        <Tool label="Bold" shortcut="Ctrl+B" active={state.bold} onRun={() => chain().toggleBold().run()}>
          <b className="tool-glyph tool-serif">B</b>
        </Tool>
        <Tool label="Italic" shortcut="Ctrl+I" active={state.italic} onRun={() => chain().toggleItalic().run()}>
          <i className="tool-glyph tool-serif">I</i>
        </Tool>
        <Tool label="Underline" shortcut="Ctrl+U" active={state.underline} onRun={() => chain().toggleUnderline().run()}>
          <u className="tool-glyph tool-serif">U</u>
        </Tool>
      </div>
      <div className="tool-group">
        <Tool label="Bulleted list" active={state.bullets} onRun={() => chain().toggleBulletList().run()}>
          {ICONS.bullets}
        </Tool>
        <Tool label="Numbered list" active={state.numbers} onRun={() => chain().toggleOrderedList().run()}>
          {ICONS.numbers}
        </Tool>
      </div>
      <div className="tool-group">
        <Tool label="Undo" shortcut="Ctrl+Z" disabled={!state.canUndo} onRun={() => chain().undo().run()}>
          {ICONS.undo}
        </Tool>
        <Tool label="Redo" shortcut="Ctrl+Y" disabled={!state.canRedo} onRun={() => chain().redo().run()}>
          {ICONS.redo}
        </Tool>
      </div>
    </div>
  );
}
