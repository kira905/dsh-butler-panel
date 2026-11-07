// dsh-butler-panel / lib/confirm-token.mjs —— C⁺ 高危险写口的**服务端确认令牌**（控制室口径包 P-6 / 施工卡 ①-3）
//
// 为什么有这个文件（①包 §3.6）：
//   面板三条 C⁺ 写口（`/restart` force · `/audit-pass` · `/audit-off`）原先的"二次确认"**只在前端**，
//   服务端拿不到"主人确实点了确认"这件事 ⇒ 分级表的 C⁺ 只是 UI 承诺。本库把"点了确认"变成
//   **服务端可验证的事实**：前端先签发（二次确认前）→ 主人确认 → 带上令牌提交 → 服务端**一次性消费**。
//
// ⚠️ 安全目标（①包 §3.6-1 · 轮五 E9 实测后如实写明，不许含糊）：
//   本机制防的是 **误触 / 重复提交 / 忘记带理由**（+ 强制留痕）。
//   **不防**本机恶意进程与跨站页面 —— E9 实测：webserver `lib/index.js:184-187` 命中路由即执行、
//   全文 grep `authorization/token/origin/csrf/401/403` 零命中，攻击者对"签发"与"提交"两个端点
//   都能直接发请求，两步通行。要防恶意只能做完整鉴权 = ①包 D-ε 已明确排除（另立议题）。
//   ⇒ 本库、以及任何引用它的文案，**不得**表述成"安全边界"。
//
// 机件复用（①包 轮五 E8）：一次性 + TTL + 上限 + 过期即删的形态取自 `AuditTokenStore`
//   （`tools/dsh-butler/lib/audit-token.mjs:62-140`）。**另开实例**并加键前缀 `confirm:` —— 
//   ⚠️ 绝不与"写凭证"共用同一个 Map，否则确认令牌会被写门当凭证消费掉（E8 明文警告）。
//
// 签发路径（本卡内二选一，决策与理由见交付报告 §令牌签发路径）：
//   **选 (a) 复用现有 C⁺ 端点加 `mode:'confirm'`** —— 不新增任何端点/写口，
//   与 ①包 §13 Non-goals「不新增 / 不删除写口」一致；且 E9 已证"另开端点"在零鉴权下无安全收益。
//
// 零副作用：本库只在内存里发/收令牌（不读盘、不写盘、不审计）。审计由调用方（index.js）负责。
import crypto from 'node:crypto';

/** 确认令牌 TTL：2 分钟（够主人读完确认框；①包 §6 表 2「force 确认框 → 提交」的决定参数）。 */
export const CONFIRM_TTL_MS = 120_000;

/** 令牌字面量：32 位小写 hex（与 `randomToken()` 的产出同口径）。 */
export const CONFIRM_TOKEN_RE = /^[0-9a-f]{32}$/;

/** 三处 C⁺ 动作（键前缀里的 action 段；也是确认令牌的绑定目标）。 */
export const CONFIRM_ACTIONS = Object.freeze({
  RESTART_FORCE: 'restart-force',
  AUDIT_PASS: 'audit-pass',
  AUDIT_OFF: 'audit-off',
});

/** 拒绝码（审计与 HTTP 响应共用；`*_REQUIRED` 与 `*_INVALID` 分开，便于"没带"与"带错"可分辨）。 */
export const CONFIRM_CODES = Object.freeze({
  REQUIRED: 'CONFIRM_TOKEN_REQUIRED',
  INVALID: 'CONFIRM_TOKEN_INVALID',
  UNKNOWN_ACTION: 'CONFIRM_ACTION_UNKNOWN',
});

/** 令牌 → 键（带前缀，与写凭证键空间物理隔离）。 */
export function confirmKey(action, token) {
  return `confirm:${String(action)}:${String(token)}`;
}

/** 默认令牌生成器（32 位 hex；测试可注入确定性序列）。 */
function defaultRandomToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 确认令牌库（一次性 + TTL + 上限；内存态，随面板进程生命周期）。
 *
 * @param {{inner?:{issue:Function,consume:Function,purge:Function}, ttlMs?:number, randomToken?:Function}} [opts]
 *   `inner` 传 `AuditTokenStore` 实例（生产路径）；不传则用一个等价的内置最小实现（仅测试/降级用）。
 */
