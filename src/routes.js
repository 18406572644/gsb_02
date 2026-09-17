// HTTP API.
//   POST /images                 upload (scope: upload) — small images processed
//                                synchronously, large ones queued (202)
//   GET  /tasks/:id              task status + outputs (scope: view)
//   GET  /tasks/:id/events       audit trail (scope: view)
//   GET  /tasks/:id/stream       SSE live progress (scope: view)
//   POST /tasks/:id/retry        requeue a failed task (scope: upload)
//   GET  /images/:taskId/:kind   image bytes, kind = original|web|thumb (scope: view)
//   GET  /health                 queue depth / RSS / free disk (no auth)
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { config } from './config.js';
import { q, one } from './db.js';
import { requireScope } from './auth.js';
import { sniffMime, EXT_BY_MIME } from './validate.js';
import { paths, persistUpload, freeBytes } from './storage.js';
import { createTask, executeTask, retryTask, queueDepth, progressBus } from './queue.js';

const upload = multer({
  dest: paths.tmp,
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

export const router = Router();

const taskView = (task) => task && ({
  id: task.id,
  status: task.status,
  progress: task.progress,
  attempts: task.attempts,
  maxAttempts: task.max_attempts,
  error: task.error,
  originalName: task.original_name,
  mime: task.mime,
  sizeBytes: Number(task.size_bytes),
  width: task.width,
  height: task.height,
  createdAt: task.created_at,
  updatedAt: task.updated_at,
});

async function outputsFor(taskId) {
  const rows = await q('SELECT kind, mime, width, height, size_bytes FROM images WHERE task_id = $1', [taskId]);
  return Object.fromEntries(rows.map((r) => [r.kind, {
    url: `/images/${taskId}/${r.kind}`,
    mime: r.mime, width: r.width, height: r.height, sizeBytes: Number(r.size_bytes),
  }]));
}

// ---- upload -------------------------------------------------------------
router.post('/images', requireScope('upload'), upload.single('file'), async (req, res, next) => {
  const cleanup = () => req.file && unlink(req.file.path).catch(() => {});
  try {
    if (!req.file) return res.status(400).json({ error: 'multipart field "file" is required' });

    const mime = await sniffMime(req.file.path); // throws 415 on junk
    const sizeBytes = req.file.size;
    const sync = sizeBytes <= config.syncMaxBytes;

    // Create the task row first so the upload can be filed under its id.
    const draft = await createTask({
      originalName: req.file.originalname,
      mime, sizeBytes,
      inputPath: null, // filled in below, after the move
      ownerKeyId: req.apiKey.id,
    });
    const inputPath = await persistUpload(req.file.path, draft.id, EXT_BY_MIME[mime]);
    await q('UPDATE tasks SET input_path = $2 WHERE id = $1', [draft.id, inputPath]);
    await q(
      `INSERT INTO images (id, task_id, kind, path, mime, size_bytes)
       VALUES ($1, $2, 'original', $3, $4, $5)`,
      [randomUUID(), draft.id, inputPath, mime, sizeBytes],
    );
    const task = await one('SELECT * FROM tasks WHERE id = $1', [draft.id]);

    if (sync) {
      // Small image: process inline, return the finished result.
      const result = await executeTask(task);
      const fresh = await one('SELECT * FROM tasks WHERE id = $1', [task.id]);
      if (!result.ok) {
        return res.status(422).json({ task: taskView(fresh), error: fresh.error });
      }
      return res.status(201).json({ task: taskView(fresh), outputs: await outputsFor(task.id) });
    }

    // Large image: hand off to the worker pool.
    return res.status(202).json({
      task: taskView(task),
      statusUrl: `/tasks/${task.id}`,
      streamUrl: `/tasks/${task.id}/stream`,
    });
  } catch (err) {
    await cleanup();
    next(err);
  }
});

// ---- task status / audit ------------------------------------------------
router.get('/tasks/:id', requireScope('view'), async (req, res, next) => {
  try {
    const task = await one('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json({ task: taskView(task), outputs: await outputsFor(task.id) });
  } catch (err) { next(err); }
});

router.get('/tasks/:id/events', requireScope('view'), async (req, res, next) => {
  try {
    const events = await q(
      'SELECT id, event, detail, created_at AS "createdAt" FROM task_events WHERE task_id = $1 ORDER BY id',
      [req.params.id],
    );
    res.json({ events });
  } catch (err) { next(err); }
});

// Live progress over SSE. The DB is the source of truth; progressBus just
// pushes updates with low latency.
router.get('/tasks/:id/stream', requireScope('view'), async (req, res, next) => {
  try {
    const task = await one('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'task not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'snapshot', status: task.status, progress: task.progress });

    const listener = (evt) => {
      send(evt);
      if (evt.type === 'done' || evt.type === 'failed') {
        clearInterval(heartbeat);
        progressBus.off(task.id, listener);
        res.end();
      }
    };
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    progressBus.on(task.id, listener);
    req.on('close', () => {
      clearInterval(heartbeat);
      progressBus.off(task.id, listener);
    });
  } catch (err) { next(err); }
});

// ---- retry ---------------------------------------------------------------
router.post('/tasks/:id/retry', requireScope('upload'), async (req, res, next) => {
  try {
    const result = await retryTask(req.params.id);
    if (!result) return res.status(404).json({ error: 'task not found' });
    if (!result.changed) {
      return res.status(409).json({ error: `task is ${result.task.status}, only failed tasks can be retried` });
    }
    res.status(202).json({ task: taskView(result.task) });
  } catch (err) { next(err); }
});

// ---- image bytes -----------------------------------------------------------
router.get('/images/:taskId/:kind', requireScope('view'), async (req, res, next) => {
  try {
    const { taskId, kind } = req.params;
    if (!['original', 'web', 'thumb'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be original|web|thumb' });
    }
    const img = await one('SELECT * FROM images WHERE task_id = $1 AND kind = $2', [taskId, kind]);
    if (!img) return res.status(404).json({ error: 'image variant not found' });
    res.setHeader('Cache-Control', 'private, immutable, max-age=31536000');
    res.type(img.mime ?? 'application/octet-stream');
    res.sendFile(img.path);
  } catch (err) { next(err); }
});

// ---- health ----------------------------------------------------------------
router.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    queueDepth: await queueDepth(),
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
    freeDiskMb: Math.round(freeBytes() / 1e6),
  });
});

// ---- error mapping -----------------------------------------------------------
export function errorHandler(err, _req, res, _next) {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  const status = err.status ?? (err.code === 'ENOSPC' ? 507 : 500);
  if (status >= 500) console.error('[http] error:', err);
  res.status(status).json({ error: err.message, code: err.code });
}
