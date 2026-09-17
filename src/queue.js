import { EventEmitter } from 'node:events';
import { config } from './config.js';

// 任务进度事件总线,SSE 按 taskId 订阅
export const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function emitProgress(taskId, payload) {
  bus.emit(`task:${taskId}`, { taskId, at: new Date().toISOString(), ...payload });
}

export class TaskQueue {
  constructor() {
    this.baseConcurrency = config.workerConcurrency;
    this.effectiveConcurrency = this.baseConcurrency;
    this.pending = [];
    this.running = 0;
    this.stopped = false;
    this.memTimer = null;
    this.cooldownTimer = null;
    this.runJob = null; // 由 server 注入 processor
  }

  get depth() {
    return this.pending.length;
  }

  memoryOk() {
    return process.memoryUsage().rss < config.memoryLimitBytes;
  }

  enqueue(taskId, delayMs = 0) {
    if (this.stopped) return;
    if (delayMs > 0) {
      const t = setTimeout(() => {
        this.pending.push(taskId);
        this.pump();
      }, delayMs);
      t.unref?.();
      return;
    }
    this.pending.push(taskId);
    this.pump();
  }

  // OOM 失败 → 降并发到 1 冷却 30s,避免再次打爆内存
  notifyFailure(kind) {
    if (kind === 'oom' && this.effectiveConcurrency !== 1) {
      this.effectiveConcurrency = 1;
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = setTimeout(() => {
        this.effectiveConcurrency = this.baseConcurrency;
      }, 30_000);
      this.cooldownTimer.unref?.();
    }
  }

  pump() {
    if (this.stopped || !this.runJob) return;
    while (this.running < this.effectiveConcurrency && this.pending.length > 0) {
      if (!this.memoryOk()) {
        // 内存背压:超过上限就暂停派发,1s 后重试
        if (!this.memTimer) {
          this.memTimer = setTimeout(() => {
            this.memTimer = null;
            this.pump();
          }, 1000);
          this.memTimer.unref?.();
        }
        return;
      }
      const taskId = this.pending.shift();
      this.running += 1;
      Promise.resolve()
        .then(() => this.runJob(taskId))
        .catch((err) => console.error(`[queue] 任务 ${taskId} 未捕获异常:`, err))
        .finally(() => {
          this.running -= 1;
          this.pump();
        });
    }
  }

  stats() {
    return { queued: this.pending.length, running: this.running, concurrency: this.effectiveConcurrency };
  }

  async drain(timeoutMs = 8000) {
    this.stopped = true;
    const deadline = Date.now() + timeoutMs;
    while (this.running > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.running === 0;
  }
}
