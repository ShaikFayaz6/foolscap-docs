# Architecture

## Shape

One Node process serves the JSON API, the WebSocket endpoint and the built React app. One SQLite file holds everything.

```
client/   React + TipTap: documents page, editor, autosave, comments, history, presence
shared/   document schema, limits, comment anchors, API types (used by both sides)
server/   Express API, access control, import, export, presence hub, SQLite migrations
e2e/      Playwright flows with several users and server restarts
samples/  test files for import, and a testing script for three people
```

## What I prioritized, and why

I ranked the work by what would hurt trust the most if it went wrong.

1. **Access control that the server actually enforces.** Sharing that only hides buttons is worse than no sharing at all.
2. **Never losing someone's writing.** Autosave that runs one save at a time, a visible save state, retries when offline, a version check, and history that a restore can't destroy.
3. **Bad or hostile input.** Broken files are normal input. Each failure gets its own message, and everything imported or pasted is reduced to the document schema.
4. **Then the features, in this order:** roles, version history, comments, export, presence. I finished, tested and committed each one before starting the next.
5. **Polish on the main path.** Empty, loading and error states, a clear visual identity and a layout that works on a phone.

How I reached these decisions, including which ones the AI proposed and I approved, is in [AI_USAGE.md](AI_USAGE.md).

## How each production pattern is handled

### Server-side permission checks

Every `/documents/:id` route goes through `requireRole`. `server/access.ts` is the only place a role is worked out, for both HTTP and WebSocket. Someone with no access gets a 404, so they can't even tell the document exists. Someone with too little access gets a 403. `server/test/permissions.test.ts` runs every route as every role, as a stranger and as an anonymous caller.

Comment and version lookups are scoped to the document in the URL. You can't reach a comment or version from another document through one you have access to.

### Autosave

Autosave is a small state machine (`client/lib/useAutosave.ts`) with visible Saving, Saved and Save failed states. Only one save runs at a time, and later edits follow it. Network errors and 5xx errors retry with backoff. Errors that retrying won't fix (a conflict, lost access, being signed out, rejected content) stop saving and explain why. Leaving the page with unsaved work warns first, including through Home and Sign out.

### Optimistic concurrency

Every save sends the version it was based on. The check and the write happen in one `BEGIN IMMEDIATE` transaction, so two saves can't both pass. A stale save gets a 409 `version_conflict`, and the editor asks the person to either load the other version or replace it with theirs. Renaming doesn't change the content version, so it never causes a content conflict.

### Sanitizing imports and pastes

The server checks the type and size of uploads. Following OWASP's file upload guidance, I allowlist the extension, ignore the browser's Content-Type and check the actual content: a `.docx` must be a real Word zip, and a text file must not be binary. OWASP also says signature checks alone aren't enough and that archives need a limit after decompression, so a `.docx` that claims to expand past 50 MB is refused. Uploads are always converted, never stored as they came in.

