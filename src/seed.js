// API key management. `node src/seed.js` prints (and on first run creates)
// the dev keys. server.js calls ensureSeedKeys() on boot so a fresh checkout
// is usable immediately.
import { randomBytes } from 'node:crypto';
import { initDb, q, closeDb } from './db.js';

const DEV_KEYS = [
  { name: 'uploader', scopes: 'upload' },
  { name: 'viewer', scopes: 'view' },
  { name: 'admin', scopes: 'upload,view' },
];

export async function ensureSeedKeys() {
  await initDb();
  const existing = await q('SELECT count(*)::int AS n FROM api_keys');
  if (existing[0].n > 0) return null; // already seeded
  const created = [];
  for (const k of DEV_KEYS) {
    const key = `img_${k.name}_${randomBytes(16).toString('hex')}`;
    await q('INSERT INTO api_keys (key, name, scopes) VALUES ($1, $2, $3)', [key, k.name, k.scopes]);
    created.push({ ...k, key });
  }
  return created;
}

// CLI: node src/seed.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const created = await ensureSeedKeys();
  const all = await q('SELECT name, scopes, key FROM api_keys ORDER BY id');
  console.log(created ? 'Created dev API keys:' : 'API keys already existed; current keys:');
  for (const row of all) console.log(`  ${row.name.padEnd(10)} scopes=${row.scopes.padEnd(12)} ${row.key}`);
  await closeDb();
}
