// dsh-butler-panel / lib/panel-switches.mjs
//
// 【V3.0.0 功能面 · 判据 15 缺口补 · 2026-10-26】面板运行期开关（一个键控一件事，fail-open）
//
// 为什么要它（真源 `docs\交付报告-V3功能面-判据15一键关回-20261022.md` L30/L40/L162）：
//   改前 SWR / 开机预热 / 首屏 SLI 段**都没有用户可用开关** —— 真要关只能「换回旧文件 + deploy + 重启 dsh」
//   （A-2 更糟：回滚点只有 10-19，会连带回滚 46 行后续前端改动）。本模块提供**只改一个 JSON 键**就关回的路。
//
// 载体（与 `tools\dsh-butler\lib\state-paths.mjs#resolveStatePath` **同口径**，但不跨树 import ——
//   本文件会部署进 node_modules，跨树相对路径在别处解析不开）：
//   `<DSH_HOME>` 下两份候选：`ops-autonomy-limits.json`（2c-B7 去私有化后的新名，写侧 primary）
//   与 `butler-autonomy-limits.json`（旧名，双写期 mirror）；
//   **两份并存时取 mtime 更新那份**（照生产读侧；不是"新名优先"），都不在时取新名。
//
// 语义（本卡最硬的判据 = 默认等价）：
//   · **只有 JSON 布尔 `false` 才判「关」**；
//   · 缺键 / 段缺失 / 文件缺失 / JSON 解析失败 / 值是字符串 "false" / 0 / null ⇒ 一律判「开」。
//     ⇒ **fail-open 到改前现状**：缺键绝不会把能力变成关（这是卡里点名的一条要求）。
//
// 缓存：mtime + TTL（默认 5 s），照 module-gate 的写法 —— 每请求都读盘会把面板首屏拖慢，
//   而 5 s 窗口满足「改键后 ≤5 s 新行为可见」的验收判据。读失败也缓存（异常时不至于每请求重读）。
//
// 只读：本模块**不写任何文件**（面板红线 R7）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 开关 id（用户可见名）。`swr` = 首屏 SWR 缓存 + 开机/周期预热；`sli` = 首屏 SLI 段渲染。 */
export const PANEL_SWITCH_IDS = Object.freeze(['swr', 'sli']);

/** 状态文件名（读序见文件头；`ops-` 优先）。 */
export const SWITCH_FILE_LEGACY = 'butler-autonomy-limits.json';
export const SWITCH_FILE_PREFERRED = 'ops-autonomy-limits.json';
/** 段名。 */
export const SWITCH_SECTION = 'panelSwitches';
/** 缓存 TTL：验收判据要求「改键后 ≤5 s 生效」。 */
export const SWITCH_TTL_MS = 5000;

/** 开关的人类可读说明（CLI / 报告共用，避免两处口径打架）。 */
export const SWITCH_META = Object.freeze({
  swr: {
    label: '首屏 SWR 缓存 + 开机/周期预热',
    on: '开（缓存过期未超硬上限时先端旧值 + 后台重算；boot 后 18 s 预热 core+feed，之后每 12 分钟一轮）',
    off: '关（回到改前：缓存过期即阻塞重算；预热定时器不真算）',
  },
  sli: {
    label: '首屏 SLI 段渲染',
    on: '开（首屏渲染 SLO 尾部 SLI 结论段）',
    off: '关（该段不渲染，DOM 里查不到；其余面板不受影响）',
  },
});

/** 状态目录（与 `tools\dsh-butler\lib\state-paths.mjs` 同优先级：BUTLER_DSH_HOME > DSH_HOME > ~/.dsh）。 */
export function switchHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(os.homedir(), '.dsh');
}

/** 解析实际要读的那份文件。只读判断，不抛。
 *
 * ⚠️ 口径必须与 `tools\dsh-butler\lib\state-paths.mjs#resolveStatePath` **逐条一致**（2026-10-26 现读源码核过）：
 *   ① 两份都存在 ⇒ **取 mtime 更大那份**（不是"ops 优先"！）；
 *   ② 只存在一份 ⇒ 用它；
 *   ③ 都不存在 ⇒ 新名（将来写侧会建它）。
 *   旧实现写成"ops 存在即优先"会与生产读侧分叉：实测 2026-10-22 两份并存且 `butler-`（旧名）mtime 更新 ⇒
 *   生产读旧名、本模块若读新名就是两个口径 —— 这类"读了另一份"的假绿最难查，所以按 mtime 来。
 */
