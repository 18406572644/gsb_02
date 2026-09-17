import express from 'express';
import { config } from './config.js';
import { initDb, db } from './db.js';
import { initStorage } from './storage.js';
import { TaskQueue } from './queue.js';
import { createProcessor } from './processor.js';
import { createRouter } from './routes.js';
import { AppError } from './errors.js';
import * as repo from './repo.js';
import { audit } from './audit.js';

async function main() {
  await initStorage();
  await initDb();

  const queue = new TaskQueue();
  const processTask = createProcessor(queue);
  queue.runJob = processTask;

  // 崩溃恢复:上次中断的 processing 任务一律重新入队
  const { crashed, pending } = await repo.recoverInterrupted();
  for (const id of crashed) await audit(id, 'recovered', { reason: '服务重启,中断任务重新入队' });
  for (const id of pending) queue.enqueue(id);
  if (pending.length) console.log(`[boot] 恢复 ${pending.length} 个未完成任务(其中 ${crashed.length} 个曾被中断)`);

  const app = express();
  app.use(express.json());
  app.use(createRouter({ queue, processTask }));

  app.use((req, res) => res.status(404).json({ error: { kind: 'not_found', message: '路由不存在' } }));

  // 统一错误处理
  app.use((err, req, res, next) => {
    if (err?.name === 'MulterError') {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: { kind: 'validation', message: `上传失败:${err.message}` } });
    }
    const status = err instanceof AppError ? err.status : 500;
    const kind = err instanceof AppError ? err.kind : 'internal';
    if (status >= 500) console.error('[error]', err);
    res.status(status).json({ error: { kind, message: err.message || '内部错误' } });
  });

  const server = app.listen(config.port, () => {
    console.log(`[boot] 图片处理服务已启动: http://localhost:${config.port}`);
    console.log(
      `[boot] 并发=${config.workerConcurrency} 内存上限=${config.memoryLimitMb}MB ` +
        `同步阈值=${(config.syncMaxBytes / 1024).toFixed(0)}KB 像素上限=${config.maxPixels}`,
    );
  });

  const shutdown = async (signal) => {
    console.log(`\n[shutdown] 收到 ${signal},等待运行中任务结束…`);
    server.close();
    const drained = await queue.drain(8000);
    if (!drained) console.warn('[shutdown] 超时,仍有任务在运行(重启后会自动恢复)');
    await db.close();
    process.exit(drained ? 0 : 1);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[boot] 启动失败:', err);
  process.exit(1);
});
