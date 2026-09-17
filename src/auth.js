// API-key auth with per-scope authorization.
// Keys are created by src/seed.js (or auto-seeded on first boot) and carry
// comma-separated scopes: "upload" (may POST images / retry) and "view"
// (may read task status, events and image bytes).
import { one } from './db.js';

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function resolveKey(req) {
  const header = req.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) throw new AuthError(401, 'missing bearer token');
  const row = await one('SELECT id, name, scopes FROM api_keys WHERE key = $1', [m[1].trim()]);
  if (!row) throw new AuthError(401, 'invalid api key');
  return { id: row.id, name: row.name, scopes: new Set(row.scopes.split(',')) };
}

export function requireScope(scope) {
  return async (req, _res, next) => {
    try {
      const key = await resolveKey(req);
      if (!key.scopes.has(scope)) {
        throw new AuthError(403, `api key "${key.name}" lacks required scope: ${scope}`);
      }
      req.apiKey = key;
      next();
    } catch (err) {
      next(err);
    }
  };
}
