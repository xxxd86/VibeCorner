// DeepSeek 客户端：OpenAI 兼容的流式 chat/completions。
// 只做一件事——把 SSE 增量回调出去，最后返回完整文本与用量。
import { CONFIG } from './config.mjs';

export function isConfigured() {
  return Boolean(CONFIG.apiKey);
}

/**
 * @param {object} req  { messages, temperature?, maxTokens?, thinking?, json? }
 * @param {{onReasoning?:(d:string)=>void, onContent?:(d:string)=>void, signal?:AbortSignal}} handlers
 * @returns {Promise<{content:string, reasoning:string, usage:object, model:string, ms:number}>}
 */
export async function chatStream(req, handlers = {}) {
  if (!CONFIG.apiKey) {
    throw Object.assign(new Error('服务端未配置 DEEPSEEK_API_KEY（见 app/.env）'), { status: 500 });
  }
  const optional = {
    response_format: { type: 'json_object' },
    ...(req.thinking ? { thinking: req.thinking } : {}),
    stream_options: { include_usage: true },
  };
  if (req.json === false) delete optional.response_format;

  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await once(req, optional, handlers);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      // 服务端不支持某个可选参数时，去掉它重试（字段名出现在报错里才去掉）
      const field = Object.keys(optional).find((k) => msg.includes(k));
      if (err?.status === 400 && field) {
        delete optional[field];
        continue;
      }
      if (err?.status >= 500 || err?.retryable) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function once(req, optional, handlers) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.analyzeTimeoutMs);
  const onOuterAbort = () => controller.abort();
  if (handlers.signal) {
    if (handlers.signal.aborted) controller.abort();
    else handlers.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const body = {
    model: CONFIG.model,
    messages: req.messages,
    stream: true,
    temperature: req.temperature ?? 0.6,
    max_tokens: req.maxTokens ?? 4000,
    ...optional,
  };

  let res;
  try {
    res = await fetch(`${CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    handlers.signal?.removeEventListener?.('abort', onOuterAbort);
    if (e?.name === 'AbortError') throw Object.assign(new Error('模型请求超时'), { status: 504 });
    throw Object.assign(new Error(`连不上模型服务：${e.message}`), { status: 502, retryable: true });
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    let hint = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      hint = j?.error?.message || hint;
    } catch {
      /* keep raw */
    }
    const err = Object.assign(new Error(`模型返回 ${res.status}：${hint}`), { status: res.status });
    if (res.status === 401 || res.status === 403) err.status = 500;
    throw err;
  }

  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage = {};
  let model = CONFIG.model;
  let finishReason = '';

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.model) model = json.model;
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          handlers.onReasoning?.(delta.reasoning_content);
        }
        if (delta.content) {
          content += delta.content;
          handlers.onContent?.(delta.content);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    handlers.signal?.removeEventListener?.('abort', onOuterAbort);
  }

  return { content, reasoning, usage, model, ms: Date.now() - started, finishReason };
}

/** 从模型输出里抠出 JSON（容忍 ```json 围栏、前后废话、尾逗号） */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fallthrough */
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = s.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch {
      try {
        return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        /* give up */
      }
    }
  }
  return null;
}
