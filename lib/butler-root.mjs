// dsh-butler-panel / lib/butler-root.mjs
//
// 统一解析「DSH 工作区根 / 大管家工具根 / 共享库目录」——插件内**所有**跨包引用都走这里。
//
// 为什么需要它：插件部署后落在 `~/.dsh/profiles/web/node_modules/<pkg>/lib/`，
// 相对路径会解析到 `node_modules/…` 而那里没有大管家工具目录 ⇒ 静态 import 失败会
// 带崩整个 plugin tree。历史做法是写死 `file:///<绝对路径>` 形式的 URL，能用但把本机目录写进了源码。
// 本模块把那个绝对前缀换成环境变量，默认值退化为「用户主目录下的约定位置」。
//
// ── 解析顺序（**每一路都要能单独说清**）──────────────────────────────────────
//
//   1. 显式指定                    `DSH_BUTLER_LIB_DIR` / `BUTLER_ROOT`（`BUTLER_LIB_DIR` 亦认）
//                                  —— 用户明确指了就以他指的为准，优先级最高，行为不变
//   2. 工作区约定                  `<工作区>/tools/dsh-butler/lib`（工程内既有缺省，保留）
//   3. npm 包回落（本版新增）        `@kira905/dsh-butler-engine` 包内依次试
//                                  `lib/` → `src/dsh-butler/lib/` → `src/lib/` → `jobs/lib/`
//                                  （定位包根见 ./engine-search.mjs：显式 env → 模块解析 → 全局前缀）
//   4. 全落空                      占位 + **可照做**的一句指引（见 guidanceFor()）
//
// 为什么要第 3 路：全新机器上不一定有「大管家工具目录」——那本来是个人工作区里的东西。
// 但 `@kira905/dsh-butler-engine` 是**可安装的包**，装上就有同样的库。没有它时面板只能整片
// 显示「不可用」；有了它，装个包面板就能出真数据（A-8 第三关）。
//
// 🔴 三件不许做的事
//   · 不许把库代码复制进本包（面板侧不内联一份"最小实现"）—— 只**引用**，不**复制**。
//   · 不许把「找不到」伪装成成功：每一路都只认**真实存在的文件**。
//   · 不许跨进程缓存：ESM 有模块缓存，换 env 必须换进程才叫验证（否则是假绿）。
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { engineLibDirs, engineVersion, engineRoots, ENGINE_PKG } from './engine-search.mjs'

/** DSH 数据根：BUTLER_DSH_HOME > DSH_HOME > ~/.dsh。 */
export function dshHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME
  if (override && override.trim()) return path.resolve(override.trim())
  return path.join(os.homedir(), '.dsh')
}

/** DSH 工作区根：DSH_WORKSPACE > 由 home 推导 > <用户主目录>/DSH。 */
export function workspaceRoot() {
  const override = (process.env.DSH_WORKSPACE ?? '').trim()
  if (override) return path.resolve(override)
  const redirected = (process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || '').trim()
  if (redirected) {
    const home = path.resolve(redirected)
    const def = path.resolve(path.join(os.homedir(), '.dsh'))
    if (home.toLowerCase() !== def.toLowerCase() && path.basename(home).toLowerCase() === '.dsh') {
      return path.dirname(home)
    }
  }
  return path.join(os.homedir(), 'DSH')
}

/** 大管家工具根：BUTLER_ROOT > <workspace>/tools/dsh-butler。 */
export function butlerRoot() {
  const override = (process.env.BUTLER_ROOT ?? '').trim()
  if (override) return path.resolve(override)
  return path.join(workspaceRoot(), 'tools', 'dsh-butler')
}

/** 大管家共享库目录下的路径。 */
export function butlerLib(...seg) {
  return path.join(butlerLibSearchDirs()[0] ?? path.join(butlerRoot(), 'lib'), ...seg)
}

