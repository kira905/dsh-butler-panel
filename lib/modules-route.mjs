// dsh-butler-panel / lib/modules-route.mjs —— 「模块级熔断开关」（kill switch L2）Host 侧逻辑
//
// 由来（规则 R4「开关是活的」，2026-09-13 主人定）：哪个模块坏了，直接关掉再去修。
// 四级熔断：L0 全局降档（butler-autonomy-state.json 的 level）/ L1 总开关（butler-autonomy.json 四键）
//           / **L2 模块级（本文件，butler-autonomy.json 的 modules 段）** / L3 动作级。
//
// **唯一真相源 = lib/autonomy-modules.mjs**：本文件不新增任何存储、不改 baseline，
//   读走 describeModules() + checkModuleAllowed()，写走 setModuleEnabled()（原子写 + 审计 + moduleHistory）。
// 抽成独立模块（而不是内联在 index.js 的 apply 里）的唯一原因：**写开关是危险动作**，
//   生产 home 上禁实测 —— 单测可在沙箱 home 下直接调用同一段逻辑（_test/test-modules-route.mjs）。
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { butlerLib as butlerLibDir } from './butler-root.mjs';

/**
 * 默认 home（DSH 数据根）解析：口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh
 *   —— 与 tools/lib/dsh-home.mjs 的 resolveDshHome、tools/dsh-butler/lib/paths.mjs 的 dshHome() 同源。
 * ★2026-09-14 环境边界修复（卡：自研组件去 os.homedir() 硬编码）：原为模块加载期常量
 *   `const DEFAULT_HOME = path.join(os.homedir(), '.dsh')` → 测试/金丝雀实例里**点面板的
 *   模块开关会写到生产** `~/.dsh/butler-autonomy.json`（L2 熔断配置被静默改）。改为函数现读。
 *   不设环境变量时结果与改造前逐字节一致。注意：调用方一律**调用时**取 `dshHome()`，
 *   不要在模块顶层再抓成常量。
 */
export function dshHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh');
}
const BUTLER_LIB = butlerLibDir();

/** runAction() 第三道闸恒查的 L1 键（与 CLI `module list` 末尾恒定口径同源；lib\autonomy-actions.mjs，位置=dry-run 通道之后）。 */
export const RUN_ACTION_ALWAYS_KEY = 'p3AutoEnabled';
/** CLI `module list` 末尾第一行恒定口径提示（前端照抄呈现，凭此与 CLI 逐字对照）。 */
export const RUN_ACTION_GATE_NOTE = 'runAction() 第三道闸恒查 p3-auto（lib\\autonomy-actions.mjs，位置=dry-run 通道之后）→ 任何自主动作放行都额外需要 p3AutoEnabled';

/**
 * 派生「放行一个 raw 模块实际要几把键」——**纯呈现，绝不参与判定**。
 *   批次9（2026-09-14）：butler 侧 `rawOwner` / `rawOwnerOn` 只回报不判定（见 lib/autonomy-modules.mjs 的
 *   「L1 归属口径」），但"要几把键"这个口径原先只印在 CLI 的恒定口径行里、面板看不到 → 口径不一致。
 *   这里把它按**同一规则**派生（p3 恒查在前 → 模块门 owner（若不同）→ 通道级 raw），
 *   于是前端**不用复制任何模块清单**（butler 侧加一个 raw 模块，面板自动跟着变）：
 *     · p0-auto-restart  （owner=p3AutoEnabled, raw=p0AutoRestartEnabled）→ 两把
 *     · p5-auto-rollback （owner=autoHealEnabled, raw=p5AutoRollbackEnabled）→ 三把
 * @returns {{keys:string[],expr:string,count:number,countText:string}|null}
 */
function rawGateOf(owner, rawOwner) {
  if (!rawOwner) return null;
  const keys = [RUN_ACTION_ALWAYS_KEY];
  if (owner && owner !== RUN_ACTION_ALWAYS_KEY) keys.push(owner);
  keys.push(rawOwner);
  return {
    keys, expr: keys.join(' && '), count: keys.length,
    countText: keys.length === 2 ? '两把' : keys.length === 3 ? '三把' : keys.length + ' 把'
  };
}

/** CLI 第二行恒定口径的派生版本（模块清单不写死，随 MODULE_IDS 走）。 */
function rawGateHintOf(modules) {
  const rows = modules.filter((x) => x.rawOwner && x.rawGate).sort((a, b) => a.rawGate.count - b.rawGate.count);
  if (!rows.length) return null;
  return '标 raw 的模块放行要两/三把键：' + rows.map((x) => x.id + ' = ' + x.rawGate.expr + '（' + x.rawGate.countText + '）').join('· ');
}

