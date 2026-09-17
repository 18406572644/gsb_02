import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { AppError } from './errors.js';

export const dirs = {
  tmp: path.join(config.storageDir, 'tmp'),
  originals: path.join(config.storageDir, 'originals'),
  outputs: path.join(config.storageDir, 'outputs'),
};

export async function initStorage() {
  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });
}

export async function freeDiskBytes() {
  const st = await fs.statfs(config.storageDir);
  return st.bavail * st.bsize;
}

// 写入前检查:可用空间必须覆盖预计产出并保留水位线,否则抛 507 disk_full
export async function ensureFreeSpace(neededBytes) {
  const free = await freeDiskBytes();
  if (free < neededBytes + config.minFreeDiskBytes) {
    throw new AppError(
      507,
      'disk_full',
      `磁盘空间不足:需要约 ${(neededBytes / 1048576).toFixed(1)}MB,` +
        `可用 ${(free / 1048576).toFixed(1)}MB(水位线 ${(config.minFreeDiskBytes / 1048576).toFixed(0)}MB)`,
    );
  }
  return free;
}

export const originalPath = (id, ext) => path.join(dirs.originals, `${id}${ext}`);
export const outputPath = (id) => path.join(dirs.outputs, `${id}.webp`);
export const thumbPath = (id) => path.join(dirs.outputs, `${id}_thumb.webp`);
