// dsh-butler-panel / lib/advice-hook.mjs —— 「日报被重新生成」↔「P2.5 重跑」的绑定钩子
//
// 【卡 0 · B6④（2026-09-14）】修的是什么：
//   P2.5（日报 LLM 解读，追加「## 💡 建议」段）原先只挂在**开机钩子**那条链上
//   （butler-daily-onboot.cmd: report.mjs → report-advice.mjs）。而日报**不止那一个生成入口**：
//   `butler-tickd.mjs` 的 daily job（09:00 兜底）直接跑 report.mjs —— 它把日报**整份覆盖重写**，
//   刚追加的建议段随之消失。实测（2026-09-14）：00:28 onboot 链已追加 6 行建议 → 11:47 daily job
//   重写日报 → 当日日报再没有「## 💡 建议」段。
//
// 方案（v1.1 §D 施工序列卡 0 的**乙案**）：把触发点下沉到**日报落盘成功之后**，
//   由 report.mjs 自己调本模块 → **任何入口**（onboot cmd / tickd daily job / 手工 / 将来新增）
//   只要"日报被重新生成"，P2.5 就跟着重跑一次，天然覆盖全部入口，不靠"每个入口各自记得链"。
//   （甲案 = 给 tickd job 加 wrapper：只修了已知那一个入口，将来再加入口还会漏。）
//
// 硬约束（全部保留）：
//   ① 幂等：日报已含「## 💡 建议」或降级行 → generateAdvice 自己跳过（同日不重复烧额度）
//   ② 开关：docs\管家报告\.advice-config.json {enabled:false} 仍然有效（主人可关）
//   ③ 互斥：复用 butler 的 tick 锁 `p5-advice`（与 report-advice.mjs 同一把，抢不到就静默跳过）
//   ④ **绝不影响日报本身**：任何异常都被吞成本模块的返回值；调用方不得因此改退出码
//   ⑤ 可关：`--no-advice`（argv）或 `DSH_BUTLER_NO_ADVICE=1`（环境）→ 跳过（测试/排障用）
//
// 本文件只做"编排"：判定/生成全在 `<butler root>/lib/advice.mjs`（共享底座）。
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { butlerLib } from './butler-root.mjs';

/** 本钩子版本（≤ 产品版本，见 lib/version.mjs 的约定）。 */
export const ADVICE_HOOK_VERSION = '0.1.0';
/** 关闭环境变量（值为 1/true 时跳过）。 */
export const NO_ADVICE_ENV = 'DSH_BUTLER_NO_ADVICE';
/** 关闭命令行参数。 */
export const NO_ADVICE_FLAG = '--no-advice';
/** P2.5 互斥锁名（与 report-advice.mjs 完全一致 —— 两个入口不许并发烧额度）。 */
export const ADVICE_LOCK_NAME = 'p5-advice';
/** 锁 TTL（与 report-advice.mjs 一致）。 */
export const ADVICE_LOCK_TTL_MS = 180_000;
const BUTLER_LIB_DIR = butlerLib();

/** 本次运行是否显式关闭 P2.5（argv / env 任一命中即关）。 */
export function isAdviceDisabled({ argv = process.argv.slice(2), env = process.env } = {}) {
  const raw = env?.[NO_ADVICE_ENV];
  if (raw === '1' || String(raw ?? '').toLowerCase() === 'true') return true;
  return Array.isArray(argv) && argv.includes(NO_ADVICE_FLAG);
}

/** DSH 数据根（与 report.mjs / advice.mjs 同口径）。 */
function resolveHome(env = process.env) {
  const override = env?.BUTLER_DSH_HOME || env?.DSH_HOME;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(os.homedir(), '.dsh');
}

/** 默认加载器：动态 import butler lib（Windows 下 ESM 不吃绝对路径 → 必须 pathToFileURL）。 */
async function defaultLoader() {
  const advice = await import(pathToFileURL(path.join(BUTLER_LIB_DIR, 'advice.mjs')).href);
  const store = await import(pathToFileURL(path.join(BUTLER_LIB_DIR, 'store.mjs')).href);
  return { advice, store };
}

