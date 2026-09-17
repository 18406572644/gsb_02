import { db } from './db.js';

export async function createTask(t) {
  const { rows } = await db.query(
    `INSERT INTO tasks (id, original_path, original_name, mime, size_bytes, width, height, max_attempts, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [t.id, t.originalPath, t.originalName, t.mime, t.sizeBytes, t.width, t.height, t.maxAttempts, t.createdBy],
  );
  return rows[0];
}

export async function getTask(id) {
  const { rows } = await db.query('SELECT * FROM tasks WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function markProcessing(id) {
  const { rows } = await db.query(
    `UPDATE tasks SET status = 'processing', attempts = attempts + 1, progress = 5, stage = 'started',
       error = NULL, error_kind = NULL, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0];
}

export async function markCompleted(id, { width, height, outputPath, thumbPath }) {
  const { rows } = await db.query(
    `UPDATE tasks SET status = 'completed', progress = 100, stage = 'done',
       width = $2, height = $3, output_path = $4, thumb_path = $5, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, width, height, outputPath, thumbPath],
  );
  return rows[0];
}

export async function markFailed(id, kind, message) {
  const { rows } = await db.query(
    `UPDATE tasks SET status = 'failed', stage = 'failed', error_kind = $2, error = $3, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, kind, String(message).slice(0, 500)],
  );
  return rows[0];
}

// 自动重试:回到 queued,由队列按退避延迟再次派发
export async function scheduleRetry(id, kind, message) {
  await db.query(
    `UPDATE tasks SET status = 'queued', stage = 'retry_wait', error_kind = $2, error = $3, updated_at = now()
     WHERE id = $1`,
    [id, kind, String(message).slice(0, 500)],
  );
}

// 人工重试:清零进度,保留 attempts 计数
export async function resetForRetry(id) {
  const { rows } = await db.query(
    `UPDATE tasks SET status = 'queued', progress = 0, stage = 'manual_retry',
       error = NULL, error_kind = NULL, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0];
}

// 服务重启恢复:processing 状态的任务说明上次崩溃在中途,一律回到队列
export async function recoverInterrupted() {
  const crashed = await db.query(
    `UPDATE tasks SET status = 'queued', stage = 'recovered', updated_at = now()
     WHERE status = 'processing' RETURNING id`,
  );
  const queued = await db.query(`SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at`);
  return { crashed: crashed.rows.map((r) => r.id), pending: queued.rows.map((r) => r.id) };
}
