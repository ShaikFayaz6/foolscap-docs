import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.ts';
import { createApp } from './app.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const databasePath = resolve(process.env.DATABASE_PATH ?? join(root, 'data', 'foolscap.db'));
const port = Number(process.env.PORT ?? 3000);

const db = openDatabase(databasePath);
const app = createApp(db, { staticDir: join(root, 'dist') });
const server = app.listen(port, () => {
  console.log(`Foolscap listening on http://localhost:${port} (database: ${databasePath})`);
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
