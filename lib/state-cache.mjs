// dsh-butler-panel / lib/state-cache.mjs
// 【卡 A1 · v1.1 修订块 B1（方案甲）】进程内 TTL 缓存 + 单飞（single-flight）+ 超时预算。
//
// 为什么是进程内而不是落盘快照（主人 2026-09-14 14:47 拍板）：
//   面板是 dsh 进程内插件 → 缓存放内存即可，一次性消灭落盘方案的整套问题：
//   零新增 job、零新增锁、零新增状态文件、零回滚面；也不会出现"半写快照被当成没有快照"、
//   "测试实例永远没快照"、"快照 home 边界跑到生产"那一类事故。
//
// 为什么带单飞：面板可被多个页面/多次点击并发打开，冷启动重算（实测最坏 3.7s）会被放大 N 倍。
//   单飞把同一 key 的并发请求合并成**一次真实计算**，其余请求复用同一 Promise 的结果。
//
// 为什么带预算（B1③）：冷启动最坏路径无上界（跨插件 HTTP 2.7s + 主包 RPC）。本模块给一次
//   重算一个总预算（默认 1.2s 兜底），逐源检查剩余预算，不够就**跳过并显式标注**
//   （"不可探测 + 原因"），绝不显示假值（0 与"没数据"必须分得开）。
//
// ⚠️ 本模块**不写盘**（R7「退化路径不写盘」）：只有内存 Map 与计数。
//
// 【红线】不要在这里实现 ETag/304（审核 B3）：前端 `client.js` 的 apiFetch 是
//   `res.json()` + `if(!res.ok) throw`，304 会被当成失败抛错；且响应本就带 `cache:no-store`，
//   304 不参与任何缓存校验。缓存只走 TTL + 单飞。

/**
 * 【2026-10-26 · 卡「面板首屏冷窗治本」· 两个默认值的 env 覆盖口】
 *
 * 为什么开口子：J2 夹具要在**分钟级**造出「条目超硬上限被惰性删掉」的现场，
 *   否则一次演练要真等 15 分钟。**不设 env ⇒ 下面两个常量逐字等于 300_000 / 900_000**（J3 等价判据）。
 * 纪律：
 *   · 只给夹具/测试实例用，**生产不许设**（改了 TTL 就不再是主人拍板那套 SWR 口径）；
 *   · **不许拿它当"把 TTL 调大"的替代手段**（见 STATE_STALE_MAX_MS 上方 🔴 段）；
 *   · 非法值（NaN / 负数 / 空白）一律**回落原值**：绝不抛、绝不让插件 boot 失败。
 */
