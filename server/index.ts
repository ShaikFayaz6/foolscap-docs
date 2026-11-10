import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { createApp } from './app.ts';
import { DEMO_ACCOUNTS } from './demo.ts';
import { PresenceHub } from './presence.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
const logger = pino({ level: config.logLevel });
const databasePath = resolve(config.databasePath ?? join(root, 'data', 'foolscap.db'));

const db = openDatabase(databasePath, { seedDemoAccounts: config.seedDemoAccounts, demoPassword: config.demoPassword });
const hub = new PresenceHub(db);
const app = createApp(db, {
  staticDir: join(root, 'dist'),
  live: hub,
  logger,
  trustProxy: config.trustProxy,
  isProduction: config.isProduction,
  demo: config.seedDemoAccounts ? { password: config.demoPassword, accounts: [...DEMO_ACCOUNTS] } : null,
});
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, databasePath }, 'Foolscap listening');
});
hub.attach(server);

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down');
  hub.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
