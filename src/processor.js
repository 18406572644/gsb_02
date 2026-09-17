import fs from 'node:fs/promises';
import sharp from 'sharp';
import { config } from './config.js';
import { audit } from './audit.js';
import * as repo from './repo.js';
import { emitProgress } from './queue.js';
import { classifyProcessingError, isRetryable } from './errors.js';
import { ensureFreeSpace, outputPath, thumbPath } from './storage.js';

// 限制 libvips 缓存,配合队列的 RSS 闸门共同控制内存
sharp.cache({ memory: 64, files: 0, items: 0 });

export function createProcessor(queue) {
  return async function processTask(taskId) {
    const task = await repo.getTask(taskId);
    if (!task || task.status === 'completed') return null;

    const running = await repo.markProcessing(taskId);
    await audit(taskId, 'processing_started', { attempt: running.attempts });
    emitProgress(taskId, { status: 'processing', progress: 5, stage: 'started', attempt: running.attempts });

    try {
      // 预估产出 ≈ 原图 2 倍,提前检查磁盘水位
      await ensureFreeSpace(task.size_bytes * 2);

      emitProgress(taskId, { status: 'processing', progress: 15, stage: 'metadata' });
      const pipeline = sharp(task.original_path, { limitInputPixels: config.maxPixels });
      const meta = await pipeline.metadata();

      emitProgress(taskId, { status: 'processing', progress: 30, stage: 'transcode' });
      const outPath = outputPath(taskId);
      await pipeline.rotate().webp({ quality: config.webpQuality }).toFile(outPath);

      emitProgress(taskId, { status: 'processing', progress: 75, stage: 'thumbnail' });
      const tPath = thumbPath(taskId);
      await sharp(task.original_path, { limitInputPixels: config.maxPixels })
        .rotate()
        .resize({ width: config.thumbWidth, withoutEnlargement: true })
        .webp({ quality: 70 })
        .toFile(tPath);

      const [outStat, thumbStat] = await Promise.all([fs.stat(outPath), fs.stat(tPath)]);
      const done = await repo.markCompleted(taskId, {
        width: meta.width,
        height: meta.height,
        outputPath: outPath,
        thumbPath: tPath,
      });
      await audit(taskId, 'completed', {
        width: meta.width,
        height: meta.height,
        outputBytes: outStat.size,
        thumbBytes: thumbStat.size,
      });
      emitProgress(taskId, { status: 'completed', progress: 100, stage: 'done' });
      return done;
    } catch (err) {
      const kind = err.kind || classifyProcessingError(err);
      const attempts = running.attempts;
      const retryable = isRetryable(kind) && attempts < config.maxAttempts;

      if (retryable) {
        // 指数退避自动重试(OOM / 磁盘不足等瞬时故障)
        const delayMs = config.retryBaseDelayMs * 2 ** (attempts - 1);
        await repo.scheduleRetry(taskId, kind, err.message);
        await audit(taskId, 'retry_scheduled', { attempt: attempts, kind, error: err.message, delayMs });
        emitProgress(taskId, { status: 'queued', progress: 0, stage: 'retry_wait', attempt: attempts, errorKind: kind });
        queue.enqueue(taskId, delayMs);
      } else {
        await repo.markFailed(taskId, kind, err.message);
        await audit(taskId, 'failed', { attempt: attempts, kind, error: err.message });
        emitProgress(taskId, { status: 'failed', progress: 0, stage: 'failed', errorKind: kind, error: err.message });
      }
      queue.notifyFailure(kind);
      return null;
    }
  };
}
