import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const num = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`环境变量 ${name} 必须是数字,当前值: ${v}`);
  return n;
};

export const config = {
  root: ROOT,
  port: num('PORT', 3000),

  storageDir: process.env.STORAGE_DIR || path.join(ROOT, 'storage'),
  pgDataDir: process.env.PG_DATA_DIR || path.join(ROOT, 'data', 'pg'),

  // 资源控制
  workerConcurrency: num('WORKER_CONCURRENCY', 2), // 同时处理的任务数上限
  memoryLimitMb: num('MEMORY_LIMIT_MB', 1024), // 进程 RSS 上限(含 PGlite WASM 基线 ~350MB),超过则暂停派发新任务
  minFreeDiskBytes: num('MIN_FREE_DISK_BYTES', 200 * 1024 * 1024), // 磁盘水位线

  // 上传与处理边界
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 50 * 1024 * 1024),
  syncMaxBytes: num('SYNC_MAX_BYTES', 512 * 1024), // 小于该值同步处理,否则异步排队
  maxPixels: num('MAX_PIXELS', 40_000_000), // 像素上限,防解压炸弹

  // 输出
  thumbWidth: num('THUMB_WIDTH', 256),
  webpQuality: num('WEBP_QUALITY', 82),

  // 重试
  maxAttempts: num('MAX_ATTEMPTS', 3),
  retryBaseDelayMs: num('RETRY_BASE_DELAY_MS', 2000),

  // 初始 API Key(仅当 api_keys 表为空时写入,生产环境务必用环境变量覆盖)
  seedKeys: {
    uploader: process.env.UPLOADER_KEY || 'dev-upload-key',
    viewer: process.env.VIEWER_KEY || 'dev-view-key',
    admin: process.env.ADMIN_KEY || 'dev-admin-key',
  },
};

config.memoryLimitBytes = config.memoryLimitMb * 1024 * 1024;