/** 工作区 `tools/` 下的路径（跨工具共享件，例如 dsh-host-rpc / panel-tokens）。 */
export function toolLib(...seg) {
  return path.join(workspaceRoot(), 'tools', ...seg)
}

/** 工作区 `tools/lib/` 下的共享件（dsh-home / session-file-name / dsh-host-rpc / production-guard 等）。 */
export function toolLibDir(...seg) {
  return path.join(workspaceRoot(), 'tools', 'lib', ...seg)
}

/** 大管家工具根下的路径（顶层 CLI 脚本等）。 */
export function butlerFile(...seg) {
  return path.join(butlerRoot(), ...seg)
}

/** 工作区 `docs/` 下的路径。 */
export function docsDir(...seg) {
  return path.join(workspaceRoot(), 'docs', ...seg)
}

/** 本地路径 → `file:///` URL（动态 import 用）。 */
export function asUrl(p) {
  return pathToFileURL(p).href
}

// ── 搜索目录（纯路径，不读文件）────────────────────────────────────────────

function dedupe(dirs) {
  const out = []
  const seen = new Set()
  for (const d of dirs) {
    if (!d) continue
    const key = d.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
  }
  return out
}

/** `<butlerRoot>/lib` 的候选目录，按优先级。第一项当「主目录」用（兼容 no-arg 调用）。 */
export function butlerLibSearchDirs() {
  const dirs = []
  // ① 显式指定 —— 优先级最高，与旧版逐字一致
  const libDir = (process.env.DSH_BUTLER_LIB_DIR ?? '').trim()
  const legacyLibDir = (process.env.BUTLER_LIB_DIR ?? '').trim()
  if (libDir) dirs.push(path.resolve(libDir))
  if (legacyLibDir) dirs.push(path.resolve(legacyLibDir))
  if ((process.env.BUTLER_ROOT ?? '').trim()) dirs.push(path.join(path.resolve(process.env.BUTLER_ROOT.trim()), 'lib'))
  // ② 工作区约定（旧版缺省）
  dirs.push(path.join(workspaceRoot(), 'tools', 'dsh-butler', 'lib'))
  // ③ npm 包回落
  dirs.push(...engineLibDirs('butler'))
  return dedupe(dirs)
}

/** `<工作区>/tools/lib` 的候选目录。 */
export function toolLibSearchDirs() {
  return dedupe([path.join(workspaceRoot(), 'tools', 'lib'), ...engineLibDirs('tool')])
}

/** 大管家工具根顶层（CLI 脚本）的候选目录。 */
export function butlerFileSearchDirs() {
  return dedupe([butlerRoot(), ...engineLibDirs('butlerFile')])
}

function firstExistingFile(dirs, name) {
  for (const dir of dirs) {
    const p = path.join(dir, name)
    try {
      if (fs.statSync(p).isFile()) return p
    } catch { /* 这一档没有 */ }
  }
  return null
}

/**
 * 某个库文件的真实路径：按 butlerLib 的候选目录顺序找，找不到返回旧版缺省路径
 * （调用方据此拼错误信息，用户在提示里看到的仍是"你以为该在的地方"）。
 */
export function butlerLibPath(name) {
  return firstExistingFile(butlerLibSearchDirs(), name) ?? path.join(butlerRoot(), 'lib', name)
}

/** `<工作区>/tools/lib` 版。 */
export function toolLibPath(name) {
  return firstExistingFile(toolLibSearchDirs(), name) ?? toolLibDir(name)
}

/** 大管家工具根顶层版（`butlerFile` 的加载用）。 */
export function butlerFilePath(name) {
  return firstExistingFile(butlerFileSearchDirs(), name) ?? butlerFile(name)
}

/** 诊断用：某文件命中了哪一路（找不到返回 null）。 */
export function butlerLibHit(name) {
  return firstExistingFile(butlerLibSearchDirs(), name)
}

// ── 占位与加载 ─────────────────────────────────────────────────────────────

