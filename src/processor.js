// Sharp-based image pipeline: probe → transcode (webp) → thumbnail.
// Memory is bounded three ways: a serial sharp thread pool, a small libvips
// cache, and a pixel-count ceiling that rejects decompression bombs up front.
import sharp from 'sharp';
import { stat } from 'node:fs/promises';
import { config } from './config.js';
import { assertDiskSpace, variantPath } from './storage.js';

sharp.concurrency(1);
sharp.cache({ memory: config.sharpCacheMemoryMb, files: 20, items: 100 });

export class CorruptImageError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}

// Transient errors deserve a retry (with backoff); everything else is permanent.
export function isTransientError(err) {
  if (err?.permanent) return false;
  if (err?.code === 'ENOSPC') return true;
  return /out of memory|allocation failed|cannot allocate|ENOMEM/i.test(err?.message ?? '');
}

async function probe(inputPath) {
  let meta;
  try {
    meta = await sharp(inputPath, { limitInputPixels: config.maxPixels }).metadata();
  } catch (err) {
    if (/limitInputPixels|exceeds pixel limit/i.test(err.message)) {
      throw new CorruptImageError(`image exceeds pixel limit of ${config.maxPixels}: ${err.message}`);
    }
    throw new CorruptImageError(`cannot read image metadata: ${err.message}`);
  }
  if (!meta.width || !meta.height) throw new CorruptImageError('image has no valid dimensions');
  if (meta.width * meta.height > config.maxPixels) {
    throw new CorruptImageError(`image ${meta.width}x${meta.height} exceeds pixel limit of ${config.maxPixels}`);
  }
  return meta;
}

async function renderVariant(inputPath, outputPath, maxDim, quality) {
  assertDiskSpace(config.maxUploadBytes); // worst-case headroom for the encoder output
  try {
    const info = await sharp(inputPath, { limitInputPixels: config.maxPixels })
      .rotate() // honor EXIF orientation, then strip metadata
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toFile(outputPath);
    return info; // { width, height, size, ... }
  } catch (err) {
    if (err.code === 'ENOSPC' || isTransientError(err)) throw err;
    throw new CorruptImageError(`transcode failed: ${err.message}`);
  }
}

/**
 * Run the full pipeline for one task.
 * @param task  row from tasks (needs id, input_path)
 * @param report  async (progress:number, stage:string) => void
 * @returns {{meta, variants: Array<{kind, path, mime, width, height, sizeBytes}>}}
 */
export async function processImage(task, report = async () => {}) {
  const inputPath = task.input_path;

  await report(10, 'probe');
  const meta = await probe(inputPath);

  const variants = [];

  await report(35, 'transcode:web');
  const webPath = await variantPath(task.id, 'web.webp');
  const web = await renderVariant(inputPath, webPath, config.webMaxDim, config.webQuality);
  variants.push({ kind: 'web', path: webPath, mime: 'image/webp', width: web.width, height: web.height, sizeBytes: web.size });

  await report(70, 'transcode:thumb');
  const thumbPath = await variantPath(task.id, 'thumb.webp');
  const thumb = await renderVariant(inputPath, thumbPath, config.thumbMaxDim, config.thumbQuality);
  variants.push({ kind: 'thumb', path: thumbPath, mime: 'image/webp', width: thumb.width, height: thumb.height, sizeBytes: thumb.size });

  await report(90, 'finalize');
  const inputSize = (await stat(inputPath)).size;
  return {
    meta: { width: meta.width, height: meta.height, sizeBytes: inputSize },
    variants,
  };
}
