import { db } from './db.js';
import { AppError } from './errors.js';

// 角色 → 能力:上传与查看分离,admin 兼具
const CAPS = {
  uploader: new Set(['upload']),
  viewer: new Set(['view']),
  admin: new Set(['upload', 'view', 'admin']),
};

export function requireCap(cap) {
  return async (req, res, next) => {
    try {
      const key = req.get('x-api-key');
      if (!key) throw new AppError(401, 'unauthorized', '缺少 X-API-Key 请求头');
      const { rows } = await db.query('SELECT key, role FROM api_keys WHERE key = $1', [key]);
      const principal = rows[0];
      if (!principal) throw new AppError(401, 'unauthorized', '无效的 API Key');
      if (!CAPS[principal.role]?.has(cap)) {
        throw new AppError(403, 'forbidden', `角色 ${principal.role} 缺少 ${cap} 权限`);
      }
      req.auth = principal;
      next();
    } catch (err) {
      next(err);
    }
  };
}
