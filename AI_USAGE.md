# How AI was used

Sections marked **[YOUR INPUT NEEDED]** can only be answered by the person submitting this work. They have been left blank on purpose. Everything else is a log of what happened during the build.

## Tools

- **Claude Code** (Anthropic's coding agent, in the desktop app), running the Claude Opus 5.5 model. It wrote the code, tests and first drafts of these documents, and ran the checks described below. The work was split across two Claude Code sessions: one coordinated and passed on scope changes, the other built the app.
- No AI features run inside the app itself.
- No reverse-engineering tools were used. The app, its name and its visual design were built from scratch.

**[YOUR INPUT NEEDED]** Any other AI tools you used (for example, to shape the brief or review the result):

> _Fill in, or write "none"._

## Prioritization

The order of production patterns was **suggested by the AI**: server-side permission checks first, then debounced autosave with visible state, optimistic concurrency with 409 conflicts, sanitizing imports and pastes, version history, and real-time co-editing (Yjs) only if everything else was done. The coordinating session reported this order as **approved by the user**. A later scope change, also passed on by the coordinating session as the user's, added roles, history, comments, export, presence and a production bar, in that order. Yjs co-editing and suggestion mode were not built; `ARCHITECTURE.md` explains why.

## Where AI sped up the work

- **Boilerplate across the stack:** routes, migrations, React pages and CSS were generated from one design per feature.
- **Test scaffolding:** a harness with several signed-in users against a real server, a WebSocket test client, `.docx` fixtures built in code, and PDF output read back with `pdf.js`.
- **Trying failure cases cheaply:** zip bombs, UTF-16 text, renamed binaries, cross-site requests, flooding sockets, and deliberately breaking the code to see whether tests noticed.

## AI output that was reviewed, changed or rejected

These are the concrete cases from this build, including the AI's own mistakes.

| What happened | How it was found | What changed |
| --- | --- | --- |
| **Real bug in AI-written config.** TipTap's `StarterKit` was left with its default `trailingNode` extension. It changes a document ending in a list on first interaction, so just clicking would autosave, bump the version, and show view-only users a false "could not save" error. | A failing browser test, once debug logging showed the stored JSON had a stray empty paragraph | Disabled the extension in `shared/schema.ts` and added a browser regression test |
| **AI misdiagnosed that same failure twice.** It first blamed background-tab throttling (logs showed `document.hidden` was false), then a race in the test. The race was real but wasn't the cause of this failure. | Logging the actual server state rather than reasoning further | The race fix was kept since it was a true flaw in the test. A refresh when a tab becomes visible, added during the first wrong theory, was kept because it's useful anyway |
| **Proxy headers were trusted unconditionally.** The first server trusted one reverse proxy even when run directly, so a client could fake its IP address or claim HTTPS. That would have let anyone dodge the new per-IP login limit. | Review while adding rate limiting | Now `TRUST_PROXY`, default 0; the Docker image sets 1. A test proves forwarded headers are ignored by default |
| **Importing Markdown added a newline to every code block.** | A Markdown export round-trip test | Fixed in the importer |
| **Exported Markdown could lose formatting.** Overlapping bold and italic produced `**a*b****c*`, which Markdown can't parse back. | Round-trip test | When Markdown's rules would stop a delimiter from applying, the exporter writes the HTML tag instead |
| **A collaborator's name leaked into the document text.** The remote cursor label was a real text node, so a page read "first number from BlakeBlake". | Browser test | The name is now drawn with CSS, so it is never page text |
| **A browser test stopped producing a conflict** once live updates arrived, because the page simply took the other save. | Browser test | Correct behaviour; the test now types first so a real conflict occurs |
| **AI-written test expectations were wrong three times:** comment anchor positions off by one, the bullet style expected for a nested list, and pdf.js's operator for an underline stroke. | Failing tests, checked against the actual output | Tests corrected; product code unchanged |
| **Lint found 30 buttons without an explicit type**, which act as submit buttons inside a form. | Adding Biome | All fixed. Five rules turned off, each with a reason in `ARCHITECTURE.md` |
| **Viewers got a false error from the title field**, and editors a false "last edited". | Reading the AI's code after the tests passed | Rename only sends when the user can edit and the value changed |
| **Back button could trap someone** when a save had failed for good. | Reviewing that fix | Replaced with a "Leave without saving?" dialog |
| **Phone header overflowed** once presence, comments and export were added. | A screenshot at 375px wide | The header now wraps |
| **Paragraph spacing was silently zero** and links were default blue. | Screenshots | CSS corrected |
| **`.docx` underline and lists weren't covered at first.** | Reviewing what the tests actually proved | Underline mapping and a test with real Word numbering definitions |
| **Rejected: a native SQLite driver.** | Design choice | Node's built-in `node:sqlite`, so reviewers have nothing to compile |
| **Rejected: building Yjs co-editing late.** | Design choice | Live presence and immediate change notices instead; reasons in `ARCHITECTURE.md` |

**[YOUR INPUT NEEDED]** Your own review: code you read closely, anything you changed, overruled or would do differently:

> _Fill in._

## How the work was verified

**Automated, and passing at the time of writing:**

- `npm test`: 204 server tests against a real listening server. They cover permissions for every route and role, concurrency conflicts, import sanitization, version restore, comments, Markdown and PDF export, WebSocket presence, cross-site request protection, rate limits, logging and configuration.
- `npm run test:e2e`: 6 browser flows in Microsoft Edge with up to three signed-in users in separate browser sessions. They cover formatting, sharing and role changes, a save conflict, history restore, `.md` and `.docx` import, comments across roles, export downloads, presence with remote cursors, hard server kills with restart and reconnect, and an offline retry.
- `npm run lint` and `npm run typecheck`: clean, apart from one CSS ordering warning.

**Do the tests actually catch bugs?** 32 guards were broken one at a time and all server tests rerun. **All 32 were caught.** Examples: removing the role check, treating no access as owner, accepting stale saves, letting a viewer comment, an unscoped comment lookup, removing Markdown escaping, dropping underline from PDFs, removing the WebSocket origin check, keeping revoked users connected, removing the CSRF header or origin check, and trusting proxy headers by default.

**Checked by looking at the running app:** desktop and phone screenshots of two people on one page, showing a comment, a remote cursor and the presence indicator.

**Not verified:**

- The Docker image was not built, because the Docker engine wasn't running on this machine. Nothing has been deployed, so hosted WebSockets and the deployment config are untested.
- `.docx` testing used files generated in code that follow the Word format, not files saved by Microsoft Word itself.
- Only Microsoft Edge was tested, so not Firefox or Safari. No screen reader testing.
- Not load tested.

**[YOUR INPUT NEEDED]** Your own manual testing, especially a real Word file and the live deployment:

> _Fill in what you tried and what you saw._

**[YOUR INPUT NEEDED]** Your judgment calls: what you chose to prioritize or cut, and where you agreed or disagreed with the AI:

> _Fill in._
