# Architecture

## Shape

One Node process serves a JSON API, a WebSocket endpoint and the built React app. One SQLite file holds everything.

```
client/   React + TipTap: library, editor, autosave, comments, history, presence
shared/   document schema, limits, comment anchors, API types (used by both sides)
server/   Express API, access control, import, export, presence hub, SQLite migrations
e2e/      Playwright flows across several users and server restarts
```

## What was prioritized, and why

Ranked by what would most damage trust if it were wrong.

1. **Access control the server actually enforces.** A sharing feature that only hides buttons is worse than none.
2. **Never silently losing someone's writing.** Serialized autosave, a visible save state, retry when offline, a version check, and history that a restore cannot destroy.
3. **Hostile or broken input.** Bad files are normal input, so each failure has its own message, and everything imported or pasted is reduced to the document schema.
4. **Then features, in order:** roles, version history, comments, export, presence. Each was built, tested and committed before the next began.
5. **Polish on the main path only.** Empty, loading and error states, a distinct visual identity and a usable phone layout.

This ordering of production patterns was suggested by the AI and reported as approved by the user through the coordinating session (see `AI_USAGE.md`).

## How each production pattern was handled

### Server-side permission checks

Every `/documents/:id` route passes through `requireRole`, and `server/access.ts` is the one place a role is worked out, for HTTP and WebSocket alike. People with no access get a 404, so a document's existence isn't revealed. People with too little access get a 403. `server/test/permissions.test.ts` runs every route against every role, a stranger and an anonymous caller.

Comment and version lookups are scoped to the document in the URL, so an id from another document can't be reached through one you can access.

### Autosave

A small state machine (`client/lib/useAutosave.ts`) with visible Saving, Saved and Save failed states. One request runs at a time and later edits follow it. Network and 5xx failures retry with backoff. Failures that retrying can't fix (conflict, lost access, signed out, rejected content) stop saving and explain why. Leaving with unsaved work warns first.

### Optimistic concurrency

Each save sends the version it was based on. The check and the write run in one `BEGIN IMMEDIATE` transaction, so two saves can't both pass. A stale save returns 409 `version_conflict` (HTTP 409 means the request conflicts with the resource's current state, and the client may resolve it and resubmit). The editor then asks the person to load the other version or replace it with theirs. Renaming doesn't change the content version, so it never causes a content conflict.

### Sanitizing imports and pastes

Type and size are enforced on the server. Following OWASP's file upload guidance, the extension is allowlisted, the browser's Content-Type is ignored, and the content is checked: a `.docx` must be a real Word zip, and text must not be binary. OWASP also warns that signature checks alone aren't sufficient and that archives must be limited after decompression, so a `.docx` claiming to expand past 50 MB is refused, and everything is converted rather than stored as uploaded.

