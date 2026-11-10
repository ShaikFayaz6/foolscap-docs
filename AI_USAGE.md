# How I used AI

This is an honest record of how I worked with AI on this project: what I used it for, where it made the decisions and where I did, and where it got things wrong. Sections marked **[YOUR INPUT NEEDED]** are ones I still need to fill in myself.

## Tools

- **Claude Code** (Anthropic's coding agent, in the Claude desktop app), running the Claude Opus 5.5 model. It wrote the code, the tests and the first drafts of these documents, ran the checks below, and did the Railway volume setup in a browser at my request. I split the work across two Claude Code sessions: one coordinated and passed on my scope changes, the other built the app.
- No AI features run inside the app itself.
- I didn't use any reverse-engineering tools. The app, its name and its visual design were built from scratch.

**[YOUR INPUT NEEDED]** Any other AI tools I used (for example, to shape the brief or review the result):

> _Fill in, or write "none"._

## Who decided what

I want to be clear about this, because the AI did more than type code.

- **The AI proposed the priority order and most of the technical design.** That covers the order of production patterns (server-side permission checks first, then autosave, the 409 conflict check, import sanitizing, version history, and Yjs co-editing only if time allowed), the use of SQLite through `node:sqlite`, the comment anchoring approach, and keeping document content off the WebSocket. I reviewed these and approved them, through the coordinating session.
- **I set the scope and made the product calls.** I added roles, history, comments, export, presence and a production bar to the scope, in that order. I told it to finish fast first and then fix errors. I chose Railway for hosting. I asked for the Home button, the signed-in user and Sign out on every page. I didn't like how the first Home button looked, asked for a better one, asked for suggestions to make the UI look production-level, and then had all ten built. I asked for sample files to test with different people.
- **Yjs co-editing and suggestion mode were not built.** [ARCHITECTURE.md](ARCHITECTURE.md) explains why.

## Where AI sped things up

- **Boilerplate across the stack:** routes, migrations, React pages and CSS, generated from one design per feature.
- **Test scaffolding:** a test harness with several signed-in users against a real server, a WebSocket test client, `.docx` files built in code, and PDF output read back with `pdf.js`.
- **Trying failure cases cheaply:** zip bombs, UTF-16 text, renamed binary files, cross-site requests, flooding sockets, and deliberately breaking the code to see if the tests noticed.
- **Deployment and setup:** the Dockerfile and Railway config, and finding out why data disappeared on each deploy (there was no volume).

## AI output that was reviewed, changed or rejected

These are real cases from this build, including the AI's own mistakes.

| What happened | How it was found | What changed |
| --- | --- | --- |
| **Real bug in AI-written config.** TipTap's `StarterKit` was left with its default `trailingNode` extension. It changes a document that ends in a list as soon as you interact with it, so just clicking would autosave, bump the version, and show view-only users a false "could not save" error. | A failing browser test, once debug logging showed the saved JSON had an extra empty paragraph | Turned the extension off in `shared/schema.ts` and added a browser regression test |
| **The AI misdiagnosed that same failure twice.** First it blamed background-tab throttling (logs showed `document.hidden` was false), then a race in the test. The race was real but wasn't the cause. | Logging the actual server state instead of reasoning further | The race fix was kept since it was a real flaw in the test. A refresh when a tab becomes visible, added during the first wrong theory, was kept because it's useful anyway |
| **Proxy headers were trusted no matter what.** The first server trusted one reverse proxy even when run directly, so a client could fake its IP address or claim HTTPS, and dodge the per-IP login limit. | Review while adding rate limiting | Now `TRUST_PROXY`, default 0, and the Docker image sets 1. A test proves forwarded headers are ignored by default |
| **Importing Markdown added a newline to every code block.** | A Markdown export round-trip test | Fixed in the importer |
| **Exported Markdown could lose formatting.** Overlapping bold and italic produced `**a*b****c*`, which Markdown can't read back. | Round-trip test | Where Markdown's rules would stop a delimiter from working, the exporter writes the HTML tag instead |
| **A collaborator's name leaked into the document text.** The remote cursor label was a real text node, so a page read "first number from BlakeBlake". | Browser test | The name is drawn with CSS now, so it's never page text |
| **A browser test stopped producing a conflict** once live updates arrived, because the page just took the other save. | Browser test | That's correct behaviour. The test now types first, so a real conflict happens |
| **AI-written test expectations were wrong three times:** comment anchor positions off by one, the bullet style for a nested list, and pdf.js's operator for an underline stroke. | Failing tests, checked against the real output | Tests fixed. Product code unchanged |
| **Lint found 30 buttons without an explicit type**, which act as submit buttons inside a form. | Adding Biome | All fixed. Five rules turned off, each with a reason in `ARCHITECTURE.md` |
| **Viewers got a false error from the title field**, and editors a false "last edited". | Reading the AI's code after the tests passed | Rename only sends when the user can edit and the value actually changed |
| **The back button could trap someone** when a save had failed for good. | Reviewing that fix | Replaced with a "Leave without saving?" dialog |
| **Phone header overflowed** after presence, comments and export were added, and again after the Home button and user name were added to every page. | Screenshots at 375px wide | The header wraps, and on phones Home becomes an icon and secondary editor actions move into a "⋯" menu |
| **The phone "⋯" menu opened off the edge of the screen.** | A screenshot during the UI polish | Fixed so it opens toward the screen |
| **Avatar colours didn't match between screens.** The same person was one colour in the header and another on the documents page. | Comparing screenshots | Every avatar and cursor colour now comes from the person's name |
| **Data was wiped on every Railway deploy.** | I noticed it after redeploying | The service had no volume. A volume mounted at `/data` fixed it |
| **Paragraph spacing was silently zero** and links were default blue. | Screenshots | CSS fixed |
| **`.docx` underline and lists weren't covered at first.** | Reviewing what the tests actually proved | Underline mapping added, and a test with real Word numbering definitions |
| **Rejected: a native SQLite driver.** | Design choice | Node's built-in `node:sqlite`, so reviewers have nothing to compile |
| **Rejected: building Yjs co-editing late.** | Design choice | Live presence and instant change notices instead. Reasons in `ARCHITECTURE.md` |

**[YOUR INPUT NEEDED]** My own review: code I read closely, anything I changed, overruled or would do differently:

> _Fill in._

## How the work was checked

**Automated, and passing at the time of writing:**

- `npm test`: 204 server tests against a real running server. They cover permissions for every route and role, save conflicts, import cleanup, version restore, comments, Markdown and PDF export, WebSocket presence, cross-site request protection, rate limits, logging and configuration.
- `npm run test:e2e`: 6 browser flows in Microsoft Edge, with up to three signed-in users in separate browser sessions. They cover formatting, sharing and role changes, a save conflict, history restore, `.md` and `.docx` import, comments across roles, export downloads, presence with remote cursors, the account menu, the tab title, hard server kills with restart and reconnect, and an offline retry.
- `npm run lint` and `npm run typecheck`: clean, apart from one CSS ordering warning.

**Do the tests actually catch bugs?** 32 safeguards were broken one at a time, and the server tests rerun after each. **All 32 were caught.** Examples: removing the role check, treating no access as owner, accepting stale saves, letting a viewer comment, an unscoped comment lookup, removing Markdown escaping, dropping underline from PDFs, removing the WebSocket origin check, keeping removed users connected, removing the CSRF header or origin check, and trusting proxy headers by default.

**Checked by looking at the running app:** desktop and phone screenshots of every redesigned screen (sign-in, documents page, editor, account menu, export menu, phone "⋯" menu, empty state, toast and loading placeholders), and two people on one page with a comment, a remote cursor and the presence indicator.

**Checked on the live app:** the Railway deployment's health check reports the database up, the volume is mounted at `/data`, and the live site serves the latest UI.

**Not verified:**

- I haven't yet proven that data survives a redeploy on the live app by creating a document and redeploying.
- `.docx` testing used files generated in code that follow the Word format, not files saved by Microsoft Word itself.
- Only Microsoft Edge was tested, so not Firefox or Safari. No screen reader testing.
- Not load tested.

**[YOUR INPUT NEEDED]** My own manual testing, especially a real Word file and the live deployment:

> _Fill in what I tried and what I saw._

**[YOUR INPUT NEEDED]** My judgment calls: what I chose to prioritize or cut, and where I agreed or disagreed with the AI:

> _Fill in._
