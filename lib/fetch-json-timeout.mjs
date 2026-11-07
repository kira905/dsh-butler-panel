// dsh-butler-panel / lib/fetch-json-timeout.mjs —— 带显式超时的 JSON fetch（零依赖、可注入）
//
// 为什么单独一个文件（卡 0 · B6②，2026-09-14）：
//   `lib/index.js` 的 `fetchMainTitleMap()` 原先直接 `await fetch(...)` **既无超时也无 AbortController** ——
//   主包 RPC 卡住（DSH 重启中 / 假死）时面板 GET /state 会跟着挂住，首屏永远出不来（实测会一直等到
//   TCP 层超时，几十秒到几分钟）。超时逻辑抽成这个**零依赖纯函数**后可以真跑超时路径单测
//   （注入一个永不 resolve 的 fetchImpl），而不是只能读代码。
//
// 双保险：① AbortController 到点 abort（真 fetch 会立即中断，不留悬挂连接）
//        ② Promise.race 兜底（即使注入的 fetchImpl 无视 signal，**调用方也一定 ≤timeoutMs 拿到降级结果**）
//
// 语义：**永不抛错**——一律返回 { ok:false, reason } 让调用方降级（保留旧缓存 / 保留 scan 标题）。
/** 默认超时（毫秒）。1.2s = 首屏预算内（B1：冷启动总预算 ~1.2s），超时即降级。 */
export const DEFAULT_TIMEOUT_MS = 1200;

/**
 * 带超时的 JSON GET/POST。
 * @param {string} url
 * @param {{timeoutMs?:number, fetchImpl?:Function, init?:object}} [opts]
 *        timeoutMs ≤ 0 / 非有限值 = 不限时（调用方显式选择）；fetchImpl 可注入（单测）。
 * @returns {Promise<{ok:boolean, json?:object, status?:number, reason?:string}>}
 */
export async function fetchJsonWithTimeout(url, opts = {}) {
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(opts.timeoutMs);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch' };
  const bounded = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const ctl = new AbortController();
  let timer = null;
  let timedOut = false;
  if (bounded) {
    timer = setTimeout(() => {
      timedOut = true;
      try { ctl.abort(new Error(`timeout:${timeoutMs}ms`)); } catch { try { ctl.abort(); } catch { /* ignore */ } }
    }, timeoutMs);
    // ⚠️ 这里**不能 unref()**：调用方常常是 top-level await（脚本收尾阶段），
    //   定时器被 unref 后事件循环会判定"没事可做"而提前退出 → "Detected unsettled top-level await"
    //   （2026-09-14 单测实测）。定时器在 finally 里 clearTimeout 收干净。
  }
  const work = (async () => {
    const res = await fetchImpl(url, { ...(opts.init ?? {}), signal: ctl.signal });
    if (!res || res.ok !== true) return { ok: false, status: res?.status ?? null, reason: `http:${res?.status ?? '?'}` };
    let json = null;
    try { json = await res.json(); } catch { return { ok: false, reason: 'bad-json' }; }
    return { ok: true, json };
  })();
  work.catch(() => { /* 交给下面的 race 分支归因；避免未处理拒绝 */ });
  try {
    if (!bounded) return await work;
    let raceTimer = null;
    const timeoutBranch = new Promise((resolve) => {
      // 同样不 unref（理由见上）：调用方可能是 top-level await 的脚本
      raceTimer = setTimeout(() => resolve({ ok: false, reason: `timeout:${timeoutMs}ms` }), timeoutMs);
    });
    const out = await Promise.race([work, timeoutBranch]);
    clearTimeout(raceTimer);
    return out;
  } catch (e) {
    if (timedOut) return { ok: false, reason: `timeout:${timeoutMs}ms` };
    if (ctl.signal.aborted) return { ok: false, reason: 'aborted' };
    return { ok: false, reason: `error:${String(e?.message ?? e).slice(0, 120)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default fetchJsonWithTimeout;
