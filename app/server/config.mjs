// 配置：读取 app/.env（零依赖），导出全局常量。API Key 只存在服务端内存。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(__dirname, '..');          // .../app
export const ROOT_DIR = path.resolve(APP_DIR, '..');           // .../OneProject
export const PUBLIC_DIR = path.join(APP_DIR, 'public');
export const DATA_DIR = path.join(APP_DIR, 'data');
export const SESSION_DIR = path.join(DATA_DIR, 'sessions');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

function loadEnvFile() {
  const out = {};
  const file = path.join(APP_DIR, '.env');
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch {
    /* .env 不存在时走环境变量 */
  }
  return out;
}

const env = { ...loadEnvFile(), ...process.env };

export const CONFIG = {
  apiKey: env.DEEPSEEK_API_KEY || '',
  baseUrl: (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: env.DEEPSEEK_MODEL || 'deepseek-flash',
  port: Number(env.PORT || 8848),
  // 0.0.0.0 = 同时监听本机与局域网（手机/平板可直接访问）
  // 只想本机访问：在 app/.env 里写 HOST=127.0.0.1
  host: env.HOST || '0.0.0.0',
  maxUploadBytes: 12 * 1024 * 1024,
  analyzeTimeoutMs: 150_000,
  // 家庭分享
  shareTtlHours: Number(env.SHARE_TTL_HOURS || 24),
  // 分享页/接口只允许局域网访问（承诺「仅同一 Wi-Fi 可打开」的技术兜底）
  // 置 0 可关闭（例如想通过公网隧道路演时）
  shareLanOnly: env.SHARE_LAN_ONLY !== '0',
};

for (const dir of [DATA_DIR, SESSION_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
