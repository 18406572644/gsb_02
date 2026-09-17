// Central configuration. Every knob is env-overridable.
const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};
const envInt = (name, fallback) => Number.parseInt(env(name, String(fallback)), 10);

export const config = {
  port: envInt('PORT', 3000),

  // Layout on disk: DATA_DIR/{pg,storage,tmp}
  dataDir: env('DATA_DIR', new URL('../data', import.meta.url).pathname),

  // Upload validation
  maxUploadBytes: envInt('MAX_UPLOAD_BYTES', 50 * 1024 * 1024), // hard reject above this
  syncMaxBytes: envInt('SYNC_MAX_BYTES', 2 * 1024 * 1024),      // <= this → processed synchronously
  maxPixels: envInt('MAX_PIXELS', 40_000_000),                  // decompression-bomb guard
  allowedMime: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/tiff'],

  // Output variants
  webMaxDim: envInt('WEB_MAX_DIM', 2048),
  webQuality: envInt('WEB_QUALITY', 82),
  thumbMaxDim: envInt('THUMB_MAX_DIM', 320),
  thumbQuality: envInt('THUMB_QUALITY', 70),

  // Worker pool
  queueConcurrency: envInt('QUEUE_CONCURRENCY', 2),
  maxAttempts: envInt('MAX_ATTEMPTS', 3),
  retryBaseMs: envInt('RETRY_BASE_MS', 2000), // backoff = base * 2^(attempts-1) + jitter

  // Memory guard: stop dequeuing while RSS is above the soft limit
  rssSoftLimitBytes: envInt('RSS_SOFT_LIMIT_MB', 1500) * 1024 * 1024,
  sharpCacheMemoryMb: envInt('SHARP_CACHE_MEMORY_MB', 64),

  // Disk guard: refuse work when free space drops below this
  minFreeDiskBytes: envInt('MIN_FREE_DISK_MB', 200) * 1024 * 1024,
};
