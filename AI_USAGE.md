# How AI was used

Sections marked **[YOUR INPUT NEEDED]** can only be answered by the person submitting this work. They have been left blank on purpose. Everything else is a log of what happened during the build.

## Tools

- **Claude Code** (Anthropic's coding agent, in the desktop app), running the Claude Opus 5.5 model. It wrote the code, tests and first drafts of these documents, and ran the checks described below.
- No AI features run inside the app itself.
- No reverse-engineering tools were used. The app, its name and its visual design were built from scratch.

**[YOUR INPUT NEEDED]** Any other AI tools you used (for example, to shape the brief or review the result):

> _Fill in, or write "none"._

## Where AI sped up the work

- **Boilerplate across the stack:** the Express routes, SQLite schema, React pages and CSS were generated in a single pass from one design.
- **Test scaffolding:** a harness with several signed-in users against a real server, plus `.docx` fixtures built in code so no binary files are needed in the repo.
- **Trying failure cases cheaply:** zip bombs, UTF-16 text, renamed binaries, non-ASCII filenames, and deliberately breaking the code to see whether tests noticed.

## AI output that was reviewed, changed or rejected

These are the concrete cases from this build, including the AI's own mistakes.

| What happened | How it was found | What changed |
| --- | --- | --- |
| **Real bug in AI-written config.** TipTap's `StarterKit` was left with its default `trailingNode` extension. It changes a document ending in a list on first interaction, so just clicking would autosave, bump the version, and show view-only users a false "could not save" error. | A failing browser test, once debug logging showed the stored JSON had a stray empty paragraph | Disabled the extension in `shared/schema.ts` and added a browser regression test |
| **AI misdiagnosed that same failure twice.** It first blamed background-tab throttling (logs showed `document.hidden` was false), then a race in the test. The race was real but wasn't the cause of this failure. | Logging the actual server state rather than reasoning further | The race fix was kept since it was a true flaw in the test. A refresh when a tab becomes visible, added during the first wrong theory, was kept because it's useful anyway |
| **Viewers got a false error from the title field.** Clicking away from it sent a rename that the server refused. For editors, it falsely updated "last edited". | Reading the AI's code after the tests passed | Rename only sends when the user can edit and the value changed; regression check added |
| **Back button could trap someone** when a save had failed for good. The first fix for lost-work risk simply refused to navigate. | Reviewing that fix | Replaced with a "Leave without saving?" dialog |
| **Paragraph spacing was silently zero**, from a CSS specificity mistake, and document links were default browser blue. No test could catch these. | Looking at screenshots in a browser | CSS corrected and confirmed by measuring computed styles |
| **`.docx` underline and list coverage.** Underline is off by default in `mammoth`, so a mapping was added. The first tests didn't cover Word's numbered and bulleted lists at all. | Reviewing what the tests actually proved | Added a test with real Word numbering definitions |
| **Import notice came back after refresh** because router state persists in history. | Code review | State is now cleared after first use |
| **Test selector mistake** (a form label's text included its dropdown's options). | Browser test failure | Test fixed; not a product bug |
| **Rejected: Express handlers with a custom `Locals` response type.** More ceremony than value. | Review before the first run | Replaced with a small `currentUser(res)` helper |
| **Rejected: the recommended default of a native SQLite driver.** | Design choice | Used Node's built-in `node:sqlite`, so reviewers have nothing to compile. Trade-off noted in `ARCHITECTURE.md` |

**[YOUR INPUT NEEDED]** Your own review: code you read closely, anything you changed, overruled or would do differently:

> _Fill in._

## How the work was verified

**Automated, and passing at the time of writing:**

- `npm test`: 29 server tests against a real listening server.
- `npm run test:e2e`: 2 browser flows in Microsoft Edge with three signed-in users. They cover formatting, reopening, a blocked unshared user, viewer limits in both UI and API, upgrading a role, a save conflict and its resolution, `.md` and `.docx` import, refusal of other types, an offline retry, and a **hard kill and restart** of the server with formatting and sharing intact.
- `npm run typecheck`: clean.

**Do the tests actually catch bugs?** Eleven guards were broken one at a time and the server tests rerun. Ten were caught, including removing the role check, treating no access as owner, removing the sign-in gate, accepting stale saves, removing the schema check and removing the upload limit. One survived: keeping raw HTML in Markdown doesn't change the output, because the schema also strips it. That guard is a second layer, and no test proves it's needed.

**Checked by driving the running app:** sign-in, library, editor, share dialog and phone-width layout, viewed in a browser. Measured: no horizontal scrolling at 375px. A clean production-only install was started separately and answered health, page, login and document requests.

**Not verified:**

- The Docker image was not built, because the Docker engine wasn't running on this machine. The `Dockerfile`, `fly.toml` and `render.yaml` are untested until the first deploy.
- `.docx` testing used files generated in code that follow the Word format, not files saved by Microsoft Word itself.
- Only Microsoft Edge was tested, so not Firefox or Safari. No screen reader testing.
- Not load tested.

**[YOUR INPUT NEEDED]** Your own manual testing, especially a real Word file and the live deployment:

> _Fill in what you tried and what you saw._

**[YOUR INPUT NEEDED]** Your judgment calls: what you chose to prioritize or cut, and where you agreed or disagreed with the AI:

> _Fill in._
