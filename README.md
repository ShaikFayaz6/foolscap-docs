# Foolscap

Foolscap is a document editor I built for this assessment. You can write with rich text, import files you already have, share a page with other people by role, comment on text, go back to earlier versions, export, and see who else is on the page.

**Live app:** https://foolscap-docs-production.up.railway.app

## What you can do in it

- **Write.** Bold, italic, underline, three heading sizes, bullet and numbered lists. It saves on its own and always shows the save state. Ctrl+S saves right away.
- **Import.** `.txt`, `.md` or `.docx`, up to 2 MB. It opens as a new document you can edit. Any other file type is refused with a clear message. Images get left out and tables get flattened, and the editor tells you when that happens.
- **Share by role.** The owner can give someone **Can edit**, **Can comment** or **Can view** by email, and change or remove it later. The screen changes with the role, and the server checks the role on every request.
- **Version history.** Automatic checkpoints, plus versions you can name. You can preview any of them. Restoring creates a new version, so nothing is lost.
- **Comments.** Select text and comment on it. Replies and resolve work. Comments stay attached when the text around them changes.
- **Export.** Markdown or PDF, keeping headings, lists and formatting.
- **Presence.** See who else has the page open and where their cursor is. Saves, comments and role changes show up on open pages straight away.
- **Find things.** Search your documents by title or owner, sort them, and filter to yours or shared with you.
- **Data that stays.** Everything is stored in SQLite and survives refreshes, restarts and redeploys.

## Try it

Sign in on the login page with one of the demo accounts. One click signs you in. They all use the password `foolscap-demo`.

| Account | Starts with |
| --- | --- |
| `avery@foolscap.test` | Owns "Welcome to Foolscap" |
| `blake@foolscap.test` | Can edit "Welcome to Foolscap" |
| `casey@foolscap.test` | Nothing shared yet |

To try sharing, comments and presence between people, open a second browser or a private window and sign in as someone else.

There are test files in [`samples/`](samples/README.md), with a step-by-step script for testing with all three accounts.

| What they can do | Viewer | Commenter | Editor | Owner |
| --- | :-: | :-: | :-: | :-: |
| Read, export, read comments | Yes | Yes | Yes | Yes |
| Comment and reply | | Yes | Yes | Yes |
| Resolve comments | | Own only | Any | Any |
| Delete comments | | Own only | Own only | Any |
| Edit, rename, use version history | | | Yes | Yes |
| Share, change roles, delete the document | | | | Yes |

## Run it locally

You need **Node 24 or newer**. The server uses Node's built-in SQLite and runs TypeScript directly, so there's no separate database to install and nothing to compile for the server.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Then open http://localhost:3000. The data goes in `data/foolscap.db`. Delete that file if you want to start fresh.

For development with hot reload, run `npm run dev` and open http://localhost:5173.

Settings come from environment variables. For local use you can copy `.env.example` to `.env`. The server won't start if a value is invalid.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `data/foolscap.db` | Where the SQLite file lives |
| `LOG_LEVEL` | `info` | Log detail, from `fatal` to `trace`, or `silent` |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the app. The Docker image sets `1` |
| `SEED_DEMO_ACCOUNTS` | `true` | Create the demo accounts when the database is first created |
| `DEMO_PASSWORD` | `foolscap-demo` | Password for those accounts. Only used when the database is created |

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

`npm test` runs 204 server tests against a real running server. They cover permissions for every role on every route, save conflicts, import cleanup, version restore, comments, export, WebSocket presence, cross-site request protection, rate limits and logging.

There are also 6 browser tests that go through the main flows with several signed-in users, including killing and restarting the server. Install a browser for them once:

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

To use a browser you already have instead, set `PW_CHANNEL` first. For Microsoft Edge in PowerShell: `$env:PW_CHANNEL='msedge'`.

GitHub Actions runs all of this on every push (`.github/workflows/ci.yml`).

## Deploying

The live app runs on **Railway**, from the `Dockerfile` and `railway.json` in this repo. SQLite needs a **persistent disk** and **one running instance**, so the setup is:

1. New Project → Deploy from GitHub repo → pick this repo.
2. Add a **Volume** to the service, mounted at `/data`. Without it, the database is wiped on every deploy.
3. Under Networking, generate a public domain.
4. Optionally set `DEMO_PASSWORD` under Variables. Railway provides `PORT`, and the Docker image sets `DATABASE_PATH` and `TRUST_PROXY`.

Railway redeploys on every push to `main`. `/api/health` is the health check.

The repo also has a `fly.toml` and a `render.yaml` if you'd rather use Fly.io or Render. Any Docker host works if you mount a persistent volume at `/data`.

## Known limits

- Presence is live, but two people can't type in the same paragraph at the same time like in Google Docs. Whoever saves first wins. Other open pages pick up that save straight away if they have no unsaved changes, and a real conflict is stopped and explained.
- The demo accounts are public on purpose. There's no sign-up or password reset, so don't put anything private in it.
- No images, tables or links in documents. Deleting a document is permanent.
- A `.docx` keeps headings, bold, italic, underline and lists. Fonts, colours and page layout are dropped.
- PDF export uses DejaVu fonts, which don't have Chinese, Japanese, Korean or emoji characters. Those show as empty boxes in the PDF. Markdown export is fine.

[ARCHITECTURE.md](ARCHITECTURE.md) explains what I prioritized and why. [AI_USAGE.md](AI_USAGE.md) explains how I used AI. [SUBMISSION.md](SUBMISSION.md) lists everything included.
