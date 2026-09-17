// Entry point: boot DB, seed keys, start the worker pool, serve HTTP.
import express from 'express';
import { config } from './config.js';
import { initDb, closeDb } from './db.js';
import { ensureDirs } from './storage.js';
import { startQueue, stopQueue } from './queue.js';
import { ensureSeedKeys } from './seed.js';
import { router, errorHandler } from './routes.js';

ensureDirs();
await initDb();
const seeded = await ensureSeedKeys();
if (seeded) {
  console.log('[boot] first run — created dev API keys:');
  for (const k of seeded) console.log(`  ${k.name.padEnd(10)} scopes=${k.scopes.padEnd(12)} ${k.key}`);
}

await startQueue();

const app = express();
app.use(express.json());
app.use(router);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`[boot] image-pipeline listening on :${config.port}`);
});

async function shutdown(signal) {
  console.log(`\n[boot] ${signal} received, shutting down…`);
  server.close();
  await stopQueue(); // let in-flight tasks finish
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
