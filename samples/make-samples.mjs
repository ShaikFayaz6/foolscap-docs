// Run from the project folder: node <this file>. Writes sample import files into samples/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'x.js'));
const JSZip = require('jszip');

const OUT = 'samples';
const GOOD = join(OUT, 'import-these');
const BAD = join(OUT, 'should-be-refused');
mkdirSync(GOOD, { recursive: true });
mkdirSync(BAD, { recursive: true });
const put = (dir, name, data) => writeFileSync(join(dir, name), data);

// ---------- .docx builder ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Inline runs: **bold**, *italic*, __underline__
function runs(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(run(text.slice(last, m.index)));
    const t = m[0];
    if (t.startsWith('**')) out.push(run(t.slice(2, -2), '<w:b/>'));
    else if (t.startsWith('__')) out.push(run(t.slice(2, -2), '<w:u w:val="single"/>'));
    else out.push(run(t.slice(1, -1), '<w:i/>'));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(run(text.slice(last)));
  return out.join('');
}
const run = (t, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (style, text, numId) =>
  `<w:p>${style || numId ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` : ''}</w:pPr>` : ''}${runs(text)}</w:p>`;
const table = (rows) =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('')}</w:tblBorders></w:tblPr>${rows
    .map((r) => `<w:tr>${r.map((c) => `<w:tc><w:p>${runs(c)}</w:p></w:tc>`).join('')}</w:tr>`)
    .join('')}</w:tbl>`;

/** blocks: ['h1'|'h2'|'h3'|'p'|'ul'|'ol', text] or ['table', rows] */
function body(blocks) {
  let numCounter = 0;
  let prev = null;
  let currentNum = 0;
  return blocks
    .map(([kind, value]) => {
      let xml;
      if (kind === 'ul' || kind === 'ol') {
        if (prev !== kind) {
          numCounter += 1;
          currentNum = kind === 'ul' ? 1 : 2 + numCounter; // ordered lists restart numbering
        }
        xml = para('ListParagraph', value, currentNum);
      } else if (kind === 'table') xml = table(value);
      else if (kind === 'p') xml = para('', value);
      else xml = para(`Heading${kind[1]}`, value);
      prev = kind;
      return xml;
    })
    .join('');
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

function numbering(orderedCount) {
  const bullet = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`;
  const decimal = `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`;
  let nums = `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
  for (let i = 3; i < 3 + orderedCount + 20; i += 1) {
    nums += `<w:num w:numId="${i}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}>${bullet}${decimal}${nums}</w:numbering>`;
}

async function docx(blocks, title) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
  );
  zip.file(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title><dc:creator>Foolscap samples</dc:creator></cp:coreProperties>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
  );
  zip.file('word/styles.xml', styles);
  zip.file('word/numbering.xml', numbering(blocks.length));
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body(blocks)}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------- Word documents ----------
put(
  GOOD,
  'Avery - Q4 Product Roadmap.docx',
  await docx(
    [
      ['h1', 'Q4 Product Roadmap'],
      ['p', 'Owner: **Avery Lindqvist**. Last reviewed in the *Monday planning meeting*. Anything __underlined__ still needs a decision.'],
      ['h2', 'Goals for the quarter'],
      ['ol', 'Ship sharing with **three roles**: edit, comment and view.'],
      ['ol', 'Cut the time to first document to *under one minute*.'],
      ['ol', 'Reach __99.9% uptime__ on the hosted demo.'],
      ['h2', 'Workstreams'],
      ['h3', 'Editor'],
      ['ul', 'Autosave with a visible save state'],
      ['ul', 'Version history with **named versions**'],
      ['ul', 'Comments anchored to text'],
      ['h3', 'Import and export'],
      ['ul', 'Accept .txt, .md and .docx up to 2 MB'],
      ['ul', 'Export to Markdown and *PDF*'],
      ['h2', 'Owners and dates'],
      ['p', 'The table below should be flattened on import, and Foolscap should tell you that it did.'],
      ['table', [['Workstream', 'Owner', 'Due'], ['Editor', 'Avery', '15 Nov'], ['Import and export', 'Blake', '29 Nov'], ['Onboarding', 'Casey', '6 Dec']]],
      ['h2', 'Open questions'],
      ['ul', 'Do we need __suggestion mode__ before launch?'],
      ['ul', 'Who signs off on the *pricing page*?'],
    ],
    'Q4 Product Roadmap',
  ),
);

