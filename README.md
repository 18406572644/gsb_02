# image-pipeline

基于 **Express + Sharp + PGlite**(嵌入式 Postgres)的图片异步处理流水线服务:任务入队、图像处理、存储、进度上报、权限控制、重试与审计。

## 快速开始

```bash
npm install
npm start          # 首次启动自动创建 dev API keys 并打印到控制台
npm run seed       # 随时查看/重新打印现有 keys
npm run smoke      # 端到端冒烟测试(独立临时目录,不污染 data/)
```

首次启动输出三把 key:`uploader`(upload)、`viewer`(view)、`admin`(upload+view)。
调用方式:`Authorization: Bearer <key>`。

## 架构

```
POST /images ──┬─ ≤2MB ─→ 同步处理 ─→ 201 + outputs
               └─ >2MB ─→ 入队(202) ─→ worker pool ─→ webp 转码 + 缩略图
                                        │
                                        ├─ 并发上限 QUEUE_CONCURRENCY
                                        ├─ RSS 超软上限 → 暂停出队
                                        ├─ 瞬时错误(ENOSPC/OOM)→ 指数退避重试
                                        └─ 永久错误(损坏图)→ failed
```

| 模块 | 文件 | 职责 |
|---|---|---|
| 配置 | `src/config.js` | 全部旋钮环境变量可调 |
| 存储层 | `src/db.js` | PGlite,表:`tasks` / `images` / `task_events`(审计) / `api_keys` |
| 权限 | `src/auth.js` | Bearer key + scope 校验(upload / view 分离) |
| 校验 | `src/validate.js` | 魔数嗅探(不信客户端 mime),格式白名单 |
| 存储 | `src/storage.js` | 落盘前 `statfs` 剩余空间检查,ENOSPC → 507 |
| 处理 | `src/processor.js` | sharp 转码 webp + 320px 缩略图;`limitInputPixels` 防解压炸弹 |
| 队列 | `src/queue.js` | 持久化任务、并发限制、内存守卫、退避重试、崩溃恢复 |
| HTTP | `src/routes.js` `src/server.js` | REST + SSE 进度,优雅关闭 |

## API

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/images` | upload | multipart 字段 `file`。小图同步返回 `201`;大图 `202` + `statusUrl` |
| GET | `/tasks/:id` | view | 任务状态、进度、输出 URL |
| GET | `/tasks/:id/stream` | view | SSE 实时进度 |
| GET | `/tasks/:id/events` | view | 审计记录(created/processing_started/completed/failed/retry_scheduled/manual_retry…) |
| POST | `/tasks/:id/retry` | upload | 手动重试 failed 任务(重置尝试次数) |
| GET | `/images/:taskId/:kind` | view | 下载图片,`kind` = `original`/`web`/`thumb` |
| GET | `/health` | — | 队列深度、RSS、剩余磁盘 |

## 可靠性设计

- **内存上限**:`sharp.concurrency(1)` + 小 libvips cache + 队列并发 2;RSS 超过 `RSS_SOFT_LIMIT_MB` 时暂停出队;`MAX_PIXELS` 拒绝解压炸弹。
- **磁盘不足**:上传落盘前与每次变体写入前检查 `statfs` 剩余空间(含安全水位),不足 → 上传 `507` / 任务按瞬时错误重试。
- **图片损坏**:魔数校验拦掉非图片(`415`);解码失败归类为永久错误直接 `failed`,不浪费重试。
- **重试**:瞬时错误(ENOSPC、内存分配失败)指数退避自动重试 `MAX_ATTEMPTS` 次;failed 任务可手动 `POST /tasks/:id/retry`。
- **崩溃恢复**:重启时 `processing` 状态的任务自动重新入队(任务状态持久化在 PGlite)。
- **审计**:任务的每次状态迁移都写入 `task_events`,含耗时、尝试次数、失败原因。

## 关键配置(环境变量)

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | |
| `DATA_DIR` | `./data` | PGlite 数据 + 图片存储 |
| `MAX_UPLOAD_BYTES` | 50MB | 上传硬上限(413) |
| `SYNC_MAX_BYTES` | 2MB | ≤ 此值同步处理 |
| `MAX_PIXELS` | 40M | 像素总量上限 |
| `QUEUE_CONCURRENCY` | 2 | worker 并发 |
| `MAX_ATTEMPTS` / `RETRY_BASE_MS` | 3 / 2000 | 重试 |
| `RSS_SOFT_LIMIT_MB` | 1500 | 内存背压阈值 |
| `MIN_FREE_DISK_MB` | 200 | 磁盘水位 |

## 示例

```bash
# 上传(小图同步)
curl -X POST -H "Authorization: Bearer $UPLOADER_KEY" -F "file=@photo.jpg" localhost:3000/images
# 上传(大图异步)→ 轮询或 SSE
curl -N -H "Authorization: Bearer $VIEWER_KEY" localhost:3000/tasks/<id>/stream
# 下载缩略图
curl -H "Authorization: Bearer $VIEWER_KEY" localhost:3000/images/<taskId>/thumb -o thumb.webp
```

生产化备注:API key 目前明文存储(开发便利),上生产应改为哈希存储;任务未做按 key 隔离(任何 view key 可看所有任务),需要时可在 `tasks.owner_key_id` 上加过滤。
