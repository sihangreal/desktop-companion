'use strict';

// 共享的 SSE 解析：把 text/event-stream 拆成一个个 JSON 对象。
// 只处理 `data:` 行，忽略注释与空行；遇到 [DONE] 结束。

async function* readSse(res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      if (signal && signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch {
          /* 不完整分片，跳过 */
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { readSse };