put(
  GOOD,
  'Blake - Marketing Brief.docx',
  await docx(
    [
      ['h1', 'Marketing Brief: Foolscap Launch'],
      ['p', 'Prepared by **Blake Okafor** for review by Avery. Please leave comments rather than editing the *Key messages* section.'],
      ['h2', 'Audience'],
      ['p', 'Small teams who write together: product managers, *researchers* and __students working on group projects__.'],
      ['h2', 'Key messages'],
      ['ol', '**Your words are safe.** Every change saves on its own, and history keeps earlier versions.'],
      ['ol', '**Share with care.** Pick who can edit, comment or only read.'],
      ['ol', '**Bring what you have.** Import Word, Markdown or plain text in one click.'],
      ['h2', 'Channels'],
      ['ul', 'Product blog post'],
      ['ul', 'Short demo video'],
      ['ul', 'Email to the *beta waitlist*'],
      ['h3', 'Budget'],
      ['p', 'Total: **$4,500**, split evenly across the three channels.'],
    ],
    'Marketing Brief',
  ),
);

put(
  GOOD,
  'Casey - Interview Notes.docx',
  await docx(
    [
      ['h1', 'User Interview Notes'],
      ['p', 'Interviewer: **Casey Moreau**. Five participants, 30 minutes each.'],
      ['h2', 'What people liked'],
      ['ul', 'Seeing *who else* is on the page'],
      ['ul', 'Comments that stay attached to the text'],
      ['h2', 'What confused people'],
      ['ol', 'The difference between __commenter__ and __viewer__ was not obvious at first.'],
      ['ol', 'Two people expected an **Undo** for restoring a version.'],
      ['h2', 'Quote of the week'],
      ['p', '*"I stopped emailing drafts around once I could just share the link."*'],
    ],
    'User Interview Notes',
  ),
);

// ---------- Markdown ----------
put(
  GOOD,
  'Avery - Team Meeting Notes.md',
  `# Team Meeting Notes

**Date:** Monday 9 November
**Attendees:** Avery, Blake, Casey

## Agenda

1. Review last week's actions
2. Plan the hosted demo
3. Any other business

## Decisions

- We deploy on **Railway** with a volume for the database.
- Blake owns the *marketing brief*; Avery reviews it.
- Casey runs <u>two more user interviews</u> this week.

## Action items

1. **Avery:** share the roadmap with Blake (edit) and Casey (comment).
2. **Blake:** import the marketing brief and ask Avery for comments.
3. **Casey:** add interview notes and share them as *view only*.

### Parking lot

Ideas we liked but are not doing yet:

- Suggestion mode
- Real-time co-editing
`,
);

put(
  GOOD,
  'Blake - Release Notes v2.md',
  `# Release Notes: Version 2.0

## New

- **Comments.** Select text and press the comment button. Replies and resolve are included.
- **Export.** Download any page as *Markdown* or *PDF*.
- **Presence.** See who else has the page open and where their cursor is.

## Improved

1. Saving is faster and shows ***exactly*** when it last succeeded.
2. Importing a \`.docx\` keeps headings, lists and <u>underline</u>.

## Fixed

- A viewer no longer sees a false "could not save" message.
- Long titles no longer push the toolbar off small screens.

## Code sample

\`\`\`
npm install
npm run build
npm start
\`\`\`

> Thanks to everyone who reported issues during the beta.
`,
);

