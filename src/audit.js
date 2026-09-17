import { db } from './db.js';

// 只记录生命周期事件;进度百分比走 tasks.progress + SSE,避免刷爆审计表
export async function audit(taskId, event, detail = null, actor = null) {
  await db.query('INSERT INTO audit_records (task_id, event, detail, actor) VALUES ($1, $2, $3::jsonb, $4)', [
    taskId,
    event,
    detail === null ? null : JSON.stringify(detail),
    actor,
  ]);
}

export async function auditTrail(taskId) {
  const { rows } = await db.query(
    'SELECT id, event, detail, actor, created_at FROM audit_records WHERE task_id = $1 ORDER BY id',
    [taskId],
  );
  return rows;
}
