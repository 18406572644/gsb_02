import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { config } from './config.js';

fs.mkdirSync(config.pgDataDir, { recursive: true });

export const db = new PGlite(config.pgDataDir);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  key        TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('uploader', 'viewer', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id            UUID PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  progress      INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  stage         TEXT,
  original_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  output_path   TEXT,
  thumb_path    TEXT,
  error_kind    TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

CREATE TABLE IF NOT EXISTS audit_records (
  id         BIGSERIAL PRIMARY KEY,
  task_id    UUID REFERENCES tasks(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  detail     JSONB,
  actor      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_records (task_id, id);
`;

export async function initDb() {
  await db.waitReady;
  await db.exec(SCHEMA);

  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM api_keys');
  if (rows[0].n === 0) {
    for (const [role, key] of Object.entries(config.seedKeys)) {
      await db.query('INSERT INTO api_keys (key, role) VALUES ($1, $2) ON CONFLICT DO NOTHING', [key, role]);
    }
    console.log('[db] 已写入初始 API Key(生产环境请用 UPLOADER_KEY/VIEWER_KEY/ADMIN_KEY 覆盖)');
  }
}
