// Filesystem storage with free-space guards.
import { mkdirSync, statfsSync } from 'node:fs';
import { rename, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export class DiskFullError extends Error {
  constructor(message = 'insufficient disk space') {
    super(message);
    this.code = 'ENOSPC';
    this.status = 507;
  }
}

export const paths = {
  tmp: path.join(config.dataDir, 'tmp'),
  storage: path.join(config.dataDir, 'storage'),
  taskDir: (taskId) => path.join(config.dataDir, 'storage', taskId),
};

export function ensureDirs() {
  for (const dir of [paths.tmp, paths.storage]) mkdirSync(dir, { recursive: true });
}

export function freeBytes(dir = paths.storage) {
  return statfsSync(dir).bavail * statfsSync(dir).bsize;
}

// Throw DiskFullError unless at least `needed` bytes (plus the configured
// safety floor) are available.
export function assertDiskSpace(needed = 0) {
  if (freeBytes() < needed + config.minFreeDiskBytes) {
    throw new DiskFullError(
      `free disk below threshold (need ${needed} + floor ${config.minFreeDiskBytes}, have ${freeBytes()})`,
    );
  }
}

// Move an uploaded temp file into its canonical per-task location.
export async function persistUpload(tmpFile, taskId, ext) {
  assertDiskSpace((await stat(tmpFile)).size);
  const dir = paths.taskDir(taskId);
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, `original.${ext}`);
  await rename(tmpFile, dest); // same filesystem: tmp and storage both live under DATA_DIR
  return dest;
}

export async function variantPath(taskId, filename) {
  const dir = paths.taskDir(taskId);
  await mkdir(dir, { recursive: true });
  return path.join(dir, filename);
}