function envMsOverride(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  const text = String(raw).trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** 片缓存 TTL：与主人拍板的 300s 频率一致（复用既有 5 分钟节奏，不新增 tickd job）。 */
export const STATE_CACHE_TTL_MS = envMsOverride('DSH_BUTLER_PANEL_CACHE_TTL_MS', 300_000);
/**
 * 【V3 功能面 A 补 · 2026-10-21】「过期旧值」还能服务多久 = 硬上限（stale-while-revalidate）。
 *
 * 为什么需要它（现跑读数，见 `docs\交付报告-V3功能面-面板提速③取数-20261019.md` §5.4）：
 *   片缓存 TTL=300s，**过期那一刻**旧实现是 `store.delete` + 阻塞重算 ⇒ 正好撞上缓存到期的
 *   那次首屏是 1.5~2.7 s（十次探针里 3 次超线）；硬底 = 服务端自己算 core 片 1509 ms。
 *   ⇒ 主人 2026-10-21 15:49 拍板选 A（本版内修）：**过期先给旧值 + 后台刷新**。
 *
 * 语义（只有 `singleFlight(..., {swr:true})` 才生效，默认关）：
 *   · age < TTL            → 新鲜命中（老行为，`stale:false`）
 *   · TTL ≤ age < 硬上限   → **立刻返回旧 payload**（`stale:true`）+ 单飞后台重算一次
 *   · age ≥ 硬上限         → 回到老行为：删条目 + 阻塞重算（防永远服务化石数据）
 *
 * ⚠️ **不许把 TTL 调大来替代本机制**（主人明确选的是 SWR，不是"缓存更久"）：TTL 300s 不动，
 *   硬上限只决定"旧值最多还能顶多久"，且读数旧必须能看出来（`stale/refreshing/ageMs`）。
 * 回滚：删本常量相关分支 / 回滚点 `_archive\v3face-swr-20261021\`。
 */
export const STATE_STALE_MAX_MS = envMsOverride('DSH_BUTLER_PANEL_CACHE_STALE_MAX_MS', 900_000);
/**
 * 冷启动单次重算的总超时预算。
 *
 * 【冲刺600·面板三小修 · 1.9 · 2026-10-10 订正】原值 **1200 ms → 2500 ms**。
 *   实测（生产 3080 · `?parts=<组合>&refresh=1` 冷算各 3 次，见交付报告 §1.9）：
 *     · `core`              835 / 691 / 565 ms       ✓ 够
 *     · `core,metrics,feed` **2107 / 2424 / 2195**   ✗ 超 1.8–2.0×（首屏组合）
 *     · `health`            1363 / 1322 / 1279 ms    ✗ 超（生态面板 HTTP 是固定价）
 *     · `metrics`           1216 / 1223 / 1228 ms    ✗ 刚好超
 *     · `feed` / `assets`   6–15 / 37–85 ms          ✓ 够
 *   后果（原值的真实代价）：首屏组合路径上 `core.board` 分项**恒被降级**
 *     —— 剩余预算 < 400 ms 时直接跳（"超时预算不足，未探测 Host API"），
 *        ≥400 ms 时按 `min(remaining, 900)` 发请求、Host 稍慢就 abort（"Host API 不可用"）
 *     ⇒ 首屏「待我处理」的**待验收张数**在冷启动时拿不到真值，且 `expired:true` 恒现、
 *       把真降级信号淹掉（信噪比归零）。
 *   ⚠️ 预算**不中断已发起的请求**（如 metrics 的生态面板预热带 Promise），所以它并不是
 *      "让首屏更快"的闸门，而是"逐源还要不要发起"的判据 —— 设得比实测冷算还小，
 *     等于只是把 board 挤掉、并没兜住时间。2500 ms = 实测 P95（2424）+ 余量，
 *     保留兜底语义（超 2500 ms 仍降级并显式标注，绝不无限等）。
 *   回滚：改回 `1_200` 即可（一个常量；回滚点见交付报告）。
 */
export const SHARD_BUDGET_MS = 2_500;
/** 计算失败后的负缓存窗口（防止上游持续失败时每个请求都重算一次）。 */
export const CACHE_FAIL_TTL_MS = 15_000;
/** 缓存条目上限（片组合数量有限，这里只是防御性上限）。 */
export const CACHE_MAX_ENTRIES = 32;

/** @type {Map<string, {at:number, payload:any, computeMs:number, bytes:number}>} */
const store = new Map();
/** @type {Map<string, Promise<any>>} key → 正在进行的真实计算 */
const inflight = new Map();
/** @type {Map<string, {at:number, error:string}>} key → 最近一次失败（负缓存） */
const failures = new Map();
const stats = {
  hits: 0,
  misses: 0,
  coalesced: 0,
  computes: 0,
  computeErrors: 0,
  // 【A 补 · SWR】`expired` 语义收窄为「超硬上限被删掉的条目数」（老实现是"每次窥见过期即计数"）
  expired: 0,
  evicted: 0,
  failFast: 0,
  totalComputeMs: 0,
  /** 【A 补 · SWR】「过期旧值」被真正端给请求方的次数（前端 meta.cache.stale=true 的响应数）。 */
  staleServed: 0,
  /** 【A 补 · SWR】后台重算失败次数（吞掉不外抛；旧值不丢）。 */
  bgRefreshErrors: 0,
  /** 【A 补 · SWR】最近一次后台重算失败留痕（诊断用；不发日志也能查到）。 */
  lastRefreshError: null,
};

/** 缓存键：片集合归一化（排序去重）→ 稳定字符串。 */
export function cacheKeyOf(parts) {
  const list = Array.isArray(parts) ? parts : [parts];
  const norm = [...new Set(list.map((p) => String(p ?? '').trim().toLowerCase()).filter(Boolean))].sort();
  return norm.length ? norm.join('+') : 'empty';
}

/**
 * 只读窥视（不触发计算）。命中返回条目，未命中/过期返回 null。
 *
 * 【A 补 · SWR】过期条目**不再立刻删**：TTL ≤ age < 硬上限期间留着给 SWR 服务旧值
 *   （`peekStaleCache` 才看得到它），只有 age ≥ 硬上限才删（并计 `expired`）。
 *   ⇒ 返回值语义不变（过期仍返回 null），只是"过期≠丢数据"。
 */
export function peekCache(key, now = Date.now(), ttlMs = STATE_CACHE_TTL_MS, staleMaxMs = STATE_STALE_MAX_MS) {
  const hit = store.get(key);
  if (!hit) return null;
  const age = now - hit.at;
  if (age >= ttlMs) {
    if (age >= staleMaxMs) {
      store.delete(key);
      stats.expired++;
    }
    return null;
  }
  return hit;
}

/**
 * 【A 补 · SWR】只读窥视「过期但未超硬上限」的旧值（不删、不计 expired）。
 * @returns {{entry:{at:number,payload:any,computeMs:number,bytes:number}, ageMs:number}|null}
 */
export function peekStaleCache(key, now = Date.now(), ttlMs = STATE_CACHE_TTL_MS, staleMaxMs = STATE_STALE_MAX_MS) {
  const hit = store.get(key);
  if (!hit) return null;
  const age = now - hit.at;
  if (age < ttlMs) return null;       // 新鲜：交给 peekCache，不算 stale
  if (age >= staleMaxMs) return null; // 超硬上限：绝不再端出去（宁可阻塞重算）
  return { entry: hit, ageMs: age };
}

/** 写入缓存（payload 由唯一入口生成；这里只做存放与计数）。 */
export function putCache(key, payload, computeMs = 0, now = Date.now()) {
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8'); } catch { bytes = 0; }
  store.set(key, { at: now, payload, computeMs, bytes });
  failures.delete(key);
  while (store.size > CACHE_MAX_ENTRIES) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    store.delete(oldest[0]);
    stats.evicted++;
  }
  return { at: now, bytes };
}

