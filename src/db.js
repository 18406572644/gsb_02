// PGlite (embedded Postgres) — single shared instance + schema + tiny helpers.
import { PGlite } from '@electric-sql/pglite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

mkdirSync(path.join(config.dataDir, 'pg'), { recursive: true });

export const db = new PGlite(path.join(config.dataDir, 'pg'));

export async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id         SERIAL PRIMARY KEY,
      key        TEXT UNIQUE NOT NULL,
      name       TEXT NOT NULL,
      scopes     TEXT NOT NULL,              -- comma-separated: upload,view
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      status        TEXT NOT NULL,           -- queued | processing | done | failed
      progress      INT  NOT NULL DEFAULT 0, -- 0..100
      attempts      INT  NOT NULL DEFAULT 0,
      max_attempts  INT  NOT NULL,
      next_retry_at TIMESTAMPTZ,
      original_name TEXT,
      mime          TEXT,
      size_bytes    BIGINT,
      width         INT,
      height        INT,
      input_path    TEXT,
      error         TEXT,
      owner_key_id  INT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_pickup
      ON tasks (status, next_retry_at) WHERE status = 'queued';

    CREATE TABLE IF NOT EXISTS images (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      kind       TEXT NOT NULL,              -- original | web | thumb
      path       TEXT NOT NULL,
      mime       TEXT,
      width      INT,
      height     INT,
      size_bytes BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (task_id, kind)
    );

    -- Audit trail: every state transition / notable event on a task.
    CREATE TABLE IF NOT EXISTS task_events (
      id         BIGSERIAL PRIMARY KEY,
      task_id    TEXT NOT NULL,
      event      TEXT NOT NULL,
      detail     JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id, id);
  `);
}

export async function q(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows;
}

export async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] ?? null;
}

export async function recordEvent(taskId, event, detail = null) {
  await q(
    'INSERT INTO task_events (task_id, event, detail) VALUES ($1, $2, $3::jsonb)',
    [taskId, event, detail === null ? null : JSON.stringify(detail)],
  );
}

export async function touchTask(taskId) {
  await q('UPDATE tasks SET updated_at = now() WHERE id = $1', [taskId]);
}

export async function closeDb() {
  await db.close();
}
