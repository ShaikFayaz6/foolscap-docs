# Foolscap

A full-stack document editor: write with rich text, import existing files, share pages by role, comment on text, restore earlier versions, export, and see who else is on the page.

**Live demo:** _not deployed yet (see [Deploying](#deploying))._

## What it does

- **Documents.** Create, rename, edit, reopen. Bold, italic, underline, three heading levels, bulleted and numbered lists. Changes save on their own, with a visible save state and Ctrl+S to save right away.
- **Import.** Upload **`.txt`, `.md` or `.docx`, up to 2 MB**, and it opens as a new editable document. Other types are refused with a message saying what is supported. Images are left out and tables are flattened; the editor tells you when that happened.
- **Sharing by role.** Each document has one owner, who can grant **Can edit**, **Can comment** or **Can view** by email, and change or remove that later. The interface adapts to the role, and the server enforces it on every request.
- **Version history.** Automatic checkpoints, plus versions you name. Preview any of them. Restoring creates a new version, so history is never lost.
- **Comments.** Anchored to selected text, with replies and resolve. They survive edits around them, and if the text itself is rewritten the comment stays and says so.
- **Export.** Markdown and PDF, keeping headings, lists and inline formatting.
- **Presence.** See who else has the page open and where their cursor is, over WebSocket. Saves, comments and role changes reach open pages immediately.
- **Persistence.** Everything lives in SQLite and survives refreshes and server restarts.

## Try it

Sign in with a seeded account from the login page. All use the password `foolscap-demo` unless `DEMO_PASSWORD` was set before the database was created.

| Account | Starts with |
| --- | --- |
| `avery@foolscap.test` | Owns "Welcome to Foolscap" |
| `blake@foolscap.test` | Can edit "Welcome to Foolscap" |
| `casey@foolscap.test` | Nothing shared |

To see sharing, comments and presence between people, use a second browser or a private window for the other account.

| Ability | Viewer | Commenter | Editor | Owner |
| --- | :-: | :-: | :-: | :-: |
| Read, export, read comments | Yes | Yes | Yes | Yes |
| Comment and reply | | Yes | Yes | Yes |
| Resolve comments | | Own only | Any | Any |
| Delete comments | | Own only | Own only | Any |
| Edit, rename, use version history | | | Yes | Yes |
| Share, change roles, delete the document | | | | Yes |

## Run it locally

Needs **Node 24 or newer**: the server uses Node's built-in SQLite and runs TypeScript directly, so there is no server build step and no native module to compile.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Then open http://localhost:3000. Data is stored in `data/foolscap.db`; delete that file to start over.

For development with hot reload, run `npm run dev` and open http://localhost:5173.

Settings come from environment variables. For local use, copy `.env.example` to `.env`. The server refuses to start on an invalid value.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `data/foolscap.db` | SQLite file location |
| `LOG_LEVEL` | `info` | Log detail, from `fatal` to `trace`, or `silent` |
| `TRUST_PROXY` | `0` | Reverse proxies in front of the app. The Docker image sets `1` |
| `SEED_DEMO_ACCOUNTS` | `true` | Create the demo accounts when the database is first created |
| `DEMO_PASSWORD` | `foolscap-demo` | Password for those accounts. Has no effect on an existing database |

## Tests

```bash
npm run lint
```

```bash
npm run typecheck
```

```bash
npm test
```

The 204 server tests run against a real listening server: permissions per role on every route, concurrency conflicts, import sanitization, version restore, comments, export, WebSocket presence, cross-site request protection, rate limits and logging.

The 6 browser tests drive the main flows with several signed-in users, and include hard server kills and restarts. Install a browser for them once:

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

To use an installed browser instead, set `PW_CHANNEL` first. In PowerShell, for Microsoft Edge: `$env:PW_CHANNEL='msedge'`.

CI runs all of the above on every push (`.github/workflows/ci.yml`).

## Deploying

The repo includes a `Dockerfile`, `fly.toml` and `render.yaml`. SQLite needs a **persistent disk** mounted at `/data`, and exactly one running instance. `/api/health` is the health check.

**Fly.io** (edit the app name in `fly.toml` first):

```bash
fly launch --copy-config --no-deploy
```

```bash
fly volumes create foolscap_data --size 1 --region iad
```

```bash
fly deploy --ha=false
```

**Railway** (uses `railway.json` and the `Dockerfile`):

1. New Project → Deploy from GitHub repo → pick this repo.
2. Before the first deploy, add a **Volume** to the service mounted at `/data`. Without it, the database is erased on every redeploy.
3. Under Networking, generate a public domain.
4. Optionally set `DEMO_PASSWORD` under Variables. `PORT` is provided by Railway, and `DATABASE_PATH` and `TRUST_PROXY` come from the Docker image.

A service with a volume runs as a single replica, which is what SQLite needs.

**Render:** push the repo to GitHub, then create a Blueprint from `render.yaml`.

**Any other Docker host:** build the image and mount a persistent volume at `/data`.

## Known limits

- Presence is live, but editing is not character-by-character co-editing. Whoever saves first wins, open pages take that save at once if they have no unsaved edits, and a real conflict is stopped and explained.
- The demo accounts are public on purpose. There is no sign-up or password reset, so don't store anything private.
- No images, tables or links in documents. Deleting a document is permanent.
- A `.docx` keeps headings, bold, italic, underline and lists. Fonts, colours and page layout are dropped.
- PDF export uses DejaVu fonts, which have no Chinese, Japanese, Korean or emoji characters. Those appear as empty boxes. Markdown export is unaffected.

See [ARCHITECTURE.md](ARCHITECTURE.md) for what was prioritized and why, and [AI_USAGE.md](AI_USAGE.md) for how AI was used.