/** 失效（单测与将来的显式刷新用；生产路径不调用）。 */
export function invalidateCache(key = null) {
  if (key === null) { store.clear(); failures.clear(); return true; }
  failures.delete(key);
  return store.delete(key);
}

/** 计数快照（自检/单测断言"并发合并成一次真实计算"用）。 */
export function cacheStats() {
  return { ...stats, size: store.size, inflight: inflight.size, keys: [...store.keys()] };
}

/** 清计数（单测隔离用；不碰 store 也可，默认连 store 一起清）。 */
export function resetCache({ clearStore = true } = {}) {
  if (clearStore) { store.clear(); }
  failures.clear();
  inflight.clear();
  for (const k of Object.keys(stats)) stats[k] = 0;
  stats.lastRefreshError = null; // 非计数位（上面那轮会写成 0）
}

/**
 * 发起一次真实计算（写 inflight ⇒ 同 key 并发天然合并），完成时写缓存、失败时记负缓存。
 * 单飞与 SWR 后台刷新共用这一条路径 —— **绝不在别处再写一套计算/记账**。
 * @returns {Promise<object>} 失败时 reject（调用方决定吞还是抛）
 */
function launchCompute(key, produce) {
  const started = Date.now();
  let p = null;
  p = (async () => {
    try {
      const payload = await produce();
      const computeMs = Date.now() - started;
      putCache(key, payload, computeMs, Date.now());
      stats.computes++;
      stats.totalComputeMs += computeMs;
      return {
        ok: true, payload, hit: false, coalesced: false,
        computedAt: Date.now(), computeMs, ageMs: 0,
        stale: false, refreshing: false,
      };
    } catch (e) {
      stats.computeErrors++;
      failures.set(key, { at: Date.now(), error: String(e?.message ?? e) });
      throw e;
    } finally {
      // ⚠️ `produce` **同步抛错**时本 finally 会早于下面的 `inflight.set` 执行
      //   ⇒ 靠 `inflight.get(key) === p` 判据 + 下面补的一刀，保证不留残值。
      if (inflight.get(key) === p) inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  // 补一刀（幂等）：只清理"确实是自己"的那一条；同时消化 rejected promise 的副作用侧链
  p.catch(() => {}).then(() => { if (inflight.get(key) === p) inflight.delete(key); });
  return p;
}

/**
 * 单飞 + TTL（可选 stale-while-revalidate）。同一 key 的并发调用共用一次真实计算。
 *
 * @param {string} key
 * @param {() => Promise<any>|any} produce
 * @param {{ttlMs?:number, now?:number, failTtlMs?:number, swr?:boolean, staleMaxMs?:number,
 *          onRefreshError?:(err:any, key:string)=>void}} [opts]
 *   `swr` **默认关**（老调用方行为逐字不变）；只有面包片的唯一入口
 *   （`lib\shards.mjs#buildShardPayload`）会开它。
 * @returns {Promise<{ok:boolean, payload:any, hit:boolean, coalesced:boolean, computedAt:number,
 *   computeMs:number, ageMs:number, stale?:boolean, refreshing?:boolean, error?:string}>}
 */
export async function singleFlight(key, produce, opts = {}) {
  const ttlMs = opts.ttlMs ?? STATE_CACHE_TTL_MS;
  const failTtlMs = opts.failTtlMs ?? CACHE_FAIL_TTL_MS;
  const staleMaxMs = opts.staleMaxMs ?? STATE_STALE_MAX_MS;
  const swr = opts.swr === true;
  const now = opts.now ?? Date.now();
  const fresh = peekCache(key, now, ttlMs, staleMaxMs);
  if (fresh) {
    stats.hits++;
    return {
      ok: true, payload: fresh.payload, hit: true, coalesced: false,
      computedAt: fresh.at, computeMs: fresh.computeMs, ageMs: now - fresh.at,
      stale: false, refreshing: false,
    };
  }
  // 【A 补 · SWR】过期但未超硬上限 ⇒ 立刻端旧值 + 后台单飞重算一次。
  //   ⚠️ 这一段必须排在负缓存判断**之前**：手上有旧值就别让请求方吃 `ok:false`
  //      （旧值比"这次重算失败了"对首屏有用得多）；负缓存只用来**抑制后台反复重算**。
  if (swr) {
    const staleHit = peekStaleCache(key, now, ttlMs, staleMaxMs);
    if (staleHit) {
      stats.staleServed++;
      const bad = failures.get(key);
      const badHot = Boolean(bad) && now - bad.at < failTtlMs;
      let refreshing = false;
      let joined = false;
      if (badHot) {
        // 刚失败过（15s 内）：不再重算，只端旧值（避免上游持续失败时每个请求都打一次）
        stats.failFast++;
      } else if (inflight.has(key)) {
        refreshing = true; // 已有一次重算在跑：复用，不重复发起
        joined = true;
        stats.coalesced++;
      } else {
        refreshing = true;
        // 【A 补 · 2026-10-21 现场实测补刀】后台重算必须**推迟到下一个宏任务**再启动。
        //   为什么（实测，不是推测）：`produce()` 的**同步前缀**（core 片 ≈1.5 s —— 就是原来那个
        //   「服务端自算硬底 1509 ms」）会抢在本次请求的响应写出**之前**执行 ⇒ 旧值虽"立刻"决定，
        //   客户端仍要等 1.5 s：生产「撞到期那一枪」实测 **1555 ms**（超线 55 ms）。
        //   隔离实验（同形态三变体，`_tmp\v3-swr-work\flush-lab.mjs`）：
        //     A 直接回 18 KB = 29 ms · B `res.end()` 后同 tick 忙等 1500 ms = **1522 ms** ·
        //     C 推迟到下一宏任务再忙等 1500 ms = **19 ms** ⇒ 推迟即解。
        //   守卫：延迟窗口内同 key 的并发请求会**各排一个定时器** ⇒ 回调里先看 `inflight`，
        //   已被抢先发起就直接返回（不重复重算，也不改"并发只算一次"的语义）。
        const timer = setTimeout(() => {
          if (inflight.has(key)) return; // 已被前一个请求（或它的定时器）抢先发起
          // 后台跑完即为"新鲜"；失败只留痕（stats + 回调），**不外抛、不动旧值**
          launchCompute(key, produce).catch((e) => {
            stats.bgRefreshErrors++;
            stats.lastRefreshError = { key, at: Date.now(), error: String(e?.message ?? e) };
            try { opts.onRefreshError?.(e, key); } catch { /* 留痕自身失败也绝不外抛 */ }
          });
        }, 0);
        timer.unref?.();
      }
      return {
        ok: true,
        payload: staleHit.entry.payload,
        hit: true,                 // 值确实来自缓存（但**不新鲜**：下面 stale=true 说清楚）
        coalesced: joined,
        computedAt: staleHit.entry.at,
        computeMs: staleHit.entry.computeMs,
        ageMs: staleHit.ageMs,
        stale: true,
        refreshing,
        error: badHot ? bad.error : undefined,
      };
    }
  }
  const bad = failures.get(key);
  if (bad && now - bad.at < failTtlMs) {
    stats.failFast++;
    return { ok: false, payload: null, hit: false, coalesced: false, computedAt: bad.at, computeMs: 0, ageMs: now - bad.at, error: bad.error, failFast: true };
  }
  const waiting = inflight.get(key);
  if (waiting) {
    stats.coalesced++;
    try {
      const r = await waiting;
      return { ...r, coalesced: true };
    } catch (e) {
      return { ok: false, payload: null, hit: false, coalesced: true, computedAt: Date.now(), computeMs: 0, ageMs: 0, error: String(e?.message ?? e) };
    }
  }
  stats.misses++;
  return await launchCompute(key, produce);
}

// ---------------------------------------------------------------------------
// 超时预算（B1③）
// ---------------------------------------------------------------------------
/**
 * 预算对象：一次重算的总时限（默认 1.2s）+ 逐源降级记录。
 * 用法：`if (!budget.allow('board', 400)) return { ok:false, reason:'超时预算不足' };`
 */
export function createBudget(totalMs = SHARD_BUDGET_MS, now = Date.now()) {
  const startedAt = now;
  const deadline = now + Math.max(0, totalMs);
  const degraded = [];
  return {
    totalMs,
    startedAt,
    deadline,
    /** 剩余预算（ms）。 */
    remaining(nowMs = Date.now()) { return Math.max(0, deadline - nowMs); },
    /** 已用（ms）。 */
    usedMs(nowMs = Date.now()) { return Math.max(0, nowMs - startedAt); },
    /** 是否已超预算。 */
    expired(nowMs = Date.now()) { return nowMs >= deadline; },
    /**
     * 申请预算：剩余够 → true；不够 → 记降级原因并返回 false（调用方必须显式标注不可探测）。
     * @param {string} label 源名（进 degraded 文案）
     * @param {number} needMs 该源预估需要的毫秒
     */
    allow(label, needMs = 0, nowMs = Date.now()) {
      if (this.remaining(nowMs) >= needMs) return true;
      degraded.push(`${label}: 超时预算不足（剩余 ${this.remaining(nowMs)}ms < 需要 ${needMs}ms，总 ${totalMs}ms）`);
      return false;
    },
    /** 记一条降级原因（源自身失败/不可探测时用）。 */
    note(label, reason) { degraded.push(`${label}: ${reason}`); },
    snapshot(nowMs = Date.now()) {
      return {
        totalMs,
        usedMs: this.usedMs(nowMs),
        remainingMs: this.remaining(nowMs),
        expired: this.expired(nowMs),
        degraded: [...degraded],
      };
    },
  };
}

/**
 * 给 Promise 套超时（不中断底层工作，只保证调用方按时拿到结果）。
 * 底层未被中断的部分完成后仍会写入缓存，下次直接命中（可接受）。
 */
export async function withTimeout(promise, ms, onTimeout = null) {
  if (!(ms > 0)) return { ok: false, timedOut: true, value: onTimeout ? onTimeout() : null };
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).then((value) => ({ ok: true, timedOut: false, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, timedOut: true, value: onTimeout ? onTimeout() : null }), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
