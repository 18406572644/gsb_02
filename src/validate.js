// Upload validation: real content sniffing (magic bytes), not client-supplied
// mime types. Multer's fileFilter runs before the file is fully written, so we
// only check size there; content is verified after upload from the first bytes.
import { open } from 'node:fs/promises';
import { config } from './config.js';

export class UnsupportedImageError extends Error {
  constructor(message = 'unsupported or unrecognized image format') {
    super(message);
    this.status = 415;
  }
}

const SNIFFERS = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/gif', test: (b) => b.toString('latin1', 0, 3) === 'GIF' },
  {
    mime: 'image/webp',
    test: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
  {
    mime: 'image/avif',
    test: (b) => b.toString('latin1', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(b.toString('latin1', 8, 12)),
  },
  {
    mime: 'image/tiff',
    test: (b) =>
      (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a),
  },
];

export async function sniffMime(filePath) {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    if (bytesRead < 12) throw new UnsupportedImageError('file too small to be an image');
    const hit = SNIFFERS.find((s) => s.test(buf));
    if (!hit) throw new UnsupportedImageError();
    if (!config.allowedMime.includes(hit.mime)) {
      throw new UnsupportedImageError(`format not allowed: ${hit.mime}`);
    }
    return hit.mime;
  } finally {
    await fh.close();
  }
}

export const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/tiff': 'tif',
};
