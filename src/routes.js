import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { AppError } from './errors.js';
import { requireCap } from './auth.js';
import { audit, auditTrail } from './audit.js';
import * as repo from './repo.js';
import { dirs, ensureFreeSpace, freeDiskBytes, originalPath } from './storage.js';
import { validateUpload, EXT_BY_MIME } from './validate.js';
import { bus } from './queue.js';

const upload = multer({
  storage: multer.diskStorage({
    destination: dirs.tmp,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.part`),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

function serializeTask(t) {
  return {
    taskId: t.id,
    status: t.status,
    progress: t.progress,
    stage: t.stage,
    attempts: t.attempts,
    maxAttempts: t.max_attempts,
    error: t.error ? { kind: t.error_kind, message: t.error } : null,
    image:
      t.status === 'completed'
        ? {
            width: t.width,
            height: t.height,
            outputUrl: `/images/${t.id}/output`,
            thumbUrl: `/images/${t.id}/thumb`,
            originalUrl: `/images/${t.id}/original`,
          }
        : null,
    statusUrl: `/tasks/${t.id}`,
    eventsUrl: `/tasks/${t.id}/events`,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

const TERMINAL = new Set(['completed', 'failed']);

export function createRouter({ queue, processTask }) {
  const router = express.Router();

  router.get('/health', async (req, res) => {
    res.json({
      status: 'ok',
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      memoryLimitMb: config.memoryLimitMb,
      queue: queue.stats(),
      freeDiskMb: Math.round((await freeDiskBytes()) / 1048576),
    });
  });

  // 上传:小图同步处理,大图异步排队
  router.post('/images', requireCap('upload'), upload.single('file'), async (req, res, next) => {
    const tmpPath = req.file?.path;
    try {
      if (!req.file) throw new AppError(400, 'validation', '缺少文件字段 file');
      await ensureFreeSpace(req.file.size * 3);
      const { mime, width, height } = await validateUpload(tmpPath);

      const id = crypto.randomUUID();
      const dest = originalPath(id, EXT_BY_MIME[mime]);
      await fs.rename(tmpPath, dest);

      const task = await repo.createTask({
        id,
        originalPath: dest,
        originalName: req.file.originalname || 'unnamed',
        mime,
        sizeBytes: req.file.size,
        width,
        height,
        maxAttempts: config.maxAttempts,
        createdBy: req.auth.key,
      });
      const sync = req.file.size <= config.syncMaxBytes && queue.memoryOk();
      await audit(
        id,
        'created',
        { name: task.original_name, mime, sizeBytes: task.size_bytes, width, height, mode: sync ? 'sync' : 'async' },
        req.auth.key,
      );

      if (sync) {
        await processTask(id);
        const done = await repo.getTask(id);
        return res.status(done.status === 'completed' ? 200 : 500).json(serializeTask(done));
      }
      queue.enqueue(id);
      return res.status(202).json(serializeTask(await repo.getTask(id)));
    } catch (err) {
      if (tmpPath) await fs.unlink(tmpPath).catch(() => {});
      return next(err);
    }
  });

  router.get('/tasks/:id', requireCap('view'), async (req, res, next) => {
    try {
      const task = await repo.getTask(req.params.id);
      if (!task) throw new AppError(404, 'not_found', '任务不存在');
      res.json(serializeTask(task));
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id/audit', requireCap('view'), async (req, res, next) => {
    try {
      const task = await repo.getTask(req.params.id);
      if (!task) throw new AppError(404, 'not_found', '任务不存在');
      res.json({ taskId: task.id, records: await auditTrail(task.id) });
    } catch (err) {
      next(err);
    }
  });

  // SSE 进度上报:连接即推送当前快照,终态后自动关闭
  router.get('/tasks/:id/events', requireCap('view'), async (req, res, next) => {
    try {
      const task = await repo.getTask(req.params.id);
      if (!task) throw new AppError(404, 'not_found', '任务不存在');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ taskId: task.id, status: task.status, progress: task.progress, stage: task.stage });
      if (TERMINAL.has(task.status)) return res.end();

      const channel = `task:${task.id}`;
      const listener = (payload) => {
        send(payload);
        if (TERMINAL.has(payload.status)) {
          cleanup();
          res.end();
        }
      };
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      const cleanup = () => {
        bus.off(channel, listener);
        clearInterval(heartbeat);
      };
      bus.on(channel, listener);
      req.on('close', cleanup);
    } catch (err) {
      next(err);
    }
  });

  // 人工重试失败任务;超过 max_attempts 需 admin 强制
  router.post('/tasks/:id/retry', requireCap('upload'), async (req, res, next) => {
    try {
      const task = await repo.getTask(req.params.id);
      if (!task) throw new AppError(404, 'not_found', '任务不存在');
      if (task.status !== 'failed') {
        throw new AppError(409, 'conflict', `仅失败任务可重试,当前状态:${task.status}`);
      }
      if (task.attempts >= task.max_attempts && req.auth.role !== 'admin') {
        throw new AppError(429, 'retry_exhausted', `已达最大尝试次数 ${task.max_attempts},需 admin 强制重试`);
      }
      await repo.resetForRetry(task.id);
      await audit(task.id, 'retried', { attempt: task.attempts + 1, forced: task.attempts >= task.max_attempts }, req.auth.key);
      queue.enqueue(task.id);
      res.status(202).json({ taskId: task.id, status: 'queued' });
    } catch (err) {
      next(err);
    }
  });

  // 图片查看(view 权限),不走静态目录,逐个鉴权
  const sendImage = (kind) => async (req, res, next) => {
    try {
      const task = await repo.getTask(req.params.id);
      if (!task) throw new AppError(404, 'not_found', '任务不存在');
      const file = kind === 'original' ? task.original_path : kind === 'output' ? task.output_path : task.thumb_path;
      if (!file) throw new AppError(409, 'not_ready', `任务尚未完成,当前状态:${task.status}`);
      // dotfiles:'allow' — 存储目录可能位于隐藏目录(如 .smoke)下,否则 send 会 404
      res.sendFile(path.resolve(file), { dotfiles: 'allow' });
    } catch (err) {
      next(err);
    }
  };
  router.get('/images/:id/original', requireCap('view'), sendImage('original'));
  router.get('/images/:id/output', requireCap('view'), sendImage('output'));
  router.get('/images/:id/thumb', requireCap('view'), sendImage('thumb'));

  return router;
}
