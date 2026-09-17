// 全流程冒烟测试:启动独立实例(隔离目录),验证权限、同步/异步、损坏图片、重试、审计
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const UPLOAD = 'dev-upload-key';
const VIEW = 'dev-view-key';
const SMOKE_DIR = path.join(ROOT, '.smoke');

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${name} ${extra}`);
  }
}

async function waitHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('服务未在预期时间内就绪');
}

function uploadImage(buf, name, key = UPLOAD) {
  const form = new FormData();
  form.append('file', new Blob([buf]), name);
  return fetch(`${BASE}/images`, { method: 'POST', headers: { 'x-api-key': key }, body: form });
}

async function pollTask(id, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/tasks/${id}`, { headers: { 'x-api-key': VIEW } });
    const t = await r.json();
    if (t.status === 'completed' || t.status === 'failed') return t;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`任务 ${id} 轮询超时`);
}

async function main() {
  await fs.rm(SMOKE_DIR, { recursive: true, force: true });
  const env = {
    ...process.env,
    PORT: String(PORT),
    STORAGE_DIR: path.join(SMOKE_DIR, 'storage'),
    PG_DATA_DIR: path.join(SMOKE_DIR, 'pg'),
    SYNC_MAX_BYTES: String(64 * 1024), // 调低阈值,小文件也能走异步路径
    MAX_UPLOAD_BYTES: String(20 * 1024 * 1024),
    MEMORY_LIMIT_MB: '2048', // 保证同步路径不被内存闸门拦截
    RETRY_BASE_DELAY_MS: '300',
  };
  const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitHealth();
    console.log('服务已就绪,开始测试\n');

    // ---- 1. 权限隔离 ----
    console.log('▸ 权限');
    let r = await fetch(`${BASE}/images`, { method: 'POST' });
    check('无 Key 上传 → 401', r.status === 401);

    const smallBuf = await sharp({
      create: { width: 320, height: 200, channels: 3, background: { r: 80, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();

    r = await uploadImage(smallBuf, 'x.png', VIEW);
    check('viewer 上传 → 403', r.status === 403);

    // ---- 2. 小图同步 ----
    console.log('▸ 小图同步处理');
    r = await uploadImage(smallBuf, 'small.png');
    check('小图上传 → 200(同步完成)', r.status === 200, `got ${r.status}`);
    const smallTask = await r.json();
    check('状态 completed', smallTask.status === 'completed', JSON.stringify(smallTask));
    check('返回缩略图地址', !!smallTask.image?.thumbUrl);

    r = await fetch(`${BASE}/tasks/${smallTask.taskId}`, { headers: { 'x-api-key': UPLOAD } });
    check('uploader 查任务 → 403', r.status === 403);
    r = await fetch(`${BASE}${smallTask.image.outputUrl}`, { headers: { 'x-api-key': UPLOAD } });
    check('uploader 看图片 → 403', r.status === 403);
    r = await fetch(`${BASE}${smallTask.image.outputUrl}`, { headers: { 'x-api-key': VIEW } });
    check('viewer 看 output → 200 且为 webp', r.status === 200 && r.headers.get('content-type') === 'image/webp');
    r = await fetch(`${BASE}${smallTask.image.thumbUrl}`, { headers: { 'x-api-key': VIEW } });
    const thumbMeta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
    check('缩略图宽度 ≤ 256', thumbMeta.width <= 256, `got ${thumbMeta.width}`);

    // ---- 3. 大图异步 + SSE 进度 ----
    console.log('▸ 大图异步处理');
    const noiseBuf = await sharp({
      create: { width: 1600, height: 1200, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 30 } },
    })
      .png()
      .toBuffer();

    r = await uploadImage(noiseBuf, 'large.png');
    check('大图上传 → 202(排队)', r.status === 202, `got ${r.status}`);
    const big = await r.json();

    const ssePromise = (async () => {
      const res = await fetch(`${BASE}/tasks/${big.taskId}/events`, { headers: { 'x-api-key': VIEW } });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('"status":"completed"')) break;
      }
      await reader.cancel().catch(() => {});
      return text;
    })();

    const bigDone = await pollTask(big.taskId);
    check('大图异步完成', bigDone.status === 'completed', JSON.stringify(bigDone.error));
    check('记录原图尺寸 1600x1200', bigDone.image?.width === 1600 && bigDone.image?.height === 1200);
    const sseText = await ssePromise;
    check('SSE 推送进度并到达 completed', sseText.includes('data:') && sseText.includes('"status":"completed"'));

    // ---- 4. 审计记录 ----
    console.log('▸ 审计');
    r = await fetch(`${BASE}/tasks/${big.taskId}/audit`, { headers: { 'x-api-key': VIEW } });
    const events = (await r.json()).records.map((x) => x.event);
    check(
      '审计包含 created/processing_started/completed',
      ['created', 'processing_started', 'completed'].every((e) => events.includes(e)),
      events.join(','),
    );

    // ---- 5. 损坏图片 ----
    console.log('▸ 损坏图片');
    const corruptSmall = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2048)]);
    r = await uploadImage(corruptSmall, 'broken.jpg');
    check('损坏小图 → 422(上传时拒绝)', r.status === 422, `got ${r.status}`);

    // 截断的 PNG:头部元数据合法可通过校验,解码阶段才失败 → 走异步任务失败路径
    const truncPng = noiseBuf.subarray(0, 128 * 1024);
    r = await uploadImage(truncPng, 'truncated.png');
    check('截断大图 → 202(排队)', r.status === 202, `got ${r.status}`);
    const broken = await r.json();
    const brokenDone = await pollTask(broken.taskId);
    check('损坏任务 → failed', brokenDone.status === 'failed', JSON.stringify(brokenDone));
    check('错误分类 corrupt_image', brokenDone.error?.kind === 'corrupt_image', brokenDone.error?.kind);

    // ---- 6. 重试 ----
    console.log('▸ 重试');
    r = await fetch(`${BASE}/tasks/${broken.taskId}/retry`, { method: 'POST', headers: { 'x-api-key': UPLOAD } });
    check('失败任务重试 → 202', r.status === 202, `got ${r.status}`);
    const retried = await pollTask(broken.taskId);
    check(
      '重试后仍 failed 且 attempts 增加',
      retried.status === 'failed' && retried.attempts === brokenDone.attempts + 1,
      `attempts=${retried.attempts}`,
    );
    r = await fetch(`${BASE}/tasks/${broken.taskId}/audit`, { headers: { 'x-api-key': VIEW } });
    const ev2 = (await r.json()).records.map((x) => x.event);
    check('审计记录 retried/failed', ev2.includes('retried') && ev2.includes('failed'), ev2.join(','));
    r = await fetch(`${BASE}/tasks/${big.taskId}/retry`, { method: 'POST', headers: { 'x-api-key': UPLOAD } });
    check('已完成任务重试 → 409', r.status === 409);

    // ---- 7. 非法与超限文件 ----
    console.log('▸ 文件校验');
    r = await uploadImage(Buffer.from('hello, plain text'), 'note.txt');
    check('文本文件 → 422', r.status === 422, `got ${r.status}`);
    r = await uploadImage(crypto.randomBytes(21 * 1024 * 1024), 'huge.png');
    check('超过大小上限 → 413', r.status === 413, `got ${r.status}`);
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => server.on('exit', r));
  }

  console.log(`\n结果:${passed} 通过,${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  process.exit(1);
});