/** 把返回值翻译成一行日志（与 report-advice.mjs 的 MAP 同口径，便于日报链路日志比对）。 */
export function describeResult(r, head = '## 💡 建议') {
  if (!r) return '无返回（异常）';
  const usage = r.usage?.total_tokens ? ` · tokens ${r.usage.prompt_tokens ?? '?'}+${r.usage.completion_tokens ?? '?'}=${r.usage.total_tokens}` : '';
  const map = {
    ok: `已写入「⏱ 三分钟版」${r.digestLines ?? 0} 行（顶部）+「${head}」${r.lines} 行（${r.model ?? 'glm-4.5-air'} · ${r.ms}ms${usage} · 一次调用）`,
    'ok-partial': `半截：只出了${r.digest ? `「⏱ 三分钟版」${r.digestLines} 行` : `「${head}」${r.lines} 行`}（同日不重试）`,
    degraded: `降级：已写不可用行（${r.reason ?? '未知'} · ${r.ms}ms）`,
    'skip-idempotent': '同日已有解读，跳过',
    disabled: '开关已关（.advice-config.json enabled=false），未生成',
    'no-report': '未找到当日日报，跳过',
    'write-failed': `写入失败：${r.reason}（日报保持原样）`,
    locked: `已有实例在跑（${r.reason ?? '锁占用'}），跳过`,
    'disabled-by-flag': `本次调用被显式关闭（${NO_ADVICE_FLAG} / ${NO_ADVICE_ENV}）`,
    error: `出错：${r.reason}`,
  };
  return map[r.status] ?? JSON.stringify(r);
}

/**
 * 日报落盘成功后触发 P2.5（**幂等 / 可关 / 永不抛错**）。
 *
 * @param {{date?:string, host?:string, reportFile?:string, ledgerFile?:string, configFile?:string,
 *          dshRoot?:string, force?:boolean, dryRun?:boolean, argv?:string[], env?:object,
 *          logger?:(msg:string)=>void, loader?:Function}} [opts]
 *        reportFile 建议由调用方直接给（日报刚写的那一份，路径口径最准）。
 * @returns {Promise<{status:string, [k:string]:any}>} status: ok | degraded | skip-idempotent |
 *          disabled | no-report | write-failed | locked | disabled-by-flag | error
 */
export async function runAdviceAfterReport(opts = {}) {
  const env = opts.env ?? process.env;
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};
  if (isAdviceDisabled({ argv: opts.argv, env })) {
    return { status: 'disabled-by-flag' };
  }
  try {
    const loader = typeof opts.loader === 'function' ? opts.loader : defaultLoader;
    const { advice, store } = await loader();
    const home = resolveHome(env);
    const lock = store.acquireTickLock(ADVICE_LOCK_NAME, { ttlMs: ADVICE_LOCK_TTL_MS, home });
    if (!lock || lock.ok !== true) {
      return { status: 'locked', reason: lock?.reason ?? 'lock-unavailable' };
    }
    try {
      return await advice.generateAdvice({
        date: opts.date,
        host: opts.host,
        reportFile: opts.reportFile,
        ledgerFile: opts.ledgerFile,
        configFile: opts.configFile,
        dshRoot: opts.dshRoot,
        force: opts.force,
        dryRun: opts.dryRun,
        // 上游可覆盖（排障 / 单测；默认 zhipu glm-4.5-air）——口径同 report-advice.mjs
        llmOptions: {
          ...(env.DSH_BUTLER_ADVICE_BASE ? { baseUrl: env.DSH_BUTLER_ADVICE_BASE } : {}),
          ...(env.DSH_BUTLER_ADVICE_MODEL ? { model: env.DSH_BUTLER_ADVICE_MODEL } : {}),
          ...(env.DSH_BUTLER_ADVICE_TIMEOUT_MS ? { timeoutMs: Number(env.DSH_BUTLER_ADVICE_TIMEOUT_MS) } : {}),
        },
        logger: (m) => log(m),
      });
    } finally {
      try { lock.release(); } catch { /* 锁释放失败不影响日报 */ }
    }
  } catch (e) {
    // 兜底：核心库已确保不抛，这里防的是 import / 环境级意外 —— 依然不许影响日报本身。
    return { status: 'error', reason: String(e?.message ?? e) };
  }
}

export default runAdviceAfterReport;