let libCache = null;
/** 动态 import butler 侧 lib（缺失/损坏 → 抛给调用方降级，绝不拖垮面板启动）。 */
async function butlerLib() {
  if (libCache) return libCache;
  const mods = await import(pathToFileURL(path.join(BUTLER_LIB, 'autonomy-modules.mjs')).href);
  const auto = await import(pathToFileURL(path.join(BUTLER_LIB, 'autonomy.mjs')).href);
  // 🌒 影子视图（卡：V3 批次 1）：缺失不影响模块开关卡本身 → 单独 try，降级为 null
  let shadow = null;
  try { shadow = await import(pathToFileURL(path.join(BUTLER_LIB, 'shadow-view.mjs')).href); } catch { shadow = null; }
  // ① 包 P-3/P-5（施工卡 ①-1）：控制室判据底座（**唯一判定入口**）——
  //   缺失/损坏 → 降级为 null（本卡照常渲染既有字段，绝不拖垮面板）。
  let verdict = null;
  try { verdict = await import(pathToFileURL(path.join(BUTLER_LIB, 'control-room-verdict.mjs')).href); } catch { verdict = null; }
  libCache = { mods, auto, shadow, verdict };
  return libCache;
}

/**
 * 采集模块开关全景（只读）。
 * 单模块键（批次9 起）：id / label / owner / **rawOwner / rawOwnerOn / rawGate** / enabled / source /
 *   since / by / why / ownerOn / allowed / blockedBy / level / degraded。
 *   其中 rawOwner·rawOwnerOn 由 butler 侧 checkModuleAllowed() 原样透传（**只回报，不参与判定**）；
 *   rawGate 是本文件派生的**呈现**字段（放行要几把键），判定面仍全在 butler 侧。
 * @param {{home?:string}} [opts]
 * @returns {Promise<{ok:boolean,file:string|null,reason:string,level:string,degraded:boolean,
 *   count:number,enabledCount:number,disabledCount:number,l1:Record<string,boolean>|null,
 *   runActionGateNote:string,rawGateHint:string|null,modules:Array<object>, error?:string}>}
 */
