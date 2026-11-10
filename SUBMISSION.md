# Submission: Foolscap

Everything included in this submission.

## Links

| What | Where |
| --- | --- |
| Live app | https://foolscap-docs-production.up.railway.app |
| Source code on GitHub | https://github.com/ShaikFayaz6/foolscap-docs |
| Walkthrough video | The link is in [`WALKTHROUGH_VIDEO.txt`](WALKTHROUGH_VIDEO.txt) |

To sign in on the live app, click one of the demo accounts on the login page (Avery, Blake or Casey). They all use the password `foolscap-demo`. Use a second browser or a private window to sign in as another person and try sharing, comments and presence.

## Documents

| File | What it is |
| --- | --- |
| [`README.md`](README.md) | What the app does, demo accounts, how to set it up and run it locally, tests, deployment, known limits |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Architecture note: what I prioritized and why, how each production pattern is handled, what I left out, hosting |
| [`AI_USAGE.md`](AI_USAGE.md) | AI workflow note: how I used AI, who decided what, mistakes caught, how the work was checked |
| [`SUBMISSION.md`](SUBMISSION.md) | This file |
| [`WALKTHROUGH_VIDEO.txt`](WALKTHROUGH_VIDEO.txt) | Link to the walkthrough video |

## Source code

| Folder or file | What it holds |
| --- | --- |
| `client/` | React and TipTap front end: documents page, editor, autosave, comments, history, presence, styles |
| `server/` | Express API, access control, import, export, WebSocket presence, SQLite database and migrations |
| `server/test/` | 204 server tests |
| `shared/` | Code used by both sides: document schema, limits, comment anchors, API types |
| `e2e/` | 6 Playwright browser tests |
| `public/` | Favicon |
| `samples/` | Test files to import (Word, Markdown, text), files that should be refused, and a testing script for three people |
| `docs/screenshots/` | Screenshots of the app |
| `package.json`, `package-lock.json` | Dependencies and scripts |
| `tsconfig.json`, `vite.config.ts`, `playwright.config.ts`, `biome.json` | TypeScript, build, browser test and lint settings |
| `index.html` | The page the React app loads into |
| `.env.example` | Example local settings |
| `Dockerfile`, `.dockerignore` | Container image used for deployment |
| `railway.json` | Railway deployment settings (what the live app uses) |
| `fly.toml`, `render.yaml` | Alternative deployment settings for Fly.io and Render |
| `.github/workflows/ci.yml` | CI: lint, typecheck, server tests and browser tests on every push |

Not included, because they're generated or local: `node_modules/` (created by `npm install`), `dist/` (created by `npm run build`) and `data/` (the local database, created on first run).

## Screenshots

Setup doesn't need any extra steps (`npm install`, `npm run build`, `npm start`), but I've included screenshots in [`docs/screenshots/`](docs/screenshots):

| File | Shows |
| --- | --- |
| `01-sign-in.png` | Sign-in page with the demo accounts |
| `02-documents.png` | Documents page with search, sort and filters |
| `03-account-menu.png` | Account menu with Sign out |
| `04-editor-export.png` | Editor with the Export menu open |
| `05-presence-and-comments.png` | Another person's live cursor, their avatar in the bar, and a comment |
| `06-empty-state.png` | Documents page for someone with nothing yet |
| `07-phone-editor.png` | Editor on a phone |
| `08-phone-more-menu.png` | The phone "⋯" menu |
| `09-phone-documents.png` | Documents page on a phone |
