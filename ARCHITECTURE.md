# Architecture

## Shape

One Node process serves a JSON API and the built React app. One SQLite file holds everything.

```
client/   React + TipTap: library, editor, share dialog, autosave
shared/   document schema, limits, API types (used by both sides)
server/   Express API, access control, import pipeline, SQLite
e2e/      Playwright flow across several users and a server restart
```

## What was prioritized, and why

The brief named five areas. Within the timebox I ranked them by what would most damage trust if it were wrong.

1. **Access control the server actually enforces.** A sharing feature that only hides buttons is worse than none. This got the most test effort.
2. **Never silently losing someone's writing.** An editor's core promise. Serialized autosave, a visible save state, retry when offline, and a version check that stops one person overwriting another.
3. **Import that fails helpfully.** Bad files are normal input, so each failure has its own message.
4. **Polish on the main path only.** Empty, loading and error states, a distinct visual identity and a usable phone layout. No polish on features that don't exist yet.

### Deliberately left out

| Left out | Why | Instead |
| --- | --- | --- |
| Real-time co-editing | CRDT sync, presence and a websocket tier would consume the whole timebox and put the core at risk | Roles, plus version checks and light polling |
| Sign-up and password reset | Accounts aren't what's being evaluated | Seeded users with real sessions and hashed passwords |
| Images, tables, links in documents | Each needs storage or UI and a safety policy | The importer reports what it dropped |
| Version history, comments, search | Valuable, but additive | Natural next steps |

## Key decisions

**One schema, used three ways.** `shared/schema.ts` defines the document. The editor renders with it, the API validates every save against it using ProseMirror's own checks, and the importer converts into it. A hand-crafted request cannot store something the editor would crash on, and the three can't drift apart.

**Documents are stored as the editor's JSON**, not HTML. It's lossless for formatting, it needs no HTML sanitizing on read, and it's what the schema validates.

**SQLite, through Node's built-in `node:sqlite`.** One writer and modest data fit SQLite well, setup for reviewers is zero, and backups are one file. The built-in driver avoids compiling a native module. The cost is that it runs on a single instance and needs a persistent disk, which constrains hosting. `node:sqlite` is also newer than the established drivers. If this needed several instances, Postgres would replace `server/db.ts` and the SQL in `server/app.ts`.

**Access is decided in one place.** Every `/documents/:id` route passes through `requireRole` in `server/app.ts`. People with no access get a 404, so a document's existence isn't revealed. People with too little access get a 403. The roles are ordered: viewer, editor, owner. Editors can change content and titles; only the owner can share or delete.

**Saving uses optimistic versioning.** Each content save sends the version it was based on. The check and the write are a single `UPDATE ... WHERE version = ?`, so two saves can't both win. A stale save returns 409, and the editor asks the person to load the other version or replace it with theirs, rather than merging or overwriting silently. Titles are versioned separately so renaming never causes a content conflict.

**Autosave is a small state machine** (`client/lib/useAutosave.ts`). One request runs at a time and later edits follow it. Network and 5xx failures retry with backoff. Failures that retrying can't fix (conflict, lost access, signed out, rejected content) stop saving and explain why. Leaving with unsaved work warns first.

**Polling, labelled as polling.** An open document checks for changes every 8 seconds and when its tab becomes visible. If there are no local edits, it applies the newer version and notes who changed it. It also picks up role changes and revoked access. This is cheap and honest, but it's not co-editing.

**Import pipeline.** The server checks the extension and the actual content: a `.docx` must be a real Word zip, and text must not be binary. `.txt` is built directly as JSON. `.md` goes through `marked` with raw HTML removed, and `.docx` through `mammoth`, then both are converted to schema JSON with TipTap's HTML parser. The result goes through the same validator as a normal save. A `.docx` whose archive claims to expand past 50 MB is refused before anything is inflated.

## Security notes

- Passwords are hashed with scrypt. Session tokens are random and stored only as hashes.
- Cookies are `HttpOnly` and `SameSite=Lax`, and `Secure` over HTTPS. `SameSite` is the CSRF defence.
- Helmet sets a Content-Security-Policy.
- Known gaps, acceptable for a public demo with no private data: no login rate limiting, and the zip check trusts sizes in the archive's headers.

## What I'd do next

Version history (the version column is already there), links, then real-time editing with Yjs, which would replace the version check and polling. Moving to Postgres would come along with running more than one instance.
