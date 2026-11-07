// dsh-butler-panel / lib/butler-root.mjs
//
// 统一解析「DSH 工作区根 / 大管家工具根 / 共享库目录」——插件内**所有**跨包引用都走这里。
//
// 为什么需要它：插件部署后落在 `~/.dsh/profiles/web/node_modules/<pkg>/lib/`，
// 相对路径会解析到 `node_modules/…` 而那里没有大管家工具目录 ⇒ 静态 import 失败会
// 带崩整个 plugin tree。历史做法是写死 `file:///<绝对路径>` 形式的 URL，能用但把本机目录写进了源码。
// 本模块把那个绝对前缀换成四个环境变量，默认值退化为「用户主目录下的约定位置」。
//
// 口径（优先级从高到低）：
//
//   BUTLER_ROOT     大管家工具根（即 `<workspace>/tools/dsh-butler`）
//   DSH_WORKSPACE   DSH 工作区根（`tools/` 与 `docs/` 所在的那层）
//   由 home 推导      仅当 DSH_HOME / BUTLER_DSH_HOME 被重定向成 `<root>/.dsh` 形态时取 `<root>`
//   兜底              `<用户主目录>/DSH`
//
// 任何一项解析不到真实目录都不会在这里抛错：本模块只负责**算出路径**，
// 「目录不存在怎么办」由调用方决定（多数检查走 fail-soft，把该段标成「不可探测」）。
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
  return path.join(butlerRoot(), 'lib', ...seg)
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

// 下面四个是给"模块级一次性加载"用的便捷入口：内部就是 path + URL，方便单点替换。
//
// ⚠️ 为什么这里要兜底而不是让 import 抛：插件是**整棵加载**的，任一模块顶层 import 失败
//    会让 plugin tree 挂掉、`dsh web` 起不来。用户机器上可能压根没装大管家工具目录，
//    那种情况下正确的行为是"面板照常起来、依赖大管家的那几段显示不可用"，
//    而不是把整个宿主拖死。
//    所以：只有**找不到模块**（用户没装）才退化成占位，模块有语法错等真错照旧往上抛。
//    占位对象上任何属性访问都返回一个"调用即报错"的函数，错误信息直接告诉用户该设哪个变量。
function unavailableStub(name) {
  const msg = `大管家库不可用：${name} —— 请把 BUTLER_ROOT 或 DSH_WORKSPACE 指向你的大管家工具目录（详见 README「接上你自己的大管家」）`;
  const stub = function () { throw new Error(msg) };
  // 让调用方能在"不触发调用"的前提下认出这是占位（例如 `X = mod.Foo ?? null` 之后再 `new X()`）。
  Object.defineProperty(stub, 'butlerUnavailable', { value: true, enumerable: false });
  // `then` 必须显式排除：否则这个对象会被当成 thenable，await / Promise.resolve 会挂住。
  return new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : stub) });
}

const MISSING_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ENOENT']);

async function loadOrStub(url, name) {
  try {
    return await import(url)
  } catch (e) {
    if (MISSING_CODES.has(e?.code)) {
      try { console.warn(`[butler-panel] ${msgOf(name)}`) } catch { /* 控制台不可用就算了 */ }
      return unavailableStub(name)
    }
    throw e
  }
}
function msgOf(name) { return `大管家库缺失（${name}）⇒ 该功能降级为「不可用」` }

export function importButlerLib(name) { return loadOrStub(asUrl(butlerLib(name)), name) }
export function importToolLib(name) { return loadOrStub(asUrl(toolLibDir(name)), name) }
export function importButlerFile(name) { return loadOrStub(asUrl(butlerFile(name)), name) }

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
