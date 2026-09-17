export class AppError extends Error {
  constructor(status, kind, message, cause) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}

// 可自动重试的处理错误类型;corrupt_image / validation 重试无意义,只能人工换文件
const RETRYABLE_KINDS = new Set(['oom', 'disk_full', 'unknown']);

export function isRetryable(kind) {
  return RETRYABLE_KINDS.has(kind);
}

// 把底层异常归类为稳定的错误种类,驱动重试与告警策略
export function classifyProcessingError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = err?.code;
  if (code === 'ENOSPC' || msg.includes('no space left') || msg.includes('enospc')) return 'disk_full';
  if (code === 'ENOMEM' || msg.includes('out of memory') || msg.includes('allocation failed') || msg.includes('enomem')) {
    return 'oom';
  }
  if (
    /vips|spng|unsupported image format|premature end|truncat|corrupt|bad header|invalid|unable to parse|end of stream/.test(msg)
  ) {
    return 'corrupt_image';
  }
  return 'unknown';
}