export class ConfirmTokenStore {
  constructor(opts = {}) {
    this.ttlMs = Number(opts.ttlMs ?? CONFIRM_TTL_MS);
    this.randomToken = opts.randomToken ?? defaultRandomToken;
    this.inner = opts.inner ?? new MinimalTokenStore(this.ttlMs);
    this.issued = 0;
    this.consumed = 0;
    this.rejected = 0;
  }

  /**
   * 签发：返回给前端的令牌明文（**只在这里出现一次**）。
   * @param {string} action 三动作之一
   * @param {Record<string, unknown>} [meta] 附在 entry 上的上下文（如 force 的预计活跃数）
   * @returns {{token:string, expiresAt:number, ttlMs:number, action:string}}
   */
  issue(action, meta = {}) {
    const token = this.randomToken();
    const key = confirmKey(action, token);
    const entry = this.inner.issue(key, action, {
      source: 'panel',
      reason: null,
      actor: meta && typeof meta === 'object' ? meta : null,
    });
    this.issued++;
    return { token, expiresAt: entry.expiresAt, ttlMs: entry.expiresAt - Date.now(), action };
  }

  /**
   * 校验并**消费**（一次性）。同一次签发的令牌第二次提交必失败。
   * @param {string} action
   * @param {string} token
   * @returns {{ok:boolean, code?:string, entry?:object}}
   */
  consume(action, token) {
    const raw = typeof token === 'string' ? token.trim().toLowerCase() : '';
    if (!CONFIRM_TOKEN_RE.test(raw)) {
      this.rejected++;
      return { ok: false, code: CONFIRM_CODES.REQUIRED };
    }
    const r = this.inner.consume(confirmKey(action, raw), action);
    if (!r?.ok) {
      this.rejected++;
      return { ok: false, code: CONFIRM_CODES.INVALID };
    }
    this.consumed++;
    return { ok: true, entry: r.entry };
  }

  /** 只读统计（面板 / 测试用；不改变任何状态）。 */
  stats() {
    const inner = typeof this.inner.stats === 'function' ? this.inner.stats() : { size: null };
    return { issued: this.issued, consumed: this.consumed, rejected: this.rejected, ttlMs: this.ttlMs, pending: inner.size ?? null };
  }
}

/**
 * 内置最小实现（**仅用于测试注入 / AuditTokenStore 不可用时降级**）。
 * 语义与 `AuditTokenStore` 对齐：一次性（consume 即删）+ TTL 过期即删 + 上限 500。
 * 生产路径由 index.js 注入真 `AuditTokenStore`（形态单一来源，本类不参与生产判定口径）。
 */
export class MinimalTokenStore {
  constructor(ttlMs = CONFIRM_TTL_MS, max = 500) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }
  purge(now = Date.now()) {
    for (const [k, v] of [...this.map.entries()]) if (v.expiresAt <= now) this.map.delete(k);
    return this.map.size;
  }
  issue(key, hash, meta = {}) {
    const now = Date.now();
    if (this.map.size >= this.max) this.purge(now);
    if (this.map.size >= this.max) {
      const oldest = [...this.map.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.map.delete(oldest[0]);
    }
    const entry = { pathKey: String(key), hash: String(hash ?? ''), expiresAt: now + this.ttlMs, at: now, actor: meta.actor ?? null, source: meta.source ?? 'panel', reason: meta.reason ?? null };
    this.map.set(String(key), entry);
    return entry;
  }
  consume(key, hash) {
    const k = String(key);
    const e = this.map.get(k);
    if (!e) return { ok: false, code: 'NOT_PASSED' };
    if (e.expiresAt <= Date.now()) { this.map.delete(k); return { ok: false, code: 'EXPIRED' }; }
    if (hash && e.hash && String(hash) !== String(e.hash)) return { ok: false, code: 'HASH_MISMATCH', entry: e };
    this.map.delete(k);
    return { ok: true, entry: e };
  }
  stats() {
    return { size: this.purge(), ttlMs: this.ttlMs };
  }
}
