# image-pipeline-service

Express + Sharp + PGlite 图片异步处理流水线服务:任务入队、图像处理、存储、进度上报,内置权限控制与审计。

## 功能总览

| 需求 | 实现 |
| --- | --- |
| 任务入队 | 内存 FIFO 队列(`src/queue.js`),任务状态持久化在 PGlite,重启自动恢复中断任务 |
| 图像处理 | Sharp 转码 WebP + 256px 缩略图,自动按 EXIF 旋转(`src/processor.js`) |
| 存储 | 本地磁盘 `storage/{tmp,originals,outputs}`,写入前磁盘水位检查(`src/storage.js`) |
| 进度上报 | `tasks.progress` 轮询 + `GET /tasks/:id/events` SSE 实时推送 |
| 内存上限 | RSS 闸门:超过 `MEMORY_LIMIT_MB` 暂停派发新任务;libvips 缓存封顶 64MB |
| 并发限制 | `WORKER_CONCURRENCY`(默认 2);OOM 时自动降为 1 冷却 30s |
| 上传校验 | 魔数嗅探真实格式(不信 Content-Type)、大小上限、像素上限防解压炸弹、Sharp 完整性解析 |
| 小图同步 / 大图异步 | ≤ `SYNC_MAX_BYTES` 在请求内同步完成返回 200;否则入队返回 202 |
| 损坏图片 | 上传时 422;解码期损坏 → 任务 `failed`,`error_kind=corrupt_image`,不自动重试 |
| OOM | 错误分类 `oom`,指数退避自动重试(最多 `MAX_ATTEMPTS` 次),同时降并发 |
| 磁盘不足 | 上传/处理前水位检查 → 507;`disk_full` 可自动重试 |
| 权限分离 | API Key 角色:`uploader`(上传/重试)、`viewer`(查看)、`admin`(兼具 + 强制重试) |
| 任务重试 | 自动(瞬时错误,退避)+ 人工 `POST /tasks/:id/retry`;超次数需 admin |
| 审计 | `audit_records` 表记录 created/processing_started/completed/failed/retried/recovered 等事件 |

## 快速开始

```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # 全流程冒烟测试(独立端口与目录,24 项断言)
```

首次启动自动初始化 PGlite(默认 `data/pg`)并写入开发用 Key(生产请用环境变量覆盖):

| 角色 | 默认 Key | 能力 |
| --- | --- | --- |
| uploader | `dev-upload-key` | 上传、重试 |
| viewer | `dev-view-key` | 查状态、看图片、SSE、审计 |
| admin | `dev-admin-key` | 以上全部 + 超额强制重试 |

## API

所有接口(除 `/health`)需请求头 `X-API-Key`。

### 上传 `POST /images`(uploader)

`multipart/form-data`,字段名 `file`。

- 小图 → `200`,同步处理完成,响应含 `image.outputUrl / thumbUrl`
- 大图 → `202`,响应含 `taskId / statusUrl / eventsUrl`

```bash
curl -X POST http://localhost:3000/images \
  -H 'X-API-Key: dev-upload-key' -F 'file=@photo.jpg'
```

### 任务状态 `GET /tasks/:id`(viewer)

```json
{
  "taskId": "…", "status": "queued|processing|completed|failed",
  "progress": 75, "stage": "thumbnail", "attempts": 1,
  "error": null,
  "image": { "width": 1600, "height": 1200, "outputUrl": "…", "thumbUrl": "…" }
}
```

### SSE 进度 `GET /tasks/:id/events`(viewer)

连接即推送当前快照,随后每个阶段推送一条 `data:`,终态自动关闭;15s 心跳。

### 重试 `POST /tasks/:id/retry`(uploader)

仅 `failed` 任务可重试(`409`);超过 `max_attempts` 需 admin(`429`)。

### 查看图片(viewer)

`GET /images/:id/original|output|thumb` — output/thumb 为 WebP。

### 审计 `GET /tasks/:id/audit`(viewer)

按时间序返回该任务全部生命周期事件。

### 健康 `GET /health`(无需 Key)

RSS / 内存上限 / 队列深度 / 可用磁盘。

## 配置(环境变量)

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 监听端口 |
| `WORKER_CONCURRENCY` | 2 | 并发处理任务数 |
| `MEMORY_LIMIT_MB` | 1024 | RSS 上限,超过暂停派发(背压) |
| `SYNC_MAX_BYTES` | 512KB | 同步/异步分流阈值 |
| `MAX_UPLOAD_BYTES` | 50MB | 上传大小上限(超出 413) |
| `MAX_PIXELS` | 40000000 | 像素上限,防解压炸弹(超出 413) |
| `MIN_FREE_DISK_BYTES` | 200MB | 磁盘水位线(不足 507) |
| `THUMB_WIDTH` / `WEBP_QUALITY` | 256 / 82 | 缩略图宽度 / 转码质量 |
| `MAX_ATTEMPTS` / `RETRY_BASE_DELAY_MS` | 3 / 2000 | 自动重试次数 / 退避基数(指数) |
| `STORAGE_DIR` / `PG_DATA_DIR` | `storage/` / `data/pg` | 文件与数据库目录 |
| `UPLOADER_KEY` / `VIEWER_KEY` / `ADMIN_KEY` | dev-* | 初始 API Key |

## 设计要点

- **错误分类驱动策略**(`src/errors.js`):`corrupt_image`/`validation` 不重试;`oom`/`disk_full`/`unknown` 指数退避自动重试;OOM 额外触发队列降并发冷却。
- **背压**:派发任务前检查 RSS,超限则等待;上传与处理前检查磁盘水位,避免写爆磁盘。
- **崩溃恢复**:启动时将残留的 `processing` 任务重置为 `queued` 并重新入队,记录 `recovered` 审计事件。
- **审计与进度分离**:进度百分比走 `tasks` 表 + SSE;审计表只记生命周期事件,避免高频写入。
- **优雅退出**:SIGTERM/SIGINT 停止接收新任务,等待运行中任务结束(8s 超时)后关闭 PGlite。

## 目录结构

```
src/
  config.js     配置            queue.js      并发队列 + 内存闸门 + 进度总线
  db.js         PGlite/建表     processor.js  Sharp 转码 + 缩略图 + 错误处理
  repo.js       任务数据访问    storage.js    存储路径 + 磁盘水位
  audit.js      审计记录        validate.js   魔数嗅探 + 完整性校验
  auth.js       API Key 鉴权    routes.js     HTTP 路由
  errors.js     错误分类        server.js     装配 + 恢复 + 优雅退出
scripts/smoke.js  冒烟测试(24 项断言)
```
