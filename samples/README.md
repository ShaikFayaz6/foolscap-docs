# Sample files for testing

Files to import into Foolscap, plus a short script for testing with the three demo accounts. Each person signs in in a **separate browser or a private window**, so all three can be signed in at once.

| Account | Name |
| --- | --- |
| `avery@foolscap.test` | Avery Lindqvist |
| `blake@foolscap.test` | Blake Okafor |
| `casey@foolscap.test` | Casey Moreau |

To import a file, open the documents page and click **Import a file**, or drag the file onto the page.

## `import-these/`: should import

| File | Who imports it | What to look for |
| --- | --- | --- |
| `Avery - Q4 Product Roadmap.docx` | Avery | Headings, a numbered list, bullet lists, bold, italic and underline. A notice says **1 table was flattened**. |
| `Avery - Team Meeting Notes.md` | Avery | Headings, both list types, underline from `<u>` |
| `Avery - Launch Checklist.txt` | Avery | Plain paragraphs. Single line breaks stay inside a paragraph. |
| `Blake - Marketing Brief.docx` | Blake | Numbered list with bold lead-ins |
| `Blake - Release Notes v2.md` | Blake | A code block and a quote |
| `Casey - Interview Notes.docx` | Casey | Underline and italic |
| `Casey - Onboarding Guide.md` | Casey | Numbered steps and bullets |
| `Casey - Reading List.txt` | Casey | Plain text |
| `Edge case - Markdown with HTML and images.md` | Anyone | The script and HTML block are gone. A notice says **1 image was left out** and **1 table was flattened**. |
| `Edge case - Long document.md` | Anyone | 40 sections. Good for scrolling, autosave and multi-page PDF export. |
| `Edge case - Accents and other languages.txt` | Anyone | Accents look right everywhere. Japanese, Chinese and emoji show as boxes in **PDF export only** (a known limit). |
| `Edge case - UTF-16 from Notepad.txt` | Anyone | Text saved by Notepad as UTF-16 reads correctly. |

## `should-be-refused/`: should show an error

| File | Expected message |
| --- | --- |
| `photo.png` | .png files aren't supported |
| `budget.csv` | .csv files aren't supported |
| `notes.pdf` | .pdf files aren't supported |
| `not really a word file.docx` | This is not a valid .docx file |
| `image renamed to text.txt` | This file looks binary, not text |
| `too large (over 2 MB).txt` | Over the 2 MB limit |

## A test script for three people

1. **Avery** imports `Avery - Q4 Product Roadmap.docx`, clicks **Share** and adds Blake as **Can edit** and Casey as **Can comment**.
2. **Blake** opens it from the documents page (it shows "From Avery · can edit") and changes a line. Avery sees Blake's avatar and cursor, and the change arrives.
3. **Casey** opens it. The toolbar has only the comment button: select text, click it and write a comment. Typing in the page does nothing.
4. **Avery** replies to Casey's comment and resolves it.
5. **Blake** imports `Blake - Marketing Brief.docx` and shares it with Avery as **Can comment**. Avery comments on the *Key messages* section.
6. **Casey** imports `Casey - Interview Notes.docx` and shares it with Avery and Blake as **Can view**. They can read and export it, but can't edit or comment.
7. **Avery** opens **History** on the roadmap, names a version, makes a change and restores the named version.
8. **Avery** changes Casey's role on the roadmap to **Can view** while Casey has it open. Casey's page updates at once.
9. **Avery** removes Blake from the roadmap. If Blake has it open, the page says access was removed. After a refresh, it's gone from Blake's documents page.
10. **Conflict:** Blake turns off the network (browser dev tools → Network → Offline) and types. Avery edits and saves. Blake goes back online and gets a choice to load Avery's version or replace it.
11. **Export:** anyone exports the long document as PDF and the roadmap as Markdown.

To regenerate these files, run `node samples/make-samples.mjs` from the project folder. The `.docx` files are generated in code following the Word format; they have not been opened in Microsoft Word itself.
