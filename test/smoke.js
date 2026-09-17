// End-to-end smoke test. Boots the real server on a scratch DATA_DIR and
// exercises: auth scopes, sync small-image path, async large-image path,
// corrupt-image handling, manual retry, audit trail, image download, health.
// Run: npm run smoke
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'imgpipe-'));

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
};

async function api(method, url, { key, body, headers = {} } = {}) {
  const h = { ...headers };
  if (key) h.Authorization = `Bearer ${key}`;
  const res = await fetch(BASE + url, { method, headers: h, body });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.arrayBuffer(), headers: res.headers };
}

function uploadBody(buf, filename) {
  const form = new FormData();
  form.append('file', new Blob([buf]), filename);
  return form;
}

async function waitTask(id, key, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api('GET', `/tasks/${id}`, { key });
    if (body.task.status === 'done' || body.task.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`task ${id} did not finish in time`);
}

// ---- boot server ---------------------------------------------------------
console.log(`booting server (DATA_DIR=${dataDir})…`);
const child = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), RETRY_BASE_MS: '300' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let bootLog = '';
const keys = {};
await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`server boot timeout:\n${bootLog}`)), 30_000);
  child.stdout.on('data', (d) => {
    bootLog += d;
    for (const m of bootLog.matchAll(/(uploader|viewer|admin)\s+scopes=[\w,]+\s+(img_\w+)/g)) {
      keys[m[1]] = m[2];
    }
    if (bootLog.includes('listening') && keys.uploader && keys.viewer && keys.admin) {
      clearTimeout(to);
      resolve();
    }
  });
  child.on('exit', (c) => reject(new Error(`server exited early (${c}):\n${bootLog}`)));
});

