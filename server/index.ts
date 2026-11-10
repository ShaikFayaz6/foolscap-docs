import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.ts';
import { createApp } from './app.ts';
import { PresenceHub } from './presence.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const databasePath = resolve(process.env.DATABASE_PATH ?? join(root, 'data', 'foolscap.db'));
const port = Number(process.env.PORT ?? 3000);

const db = openDatabase(databasePath);
const hub = new PresenceHub(db);
const app = createApp(db, { staticDir: join(root, 'dist'), live: hub });
const server = app.listen(port, () => {
  console.log(`Foolscap listening on http://localhost:${port} (database: ${databasePath})`);
});
hub.attach(server);

function shutdown(): void {
  hub.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