/**
 * 降级话术：**可照做**，不是「不可用」三个字。
 * 版本号取 engine 包的**实际版本**（读不到就退成不带版本的安装命令——不写死一个会过期的号）。
 */
export function guidanceFor(name) {
  const v = engineVersion()
  const install = v ? `npm i -g ${ENGINE_PKG}@^${v}` : `npm i -g ${ENGINE_PKG}`
  // 出路按 README 变量表的**顺位**给全：① 装可安装的包 ② 显式 BUTLER_ROOT ③ DSH_WORKSPACE（工作区根，
  //   解析 `<工作区>/tools/dsh-butler/lib` 的第一顺位）。0.9.6 补 ③：原来只给前两条，用户把
  //   DSH_WORKSPACE 指错时，这条日志对着他"工作区"这件事一个字都没提。
  return `缺 ${name}：装 ${install}，或设 BUTLER_ROOT=<你的大管家工具目录>，`
    + `或设 DSH_WORKSPACE=<你的 DSH 工作区（tools/ 与 docs/ 所在那层）>`
}

function unavailableStub(name) {
  const msg = guidanceFor(name)
  const stub = function () { throw new Error(msg) }
  // 让调用方能在"不触发调用"的前提下认出这是占位（例如 `X = mod.Foo ?? null` 之后再 `new X()`）。
  Object.defineProperty(stub, 'butlerUnavailable', { value: true, enumerable: false })
  // 排障用：到底找过哪些目录、装没装包（不进错误文本，避免刷屏）
  Object.defineProperty(stub, 'butlerSearched', {
    value: { dirs: butlerLibSearchDirs(), engineRoots: engineRoots() },
    enumerable: false,
  })
  // `then` 必须显式排除：否则这个对象会被当成 thenable，await / Promise.resolve 会挂住。
  return new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : stub) })
}

const MISSING_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ENOENT'])

async function loadOrStub(resolvePath, name) {
  const target = resolvePath(name)
  let exists = false
  try { exists = fs.statSync(target).isFile() } catch { /* 不存在 */ }
  if (!exists) {
    try { console.warn(`[butler-panel] ${guidanceFor(name)}`) } catch { /* 控制台不可用就算了 */ }
    return unavailableStub(name)
  }
  try {
    return await import(asUrl(target))
  } catch (e) {
    // 文件在、但它自己的依赖缺（例如只搬了半个闭包）——同样降级，不让面板整棵挂掉。
    if (MISSING_CODES.has(e?.code)) {
      try { console.warn(`[butler-panel] ${guidanceFor(name)}（依赖不全：${String(e?.message ?? e).split('\n')[0]}）`) } catch { /* 同上 */ }
      return unavailableStub(name)
    }
    throw e
  }
}

export function importButlerLib(name) { return loadOrStub(butlerLibPath, name) }
export function importToolLib(name) { return loadOrStub(toolLibPath, name) }
export function importButlerFile(name) { return loadOrStub(butlerFilePath, name) }

/**
 * 状态文件路径解析器：优先用大管家 lib 的 `resolveStatePath`；库不可用时退到**等价的最简形态**
 * `<home>/<name>`（这正是它 legacy 期的口径，逐字节一致）。
 *
 * 为什么要这层：有好几个模块在**模块顶层**就算路径（`const X = resolveStatePath(…).path`），
 * 顶层调用桩会直接抛 —— 那就等于"没装大管家 ⇒ 插件加载失败 ⇒ 宿主起不来"。
 * 状态文件路径这种纯拼接没有语义风险，所以给它一个真兜底，而不是降级成不可用。
 * 返回值形状与真实现一致：`{ path }`。
 */
export async function statePathResolver() {
  const mod = await importButlerLib('state-paths.mjs')
  const fn = mod.resolveStatePath
  if (typeof fn === 'function' && !fn.butlerUnavailable) return fn
  return (name, opts = {}) => ({ path: path.join(opts?.home || dshHome(), String(name)) })
}