try {
  // ---- fixtures ----------------------------------------------------------
  const smallPng = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 40, g: 120, b: 200 } } }).png().toBuffer();
  const noise = randomBytes(1600 * 1600 * 3); // incompressible → PNG stays > 2MB sync threshold
  const largePng = await sharp(noise, { raw: { width: 1600, height: 1600, channels: 3 } }).png().toBuffer();
  const corruptPng = Buffer.concat([smallPng.subarray(0, 100), Buffer.from('deadbeef'.repeat(200))]);
  const notAnImage = Buffer.from('this is definitely not an image file');

  console.log(`fixtures: small=${smallPng.length}B large=${largePng.length}B`);

  // ---- auth --------------------------------------------------------------
  console.log('\nauth & permissions:');
  let r = await api('GET', '/tasks/nope');
  ok(r.status === 401, 'no token → 401');
  r = await api('POST', '/images', { key: keys.viewer, body: uploadBody(smallPng, 'a.png') });
  ok(r.status === 403, 'viewer key cannot upload (403)');
  r = await api('GET', `/tasks/whatever`, { key: keys.uploader });
  ok(r.status === 403, 'uploader key cannot view tasks (403)');

  // ---- validation ----------------------------------------------------------
  console.log('\nupload validation:');
  r = await api('POST', '/images', { key: keys.uploader, body: uploadBody(notAnImage, 'x.png') });
  ok(r.status === 415, `non-image rejected with 415 (got ${r.status})`);

  // ---- sync path -------------------------------------------------------------
  console.log('\nsmall image (sync):');
  r = await api('POST', '/images', { key: keys.uploader, body: uploadBody(smallPng, 'small.png') });
  ok(r.status === 201, `small image → 201 sync (got ${r.status})`);
  ok(r.body.task?.status === 'done' && r.body.task?.progress === 100, 'sync task done at 100%');
  ok(r.body.outputs?.web?.mime === 'image/webp' && r.body.outputs?.thumb, 'web + thumb variants returned');
  const syncId = r.body.task.id;

  r = await api('GET', `/images/${syncId}/web`, { key: keys.viewer });
  ok(r.status === 200 && r.headers.get('content-type') === 'image/webp', 'viewer can download web variant');
  const webMeta = await sharp(Buffer.from(r.body)).metadata();
  ok(webMeta.width <= 2048 && webMeta.format === 'webp', `web variant is webp ${webMeta.width}x${webMeta.height}`);
  r = await api('GET', `/images/${syncId}/thumb`, { key: keys.viewer });
  const thumbMeta = await sharp(Buffer.from(r.body)).metadata();
  ok(Math.max(thumbMeta.width, thumbMeta.height) <= 320, `thumb ≤ 320px (${thumbMeta.width}x${thumbMeta.height})`);
  r = await api('GET', `/images/${syncId}/web`, { key: keys.uploader });
  ok(r.status === 403, 'uploader key cannot download image (403)');

  // ---- async path -------------------------------------------------------------
  console.log('\nlarge image (async queue):');
  r = await api('POST', '/images', { key: keys.uploader, body: uploadBody(largePng, 'large.png') });
  ok(r.status === 202, `large image → 202 queued (got ${r.status})`);
  const asyncId = r.body.task.id;

  // SSE progress stream
  const sseEvents = [];
  const sseRes = await fetch(`${BASE}/tasks/${asyncId}/stream`, { headers: { Authorization: `Bearer ${keys.viewer}` } });
  const sseReader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = '';
  const ssePump = (async () => {
    while (true) {
      const { done, value } = await sseReader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      for (const m of sseBuf.matchAll(/data: (\{.*\})\n/g)) {
        try { sseEvents.push(JSON.parse(m[1])); } catch { /* partial chunk */ }
      }
      sseBuf = sseBuf.slice(sseBuf.lastIndexOf('\n\n') + 2);
    }
  })();

  const finalAsync = await waitTask(asyncId, keys.viewer);
  ok(finalAsync.task.status === 'done', `async task done (progress=${finalAsync.task.progress})`);
  ok(finalAsync.outputs.web && finalAsync.outputs.thumb, 'async outputs present');
  await ssePump;
  ok(sseEvents.some((e) => e.type === 'progress') && sseEvents.some((e) => e.type === 'done'),
    `SSE stream delivered progress + done (${sseEvents.length} events)`);

  // ---- corrupt image ----------------------------------------------------------
  console.log('\ncorrupt image handling:');
  r = await api('POST', '/images', { key: keys.uploader, body: uploadBody(corruptPng, 'corrupt.png') });
  ok(r.status === 422, `corrupt image → 422 (got ${r.status})`);
  ok(r.body.task?.status === 'failed', 'corrupt task marked failed');
  const corruptId = r.body.task.id;

  r = await api('GET', `/tasks/${corruptId}/events`, { key: keys.viewer });
  const eventNames = r.body.events.map((e) => e.event);
  ok(eventNames.includes('created') && eventNames.includes('processing_started') && eventNames.includes('failed'),
    `audit trail recorded (${eventNames.join(', ')})`);
  ok(r.body.events.find((e) => e.event === 'failed')?.detail?.permanent === true, 'corrupt failure classified permanent');

  // ---- retry ---------------------------------------------------------------------
  console.log('\nretry:');
  r = await api('POST', `/tasks/${corruptId}/retry`, { key: keys.uploader });
  ok(r.status === 202 && r.body.task.status === 'queued', 'failed task requeued (202)');
  const retried = await waitTask(corruptId, keys.viewer);
  ok(retried.task.status === 'failed', 'still-corrupt task fails again after retry');
  r = await api('POST', `/tasks/${syncId}/retry`, { key: keys.uploader });
  ok(r.status === 409, 'retrying a done task → 409');
  r = await api('POST', `/tasks/${corruptId}/retry`, { key: keys.viewer });
  ok(r.status === 403, 'viewer cannot retry (403)');

  // ---- health -----------------------------------------------------------------------
  console.log('\nhealth:');
  r = await api('GET', '/health');
  ok(r.status === 200 && typeof r.body.queueDepth === 'number' && r.body.rssMb > 0 && r.body.freeDiskMb > 0,
    `health ok (rss=${r.body.rssMb}MB free=${r.body.freeDiskMb}MB)`);
} catch (err) {
  failed++;
  console.error('smoke test crashed:', err);
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  await rm(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