export async function collectModules(opts = {}) {
  const home = opts.home ?? dshHome();
  try {
    const lib = await butlerLib();
    const { mods, auto } = lib;
    const d = mods.describeModules({ home });
    // L1 总开关必须**显式传入** checkModuleAllowed（否则 ownerOn=null，判定退化成"未提供"）
    let autonomy = null;
    try { autonomy = auto.readAutonomy({ home }); } catch { autonomy = null; }
    const modules = (d.modules ?? []).map((m) => {
      const c = mods.checkModuleAllowed(m.id, { home, autonomy });
      return {
        id: m.id, label: m.label, owner: m.owner,
        // 批次9：butler 侧已有的 raw 两字段**原样透传**（只回报呈现，判定面一行不动）
        rawOwner: c.rawOwner ?? null,
        rawOwnerOn: c.rawOwnerOn ?? null,
        rawGate: rawGateOf(c.owner ?? m.owner ?? null, c.rawOwner ?? null),
        enabled: m.enabled === true, source: m.source, since: m.since, by: m.by, why: m.why,
        ownerOn: c.ownerOn, allowed: c.allowed === true, blockedBy: c.reason, level: c.level, degraded: c.degraded === true
      };
    });
    // ① 包 P-3（施工卡 ①-1）：**追加**判定字段 —— 既有字段一个不改
    //   （`verify-after-restart.mjs:175-179` 的 `/modules` 行契约要求 `rawOwnerOn` 三态 / `rawGate` 原样）。
    //   伪模块行的 `verdict` 是**总闸语义**（`p3-auto` ⇒ 放行/关闭 P3 全族），其 L2 原值另存 `moduleAllowed`。
    const rawOf = (k) => { const v = autonomy?.raw?.[k]; return typeof v === 'boolean' ? String(v) : '未提供'; };
    let verdicts = null;
    if (lib.verdict?.describeModuleVerdicts) {
      try {
        const v = lib.verdict.describeModuleVerdicts({ home, autonomy });
        verdicts = {
          version: lib.verdict.CONTROL_ROOM_VERDICT_VERSION ?? null,
          counts: v.counts,
          families: v.families,
          unavailable: (v.unavailableRows ?? []).map((x) => ({ id: x.id, source: x.source, reason: x.reason })),
          // 「关着的清单」= 动作模块里被拒的行（**伪模块行不在其中** —— ① 包判据 1 第二条）
          blockedIds: v.blockedIds,
          degraded: v.degraded === true,
          level: v.level,
        };
        for (const row of modules) {
          const hit = (v.modules ?? []).find((x) => x.id === row.id) ?? null;
          row.pseudo = hit?.pseudo === true;
          row.pseudoWhy = hit?.pseudoWhy ?? null;
          row.scope = hit?.scope ?? null;
          row.verdict = hit?.verdict ?? null;
          row.verdictText = hit
            ? lib.verdict.moduleVerdictLine(hit, { rawOf, family: (v.families ?? []).find((f) => f.row === hit.id) ?? null })
            : null;
          row.gateOn = hit?.gateOn ?? null;
          row.moduleAllowed = hit?.moduleAllowed ?? null;
          row.moduleReason = hit?.moduleReason ?? null;
        }
      } catch (e) {
        verdicts = { error: String(e?.message ?? e), unavailable: [], blockedIds: [], families: [], counts: null };
      }
    }
    // 🌒 影子（若开启会执行）：与日报「🌒 影子」段**同一份计数**（同一 lib、同一纯只读采集）。
    //   只读语义：不写 state、不改开关；采集失败 → null（前端降级显示"不可用"，不影响模块开关卡）。
    let shadow = null;
    if (lib.shadow?.collectShadow) {
      try {
        const raw = lib.shadow.collectShadow({ home });
        shadow = { ...raw, summary: lib.shadow.shadowSummaryLine(raw) };
      } catch (e) {
        shadow = { ok: false, hasShadow: false, error: String(e?.message ?? e), emptyText: '无（全部动作按档位关闭）' };
      }
    }
    return {
      ok: d.ok === true,
      file: d.file ?? null,
      reason: d.reason ?? 'unknown',
      level: d.level ?? 'unknown',
      degraded: modules.length ? modules[0].degraded : false,
      count: modules.length,
      enabledCount: modules.filter((x) => x.enabled).length,
      disabledCount: modules.filter((x) => !x.enabled).length,
      // 注意：readAutonomy() 的键是**顶层展开**（实现里没有 JSDoc 提到的 switches 字段）→ 此处显式取
      // 【P8 [12] · 2026-09-28】四键 → **五键**：补 `p8AutoEnabled`（P8 L2 搬移的独立自治闸）。
      //   ⚠️ 只补"呈现面"：面板多显示一把钥匙；判定仍走 `checkModuleAllowed`/`control-room-verdict`
      //   （唯一入口），此处不做任何放行判断（本行只是把 raw 值透给前端渲染）。
      l1: autonomy ? {
        p3AutoEnabled: autonomy.p3AutoEnabled === true,
        p0AutoRestartEnabled: autonomy.p0AutoRestartEnabled === true,
        p5AutoRollbackEnabled: autonomy.p5AutoRollbackEnabled === true,
        autoHealEnabled: autonomy.autoHealEnabled === true,
        p8AutoEnabled: autonomy.p8AutoEnabled === true
      } : null,
      l1Effective: autonomy?.effective ?? null,
      // 批次9：CLI 恒定口径两行（第一行照抄、第二行按 MODULE_IDS 派生）→ 面板与 CLI 同一口径
      runActionGateNote: RUN_ACTION_GATE_NOTE,
      rawGateHint: rawGateHintOf(modules),
      shadow,
      // ① 包 P-3：控制室判定口径（**唯一入口** `lib/control-room-verdict.mjs`）—— 面板只渲染，不自算
      verdicts,
      modules
    };
  } catch (e) {
    return {
      ok: false, file: null, reason: `lib-unavailable:${e?.message ?? e}`, level: 'unknown', degraded: false,
      count: 0, enabledCount: 0, disabledCount: 0, l1: null, shadow: null,
      runActionGateNote: RUN_ACTION_GATE_NOTE, rawGateHint: null, modules: [],
      error: String(e?.message ?? e)
    };
  }
}