export function resolveSwitchFile(home = switchHome(), io = fs) {
  const base = String(home);
  const preferred = path.join(base, SWITCH_FILE_PREFERRED);
  const legacy = path.join(base, SWITCH_FILE_LEGACY);
  const mt = (p) => { try { return io.existsSync(p) ? io.statSync(p).mtimeMs : -1; } catch { return -1; } };
  const mNew = mt(preferred);
  const mOld = mt(legacy);
  if (mNew < 0 && mOld < 0) return preferred;
  if (mNew < 0) return legacy;
  if (mOld < 0) return preferred;
  return mNew >= mOld ? preferred : legacy;
}

let cache = null; // { at, mtimeMs, file, values, reasons, ok }

/**
 * 读当前开关值。
 * @param {object} [opts]
 * @param {string} [opts.home] 状态目录（默认 switchHome()）
 * @param {() => number} [opts.now]
 * @param {number} [opts.ttlMs] 缓存窗口（默认 5000）
 * @param {boolean} [opts.force] 跳过缓存（CLI / 自检用）
 * @param {any} [opts.fsImpl] 注入 fs（夹具用）
 * @returns {{ok:boolean, file:string, mtimeMs:number, at:number, values:Record<string,boolean>, reasons:Record<string,string>}}
 */
export function readPanelSwitches(opts = {}) {
  const io = opts.fsImpl ?? fs;
  const nowMs = typeof opts.now === 'function' ? opts.now() : Date.now();
  const ttlMs = Number.isFinite(opts.ttlMs) ? Number(opts.ttlMs) : SWITCH_TTL_MS;
  const file = opts.file ?? resolveSwitchFile(opts.home ?? switchHome(), io);

  let mtimeMs = -1;
  try {
    mtimeMs = io.existsSync(file) ? io.statSync(file).mtimeMs : -1;
  } catch {
    mtimeMs = -1;
  }
  if (!opts.force && cache && cache.file === file && cache.mtimeMs === mtimeMs && nowMs - cache.at < ttlMs) return cache;

  const values = {};
  const reasons = {};
  let ok = false;

  if (mtimeMs < 0) {
    for (const id of PANEL_SWITCH_IDS) { values[id] = true; reasons[id] = 'config-missing(fail-open=开)'; }
  } else {
    let raw = null;
    try {
      raw = JSON.parse(io.readFileSync(file, 'utf8'));
    } catch (e) {
      const why = 'config-unreadable(fail-open=开):' + String((e && e.message) || e);
      for (const id of PANEL_SWITCH_IDS) { values[id] = true; reasons[id] = why; }
    }
    if (raw) {
      ok = true;
      const section = raw && typeof raw === 'object' ? raw[SWITCH_SECTION] : undefined;
      for (const id of PANEL_SWITCH_IDS) {
        if (!section || typeof section !== 'object') {
          values[id] = true;
          reasons[id] = 'section-missing(fail-open=开)';
          continue;
        }
        const v = section[id];
        if (v === false) { values[id] = false; reasons[id] = 'off'; continue; }
        if (v === true) { values[id] = true; reasons[id] = 'on'; continue; }
        if (v === undefined) { values[id] = true; reasons[id] = 'key-missing(fail-open=开)'; continue; }
        // 非布尔值（"false" / 0 / null / {} …）⇒ 判开并标明非法，避免"以为关了其实还开着"说不清
        values[id] = true;
        reasons[id] = 'invalid-value(fail-open=开):' + JSON.stringify(v);
      }
    }
  }

  cache = { at: nowMs, mtimeMs, file, values, reasons, ok };
  return cache;
}

/**
 * 单个开关当前是否开（true = 开 = 改前行为）。id 不认识 ⇒ 一律 true（fail-open）。
 * @param {'swr'|'sli'} id
 * @param {object} [opts] 同 readPanelSwitches
 */
export function panelSwitchOn(id, opts = {}) {
  if (!PANEL_SWITCH_IDS.includes(id)) return true;
  const r = readPanelSwitches(opts);
  return r.values[id] !== false;
}

/** 测试用：清掉进程内缓存（生产路径无需调用）。 */
export function resetPanelSwitchCache() { cache = null; }
