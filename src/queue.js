// Durable in-process work queue backed by PGlite.
//  - tasks survive restarts (state lives in the tasks table)
//  - bounded concurrency
//  - RSS memory guard: stop dequeuing while the process is over the soft limit
//  - exponential-backoff retries for transient failures (ENOSPC, OOM-ish);
//    permanent failures (corrupt image) go straight to `failed`
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { q, one, recordEvent } from './db.js';
import { processImage, isTransientError } from './processor.js';

// Live progress fan-out for SSE subscribers (DB remains the source of truth).
export const progressBus = new EventEmitter();
progressBus.setMaxListeners(1000);

let running = false;
let active = 0;
let loopTimer = null;
let lastBackpressureLog = 0;

export function queueDepth() {
  return one("SELECT count(*)::int AS n FROM tasks WHERE status = 'queued'").then((r) => r.n);
}

export async function createTask({ originalName, mime, sizeBytes, inputPath, ownerKeyId }) {
  const id = randomUUID();
  await q(
    `INSERT INTO tasks (id, status, max_attempts, original_name, mime, size_bytes, input_path, owner_key_id)
     VALUES ($1, 'queued', $2, $3, $4, $5, $6, $7)`,
    [id, config.maxAttempts, originalName, mime, sizeBytes, inputPath, ownerKeyId ?? null],
  );
  await recordEvent(id, 'created', { originalName, mime, sizeBytes });
  return one('SELECT * FROM tasks WHERE id = $1', [id]);
}

async function setProgress(taskId, progress, stage) {
  await q('UPDATE tasks SET progress = $2, updated_at = now() WHERE id = $1', [taskId, progress]);
  progressBus.emit(taskId, { type: 'progress', progress, stage });
}

async function saveVariants(taskId, meta, variants) {
  await q('UPDATE tasks SET width = $2, height = $3, updated_at = now() WHERE id = $1', [
    taskId, meta.width, meta.height,
  ]);
  for (const v of variants) {
    await q(
      `INSERT INTO images (id, task_id, kind, path, mime, width, height, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (task_id, kind) DO UPDATE SET
         path = EXCLUDED.path, mime = EXCLUDED.mime, width = EXCLUDED.width,
         height = EXCLUDED.height, size_bytes = EXCLUDED.size_bytes`,
      [randomUUID(), taskId, v.kind, v.path, v.mime, v.width, v.height, v.sizeBytes],
    );
  }
}

// Shared by the async worker loop and the synchronous small-image path.
export async function executeTask(task) {
  const startedAt = Date.now();
  await recordEvent(task.id, 'processing_started', { attempt: task.attempts + 1 });
  try {
    const { meta, variants } = await processImage(task, (progress, stage) =>
      setProgress(task.id, progress, stage),
    );
    await saveVariants(task.id, meta, variants);
    await q(
      `UPDATE tasks SET status = 'done', progress = 100, error = NULL,
         next_retry_at = NULL, updated_at = now() WHERE id = $1`,
      [task.id],
    );
    await recordEvent(task.id, 'completed', {
      durationMs: Date.now() - startedAt,
      width: meta.width,
      height: meta.height,
      variants: variants.map((v) => ({ kind: v.kind, sizeBytes: v.sizeBytes })),
    });
    progressBus.emit(task.id, { type: 'done', progress: 100 });
    return { ok: true };
  } catch (err) {
    return handleFailure(task, err, startedAt);
  }
}

async function handleFailure(task, err, startedAt) {
  const attempts = task.attempts + 1;
  const transient = isTransientError(err);

  if (transient && attempts < task.max_attempts) {
    const backoffMs = config.retryBaseMs * 2 ** (attempts - 1) + Math.floor(Math.random() * 500);
    await q(
      `UPDATE tasks SET status = 'queued', attempts = $2, error = $3,
         next_retry_at = now() + ($4 || ' milliseconds')::interval, updated_at = now()
       WHERE id = $1`,
      [task.id, attempts, err.message, String(backoffMs)],
    );
    await recordEvent(task.id, 'retry_scheduled', {
      attempt: attempts, backoffMs, reason: err.message,
    });
    progressBus.emit(task.id, { type: 'retry', attempt: attempts, backoffMs });
  } else {
    await q(
      `UPDATE tasks SET status = 'failed', attempts = $2, error = $3, updated_at = now()
       WHERE id = $1`,
      [task.id, attempts, err.message],
    );
    await recordEvent(task.id, 'failed', {
      attempt: attempts,
      durationMs: Date.now() - startedAt,
      permanent: !transient,
      reason: err.message,
    });
    progressBus.emit(task.id, { type: 'failed', error: err.message });
  }
  return { ok: false, error: err };
}

function memoryHeadroom() {
  return process.memoryUsage().rss < config.rssSoftLimitBytes;
}

async function claimNext() {
  // Single-process queue: atomic claim via UPDATE ... RETURNING.
  const rows = await q(
    `UPDATE tasks SET status = 'processing', updated_at = now()
     WHERE id = (
       SELECT id FROM tasks
       WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= now())
       ORDER BY created_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     ) AND status = 'queued'
     RETURNING *`,
  );
  return rows[0] ?? null;
}

async function tick() {
  if (!running) return;
  try {
    while (active < config.queueConcurrency) {
      if (!memoryHeadroom()) {
        const now = Date.now();
        if (now - lastBackpressureLog > 10_000) {
          lastBackpressureLog = now;
          console.warn(`[queue] RSS ${Math.round(process.memoryUsage().rss / 1e6)}MB over soft limit, pausing dequeue`);
        }
        break;
      }
      const task = await claimNext();
      if (!task) break;
      active += 1;
      executeTask(task)
        .catch((err) => console.error(`[queue] unexpected worker error on ${task.id}:`, err))
        .finally(() => { active -= 1; });
    }
  } catch (err) {
    console.error('[queue] tick error:', err);
  } finally {
    if (running) loopTimer = setTimeout(tick, 250);
  }
}

export async function startQueue() {
  // Crash recovery: anything left in 'processing' by a previous run never
  // finished — put it back on the queue.
  const stranded = await q(
    `UPDATE tasks SET status = 'queued', updated_at = now()
     WHERE status = 'processing' RETURNING id`,
  );
  for (const { id } of stranded) {
    await recordEvent(id, 'requeued_after_restart', {});
  }
  running = true;
  tick();
  console.log(`[queue] started (concurrency=${config.queueConcurrency}, recovered ${stranded.length} stranded task(s))`);
}

export async function stopQueue() {
  running = false;
  if (loopTimer) clearTimeout(loopTimer);
  // Wait for in-flight tasks to finish (graceful shutdown).
  while (active > 0) await new Promise((r) => setTimeout(r, 100));
}

// Manual retry of a failed task: fresh attempt budget, back on the queue.
export async function retryTask(taskId) {
  const task = await one('SELECT * FROM tasks WHERE id = $1', [taskId]);
  if (!task) return null;
  if (task.status !== 'failed') return { task, changed: false };
  await q(
    `UPDATE tasks SET status = 'queued', attempts = 0, progress = 0, error = NULL,
       next_retry_at = NULL, updated_at = now() WHERE id = $1`,
    [taskId],
  );
  await recordEvent(taskId, 'manual_retry', {});
  progressBus.emit(taskId, { type: 'requeued' });
  return { task: await one('SELECT * FROM tasks WHERE id = $1', [taskId]), changed: true };
}