/**
 * 【卡「冲刺600 · 补面板残余」· gap-3-46 · 2026-10-10】服务端**拒关 infra 四件**（控制室口径包 P-1）。
 *
 * 已拍口径真源 = `docs\控制室口径包-方案-20260917.md` §3.1 表 + §7.2②（主人 2026-09-17 09:5x–10:1x 拍板）：
 *   「`/modules/set` **禁止**关 infra 四件」= `guard` / `tickd-jobs` / `session-title-live` / `p5-protected-paths`；
 *   §7.2④ 后果行写死「**关 infra 件被拒**（保护保命能力）」。
 *   矩阵档 `docs\大管家-开关矩阵与放行判据-20260913.md` 也把它列为该写口的待补项（D 级「从面板关 infra 四件」明确禁止）。
 *
 * 实现纪律：
 *   · 判定真源 = butler lib `MODULE_IDS` 的 `scope === 'infra'` —— **本文件不写死第二份四件清单**
 *     （清单随 MODULE_IDS 自动变；实测当前恰为 4 件，由 `_test/test-modules-route.mjs` §9 逐件断言）；
 *   · 只拦**"关"**（`enabled === false`）：开回来照旧放行（口径只禁关）；
 *   · fail-closed：判定读不到配置 ⇒ `readModules` 按 fail-safe 回落 baseline（infra 类 failSafe=baseline
 *     ⇒ `enabled` 保持现状、`scope` 仍来自 MODULE_IDS）⇒ **拒关不受配置损坏影响**（保护方向不因读不到而消失）；
 *   · ⚠️ 只管**面板这条写口**：CLI 出口（`butler-autonomy-cli.mjs module off`）**不受影响** ——
 *     §7.2③ 明写「面板不可用 → 走 CLI」，面板拒关 ≠ 全系统关不掉（排障通道保留）。
 */
export const INFRA_REFUSE_CODE = 'infra-protected';

/** 拒关留痕（走既有审计哈希链 `lib/audit.mjs`；审计不可用**不阻断**拒关应答）。 */
async function recordModuleRefusal({ home, id, scope, by, why, source }) {
  try {
    const m = await import(pathToFileURL(path.join(BUTLER_LIB, 'audit.mjs')).href);
    m?.appendAudit?.({ type: 'module-refused', module: id, reason: INFRA_REFUSE_CODE, scope, source, by, why },
      { home, silent: true });
  } catch { /* 审计不可用不影响"拒关"这个保护动作本身 */ }
}

/**
 * 写单个模块开关（原子写 + 审计；why 必填）。
 * 返回 {status, body} 由路由原样回执；校验失败一律 400 + 明确 code/文案。
 * @param {{id?:string,enabled?:boolean,why?:string}} body
 * @param {{home?:string,by?:string}} [opts]
 */
export async function setModuleEnabledViaApi(body, opts = {}) {
  const home = opts.home ?? dshHome();
  const by = opts.by ?? 'panel';
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) {
    return { status: 400, body: { ok: false, code: 'missing-id', error: '缺少模块 id（body.id）' } };
  }
  if (typeof body?.enabled !== 'boolean') {
    return { status: 400, body: { ok: false, code: 'bad-enabled', error: `enabled 必须是 true / false（实得 ${JSON.stringify(body?.enabled)}）` } };
  }
  const why = typeof body?.why === 'string' ? body.why.trim().slice(0, 200) : '';
  if (!why) {
    return { status: 400, body: { ok: false, code: 'missing-why', error: '必须填写理由（body.why）：开关变更必须可溯源（写审计流水 + 日报）' } };
  }
  try {
    const { mods } = await butlerLib();
    if (!mods.isKnownModule(id)) {
      return { status: 400, body: { ok: false, code: 'unknown-module', error: `模块 ${id} 未登记（MODULE_IDS）：拒绝写入；可操作清单见 GET /api/dsh-butler/modules` } };
    }
    // ── 【gap-3-46】服务端拒关 infra 四件（位置：isKnownModule 之后、真写之前；拒的是"关"这个方向）──
    if (body.enabled === false) {
      const row = (mods.readModules({ home }).modules ?? {})[id] ?? null;
      if (row?.scope === 'infra') {
        await recordModuleRefusal({ home, id, scope: row.scope, by, why, source: row.source ?? null });
        return {
          status: 400,
          body: {
            ok: false,
            code: INFRA_REFUSE_CODE,
            module: id,
            scope: row.scope,
            state: 'unchanged',
            error: `模块 ${id} 属基础设施类（scope=infra）：**面板拒绝关闭** —— 它是保命/保护能力（口径见控制室口径包 §7.2②，主人 2026-09-17 已拍）。`
              + `如确需关（排障），走 CLI 出口：node <butler-root>/butler-autonomy-cli.mjs module off ${id} --reason "…"（面板不可用时 CLI 就是唯一出口，§7.2③）。`,
          },
        };
      }
    }
    const r = mods.setModuleEnabled(id, body.enabled, { by, why, home });
    if (!r.ok) return { status: 500, body: { ok: false, code: 'write-failed', error: r.error ?? '写入失败' } };
    const state = await collectModules({ home });
    const hit = (state.modules ?? []).find((x) => x.id === id) ?? null;
    return {
      status: 200,
      body: { ok: true, module: id, before: r.before, after: r.after, at: r.at, by, why, file: r.file, moduleState: hit, state }
    };
  } catch (e) {
    return { status: 500, body: { ok: false, code: 'unavailable', error: String(e?.message ?? e) } };
  }
}