`.md` goes through `marked` with raw HTML removed (except bare `u`, `s`, `em` and `strong` tags, which Foolscap's own export can write) and `.docx` through `mammoth`. Both are parsed against the schema, then pass the same validator as a normal save. Paste uses ProseMirror's schema-driven parsing, so anything the schema doesn't define is dropped.

**One schema, used three ways.** `shared/schema.ts` defines the document. The editor renders with it, the API validates every save against it, and the importer converts into it. Documents are stored as the editor's JSON, not HTML, so there is no HTML to sanitize on read.

### Version history

Autosave runs constantly, so history keeps checkpoints rather than keystrokes: a snapshot when a different person takes over, or after five minutes. Automatic checkpoints are capped at 30 per document; named versions (up to 50) are never pruned. A restore first snapshots the text it replaces and then writes a new version, so it can itself be undone.

### Comments

Comments live outside document content. A commenter therefore needs no write access and a comment can never cause a save conflict. Each one stores its quoted text with context on either side, and is found again by matching those (`shared/anchors.ts`), choosing the best match when text repeats. If the text is rewritten the comment is kept and marked as detached. Comment bodies are rendered as plain text.

### Export

Markdown is written directly from the document tree. Markdown has no underline, so underline uses `<u>`, and where CommonMark's flanking rules would stop `**` or `*` from applying, that span uses the equivalent HTML tag. Round-trip tests export and re-import each construct. PDF is generated on the server with PDFKit and bundled fonts, so output doesn't depend on the browser. Tests read the output back with `pdf.js` and check sizes, fonts, underline strokes and page flow. A roughly 1 MB document took about 0.3 seconds, during which the single process is busy, so PDF export is rate limited per person.

### Real-time presence

`server/presence.ts` runs a WebSocket endpoint at `/api/documents/:id/live`. Cookies travel on WebSocket upgrades from any site, so the origin is checked by hand before the session and role. Messages are limited to 1 KB and validated, with per-connection rate limits and per-document and per-person connection caps. A heartbeat removes dead connections and rechecks access. Revoking someone's access closes their socket at once.

The socket carries presence and "something changed" notices. It never carries document content, and saving never depends on it. Clients fetch changes through the normal permission-checked API, and if the socket is down they reconnect with backoff and fall back to polling every 8 seconds (30 seconds while connected, as a safety net).

### Why Yjs co-editing was left out

Yjs was the last priority, and it was not built. Its documentation shows it would fit technically: CRDT shared types, network-agnostic providers, and a ProseMirror binding. Adding it properly would change the core rather than extend it. Saving, the version check, history and comment anchoring all assume one authoritative saved document, and the save path has the most tests in the project. Replacing that late would put the most trusted part at risk for a feature that was explicitly optional.

The other approaches considered:

- **Central-authority step rebasing** (ProseMirror's collab module) rejects stale steps and has clients rebase. It is closest to this design and would be the natural next step.
- **Figma's model** is server-authoritative and CRDT-inspired, with last-writer-wins per property. Figma's stated reason for avoiding operational transformation, that it was unnecessarily complex for their problem, carried weight here, but last-writer-wins per property suits design objects better than running text.
- **Etherpad** shows the richer end of this: per-keystroke authorship with a full revision history. That is far beyond what was needed.

**Suggestion mode** was a stretch goal and was also not built.

## Production level: what it does and doesn't mean here

**In place:** scrypt password hashing; random session tokens stored only as hashes; `HttpOnly`, `SameSite=Lax` cookies that are `Secure` over HTTPS; cross-site request protection (a required custom header plus an origin check, on top of `SameSite`); a Content-Security-Policy and other security headers, with HSTS in production; rate limits on failed logins, uploads and exports; Zod validation on all request input; ordered database migrations; a consistent error shape (`{ error: { code, message } }`); structured JSON logs with request ids and no document content or credentials; a health endpoint that checks the database; secrets and settings through validated environment variables; CI running lint, typecheck and all tests.

**Not in place, and required before real use with real data:**

- **No load testing.** Capacity is unknown.
- **One process, one SQLite file.** No horizontal scaling or failover. Rate limits and presence are held in memory, so they reset on restart and wouldn't work across instances. Scaling out would mean Postgres in place of `server/db.ts` and a shared bus for the presence hub.
- **No backups or point-in-time recovery.** The database is a single file on one disk.
- **No monitoring or alerting at scale.** Logs go to stdout and nothing watches them.
- **No SSO, sign-up, password reset, email verification or 2FA.** Sessions don't have an admin revocation screen.
- **PDF generation runs on the main thread.** A worker would be the fix under real load.
- **The zip size check trusts the archive's own headers.** It stops declared zip bombs but not one that lies about its size.
- **No virus scanning of uploads.** Files are converted and discarded, never stored or served.
- **The Docker image and hosted WebSockets haven't been verified**, because nothing has been deployed yet.

**Lint exceptions**, each deliberate: non-null assertions (array access is strictly typed, so these state a checked invariant); control characters in regexes (those patterns exist to strip them); exhaustive effect dependencies (several effects intentionally re-run on a trigger value and use refs); and two accessibility rules on the drag-and-drop area and status text, where the ARIA pattern is intentional.

## Other decisions

**SQLite through Node's built-in `node:sqlite`.** One writer and modest data fit SQLite well, and setup for reviewers is zero. The built-in driver avoids compiling a native module. The cost is a single instance and a persistent disk, which constrains hosting.

**Left out, beyond co-editing:** sign-up and password reset (accounts aren't what's being evaluated), and images, tables and links in documents (each needs storage or UI and a safety policy; the importer reports what it dropped).

## Public sources consulted

Concepts only; no code was copied from any of these.

- [ProseMirror Guide](https://prosemirror.net/docs/guide/): schema content expressions, schema-driven parsing, central-authority collaboration.
- [Yjs documentation](https://docs.yjs.dev/): CRDT shared types, providers, editor bindings.
- [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) (Figma blog, 2019).
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).
- [MDN: 409 Conflict](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/409).
- [Etherpad](https://github.com/ether/etherpad) (Apache 2.0) and [Outline](https://github.com/outline/outline) (BSL 1.1): read at README level for scope and licensing. No code used.

The Google Drive blog post on conflict resolution in Google Docs was also opened, but its article body could not be extracted, so nothing here relies on it.