`.md` goes through `marked` with raw HTML removed (except bare `u`, `s`, `em` and `strong` tags, which Foolscap's own export writes). `.docx` goes through `mammoth`. Both are parsed against the schema and then go through the same validator as a normal save. Paste uses ProseMirror's schema-based parsing, so anything the schema doesn't define is dropped.

**One schema, used three ways.** `shared/schema.ts` defines the document. The editor renders with it, the API validates every save against it, and the importer converts into it. Documents are stored as the editor's JSON, not HTML, so there's no HTML to sanitize when reading.

### Version history

Autosave runs all the time, so history keeps checkpoints, not keystrokes. It takes a snapshot when a different person starts editing, or after five minutes. Automatic checkpoints are capped at 30 per document. Named versions (up to 50) are never pruned. A restore first snapshots the text it's replacing and then writes a new version, so a restore can itself be undone.

### Comments

Comments are stored separately from the document content. That means a commenter doesn't need write access, and a comment can never cause a save conflict. Each comment keeps the quoted text plus some context on both sides, and is found again by matching those (`shared/anchors.ts`), picking the best match when the same text appears twice. If the text gets rewritten, the comment is kept and marked as detached. Comment bodies are shown as plain text.

### Export

Markdown is written straight from the document tree. Markdown has no underline, so underline uses `<u>`. Where CommonMark's rules would stop `**` or `*` from working, that span uses the matching HTML tag instead. Round-trip tests export each construct and import it back. PDF is generated on the server with PDFKit and bundled fonts, so it doesn't depend on the browser. Tests read the PDF back with `pdf.js` and check sizes, fonts, underline and page breaks. A roughly 1 MB document took about 0.3 seconds, and the single process is busy during that time, so PDF export is rate limited per person.

### Real-time presence

`server/presence.ts` runs a WebSocket endpoint at `/api/documents/:id/live`. Browsers send cookies on WebSocket upgrades from any site, so I check the origin by hand before checking the session and role. Messages are limited to 1 KB and validated, with rate limits per connection and connection caps per document and per person. A heartbeat removes dead connections and rechecks access. Removing someone's access closes their socket straight away.

The socket only carries presence and "something changed" notices. It never carries document content, and saving never depends on it. Clients fetch changes through the normal permission-checked API. If the socket drops, they reconnect with backoff and poll every 8 seconds in the meantime (every 30 seconds while connected, as a safety net).

### Why I left out Yjs co-editing

Yjs was the last item on my list, and I didn't build it. It would fit technically: CRDT shared types, providers that don't care about the network, and a ProseMirror binding. But adding it properly changes the core rather than extending it. Saving, the version check, history and comment anchors all assume one saved document is the source of truth, and the save path has the most tests in the project. Replacing that late would put the most trusted part at risk for a feature that was optional.

Other approaches I looked at:

- **Central-authority step rebasing** (ProseMirror's collab module) rejects out-of-date steps and has the client rebase. It's the closest to my design and would be the natural next step.
- **Figma's model** is server-authoritative and CRDT-inspired, with last-writer-wins per property. Their reason for avoiding operational transformation, that it was more complex than their problem needed, made sense to me, but last-writer-wins per property suits design objects better than running text.
- **Etherpad** shows the far end of this: per-keystroke authorship and full revision history. That's well beyond what this needed.

I also didn't build **suggestion mode**, which was a stretch goal.

## User interface

I wanted it to feel like a finished product, not a demo. Every signed-in page has the same header: the logo, a Home button, and an account menu with your name, email and Sign out. The editor bar uses icon buttons, has a breadcrumb back to your documents, and on a phone moves Comments, History and Export into a "⋯" menu. The documents page has search, sorting, file icons, owner avatars and illustrated empty states. Downloads and deletes confirm with a small toast, and pages show grey loading placeholders instead of plain "Loading…" text. Spacing, heights and corner sizes come from one set of CSS variables so things line up. Each person keeps the same avatar colour everywhere, including their live cursor.

## Hosting

I picked **Railway**. It builds from the Dockerfile, redeploys on every push to `main`, and supports a persistent volume, which SQLite needs. The volume is mounted at `/data`, and the service runs as a single instance. The first deploy had no volume, so data was wiped on every deploy. Adding the volume at `/data` fixed that.

## What "production level" means here

**In place:**
- scrypt password hashing, and random session tokens stored only as hashes
- `HttpOnly`, `SameSite=Lax` cookies, `Secure` over HTTPS
- cross-site request protection (a required custom header plus an origin check, on top of `SameSite`)
- a Content-Security-Policy and other security headers, with HSTS in production
- rate limits on failed logins, uploads and exports
- Zod validation on all request input
- ordered database migrations
- one error shape everywhere (`{ error: { code, message } }`)
- structured JSON logs with request ids and no document content or credentials
- a health endpoint that checks the database
- settings through validated environment variables
- CI running lint, typecheck and all tests

**Not in place, and needed before real use with real data:**

- **No load testing.** I don't know the capacity.
- **One process, one SQLite file.** No horizontal scaling or failover. Rate limits and presence live in memory, so they reset on restart and wouldn't work across instances. Scaling out would mean Postgres in place of `server/db.ts` and a shared message bus for presence.
- **No backups or point-in-time recovery.** The database is one file on one volume.
- **No monitoring or alerting.** Logs go to stdout and nothing watches them.
- **No SSO, sign-up, password reset, email verification or 2FA.** There's no admin screen for revoking sessions.
- **PDF generation runs on the main thread.** A worker would be the fix under real load.
- **The zip size check trusts the archive's own headers.** It stops zip bombs that declare their size, but not one that lies about it.
- **No virus scanning of uploads.** Files are converted and thrown away, never stored or served.

**Lint exceptions**, each on purpose:
- Non-null assertions: array access is strictly typed, so these state a checked invariant.
- Control characters in regexes: those patterns exist to strip them.
- Exhaustive effect dependencies: several effects deliberately re-run on a trigger value and use refs.
- Two accessibility rules on the drag-and-drop area and the status text, where the ARIA pattern is intentional.

## Other decisions

**SQLite through Node's built-in `node:sqlite`.** One writer and modest data fit SQLite well, and reviewers have nothing to set up. The built-in driver means no native module to compile. The cost is one instance and a persistent disk, which limits hosting choices.

**What I left out besides co-editing:** sign-up and password reset (accounts aren't what's being assessed), and images, tables and links in documents (each needs storage or UI plus a safety policy; the importer tells you what it dropped).

## Public sources I used

Concepts only. I didn't copy code from any of these.

- [ProseMirror Guide](https://prosemirror.net/docs/guide/): schema content expressions, schema-based parsing, central-authority collaboration.
- [Yjs documentation](https://docs.yjs.dev/): CRDT shared types, providers, editor bindings.
- [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) (Figma blog, 2019).
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).
- [MDN: 409 Conflict](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/409).
- [Etherpad](https://github.com/ether/etherpad) (Apache 2.0) and [Outline](https://github.com/outline/outline) (BSL 1.1): I only read their READMEs for scope and licensing. No code used.

I also opened the Google Drive blog post on conflict resolution in Google Docs, but couldn't extract its article text, so nothing here relies on it.