put(
  GOOD,
  'Casey - Onboarding Guide.md',
  `# Welcome to the team

This guide is for **new starters**. Read it in your first week.

## Day one

1. Collect your laptop from the front desk.
2. Sign in to Foolscap with the account you were given.
3. Open *"Welcome to Foolscap"* and leave a comment to say hello.

## Your first week

- Shadow a teammate on Tuesday.
- Read the **Q4 Product Roadmap**.
- Ask questions! There are *no* silly ones.

## Who to ask

- **Avery** for anything about the product
- **Blake** for marketing and launch questions
- **Casey** for onboarding and research
`,
);

put(
  GOOD,
  'Edge case - Markdown with HTML and images.md',
  `# Markdown with things Foolscap removes

This paragraph should import normally, with **bold** and *italic*.

<script>alert('this script must not survive import')</script>

<div style="color:red" onclick="alert(1)">Raw HTML blocks like this are dropped.</div>

![A picture that Foolscap leaves out](https://example.com/picture.png)

| A | Markdown | Table |
| - | -------- | ----- |
| 1 | 2        | 3     |

[A link](https://example.com) keeps its words but not the link.

Text after everything above should still be here.
`,
);

const longSections = [];
for (let i = 1; i <= 40; i += 1) {
  longSections.push(
    `## Section ${i}\n\nThis is paragraph ${i} of a long document, written to test **scrolling**, *autosave on large pages* and multi-page **PDF export**. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n\n- Point ${i}.1\n- Point ${i}.2\n`,
  );
}
put(GOOD, 'Edge case - Long document.md', `# A long document\n\n${longSections.join('\n')}`);

// ---------- Plain text ----------
put(
  GOOD,
  'Avery - Launch Checklist.txt',
  `Launch checklist

Before launch:
- Volume attached at /data
- Demo accounts tested by Avery, Blake and Casey
- PDF export checked on a long document

On launch day:
1. Post on the blog
2. Email the beta waitlist
3. Watch the health check

After launch:
Collect feedback for one week, then plan version 3.
`,
);

put(
  GOOD,
  'Casey - Reading List.txt',
  `Reading list for new starters

The Elements of Style
Don't Make Me Think
The Design of Everyday Things

Blank lines start a new paragraph. A single line break, like the ones in the list above, stays inside the same paragraph.
`,
);

put(
  GOOD,
  'Edge case - Accents and other languages.txt',
  `Accents and other scripts

French: café, crème brûlée, Noël
German: Grüße aus München, Straße
Spanish: ¿Dónde está la biblioteca? ¡Olé!
Greek: Καλημέρα κόσμε
Russian: Привет, мир

Japanese: こんにちは世界
Chinese: 你好，世界
Emoji: 🎉 ✅ 📄

The first lines should look right everywhere. The Japanese, Chinese and emoji lines show correctly in the editor and in Markdown export, but appear as empty boxes in PDF export, which is a known limit.
`,
);

// UTF-16 encoded text file (as saved by Windows Notepad "Unicode")
put(GOOD, 'Edge case - UTF-16 from Notepad.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Saved as UTF-16\r\n\r\nWindows Notepad can save text this way. Foolscap should read it correctly: naïve, façade, jalapeño.\r\n', 'utf16le')]));

// ---------- Files that should be refused ----------
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
put(BAD, 'photo.png', PNG);
put(BAD, 'not really a word file.docx', 'This is plain text with a .docx name. Foolscap should refuse it because it is not a real Word file.\n');
put(BAD, 'image renamed to text.txt', PNG);
put(BAD, 'budget.csv', 'Item,Cost\nBlog,1500\nVideo,1500\nEmail,1500\n');
put(BAD, 'notes.pdf', '%PDF-1.4\n% A tiny file with a .pdf name. PDF is not an import format.\n');
const line = 'This line is repeated to make the file larger than the 2 MB upload limit.\n';
put(BAD, 'too large (over 2 MB).txt', line.repeat(Math.ceil((2 * 1024 * 1024 + 50_000) / line.length)));

console.log('done');
