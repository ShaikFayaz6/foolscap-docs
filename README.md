# Foolscap

A small document editor: write with rich text, import existing files, and share pages with other people. Built as a timeboxed exercise, so it does a few things properly rather than many things partly.

**Live demo:** _not deployed yet (see [Deploying](#deploying))._

## What it does

- **Documents.** Create, rename, edit, reopen. Bold, italic, underline, three heading levels, bulleted and numbered lists. Changes save on their own, with visible save state and Ctrl+S to save right away.
- **Import.** Upload **`.txt`, `.md` or `.docx`, up to 2 MB**, and it opens as a new editable document. Other types are refused with a message saying what is supported. Images are left out and tables are flattened; the editor tells you when that happened.
- **Sharing.** Each document has one owner, who can grant **Can edit** or **Can view** by email and change or remove access later. The library marks each document as yours or as shared by someone else. The server enforces all of this.
- **Persistence.** Documents, sharing and sign-in sessions live in SQLite and survive refreshes and server restarts.

## Try it

Sign in with a seeded account from the login page. All use the password `foolscap-demo`.

| Account | Starts with |
| --- | --- |
| `avery@foolscap.test` | Owns "Welcome to Foolscap" |
| `blake@foolscap.test` | Can edit "Welcome to Foolscap" |
| `casey@foolscap.test` | Nothing shared |

To see sharing between people, use a second browser or a private window for the other account.

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

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `data/foolscap.db` | SQLite file location |

## Tests

```bash
npm test
```

Runs the server tests against a real listening server: access control on every route, sharing, stale-save rejection, content validation, file import and persistence.

```bash
npm run typecheck
```

The browser test drives two flows end to end with several signed-in users, and includes a hard server kill and restart. Install a browser for it once:

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

To use an installed browser instead, set `PW_CHANNEL` first. In PowerShell, for Microsoft Edge: `$env:PW_CHANNEL='msedge'`.

## Deploying

The repo includes a `Dockerfile`, `fly.toml` and `render.yaml`. SQLite needs a **persistent disk** mounted at `/data`, and exactly one running instance.

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

**Render:** push the repo to GitHub, then create a Blueprint from `render.yaml`.

**Any other Docker host:** build the image and mount a persistent volume at `/data`.

## Known limits

- Sharing is role-based, not real-time co-editing. Open pages pick up others' saved changes within about 8 seconds, and conflicting saves are stopped and explained.
- The demo accounts are public on purpose. There is no sign-up, password reset or login rate limit, so don't store anything private.
- No images, tables or links in documents. No version history. Deleting a document is permanent.
- A `.docx` keeps headings, bold, italic, underline and lists. Fonts, colours and page layout are dropped.

See [ARCHITECTURE.md](ARCHITECTURE.md) for what was prioritized and why, and [AI_USAGE.md](AI_USAGE.md) for how AI was used.
