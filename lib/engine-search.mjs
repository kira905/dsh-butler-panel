// dsh-butler-panel / lib/engine-search.mjs
//
// 只做一件事：**定位 @kira905/dsh-butler-engine 这个包在哪、它里面有哪些库目录**。
//
// 为什么要单独一件：面板里不止一处需要"找库"（butler-root 的加载器、metrics 的环境探测），
// 而 metrics.mjs 明确承诺自己不 import 面板的业务模块。把这段纯路径逻辑抽成无副作用的
// 小件，两边都能用，又不把业务耦合带进去。
//
// 🔴 为什么不只靠 createRequire：engine 在安装清单里是 **CLI 类型**（`npm i -g`），
//    落在全局前缀（Windows 是 `%APPDATA%\npm\node_modules`），而面板落在
//    `~/.dsh/profiles/web/node_modules/`。Node 的模块解析只会从面板所在目录**向上**爬，
//    爬不到全局前缀 ⇒ 单靠 createRequire 在真实装载形态下必然找不到。
//    所以这里按「显式指定 → 模块解析 → 全局前缀常见位置」三档走，每档都只读、失败不抛。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

export const ENGINE_PKG = '@kira905/dsh-butler-engine'

/** 各调用方要的"库目录"在包内的候选位置（顺序 = 优先级）。 */
export const ENGINE_SUBDIRS = {
  // <butlerRoot>/lib 的镜像：engine 把生产 tools/dsh-butler/lib 放在 src/dsh-butler/lib
  butler: ['lib', 'src/dsh-butler/lib', 'src/lib', 'jobs/lib'],
  // <workspace>/tools/lib 的镜像：engine 放在 src/lib
  tool: ['src/lib', 'lib', 'src/dsh-butler/lib', 'jobs/lib'],
  // <butlerRoot> 顶层的镜像（CLI 脚本在 src/dsh-butler/，作业脚本在 jobs/）
  butlerFile: ['src/dsh-butler', 'jobs', 'lib', 'src/dsh-butler/lib'],
}

const require_ = createRequire(import.meta.url)

/** 从某个入口文件向上爬，找到 name 匹配的 package.json 所在目录。 */
function pkgRootOf(entry) {
  if (!entry) return null
  let dir = path.dirname(entry)
  for (let i = 0; i < 10; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (j && j.name === ENGINE_PKG) return dir
    } catch { /* 这一层没有或坏了，继续上溯 */ }
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

/** 全局 npm 前缀下包可能出现的位置（不 spawn npm，只按约定路径猜）。 */
function globalNodeModules() {
  const out = []
  const add = (p) => { if (p && String(p).trim()) out.push(path.resolve(String(p).trim())) }

  const prefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX
  if (prefix) {
    add(path.join(prefix, 'node_modules'))
    add(path.join(prefix, 'lib', 'node_modules'))
  }
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'npm', 'node_modules'))

  // node 自己就在前缀根里时（自定义安装、绿色版、nvm 等）
  const exeDir = path.dirname(process.execPath)
  add(path.join(exeDir, 'node_modules'))
  add(path.join(exeDir, '..', 'lib', 'node_modules'))

  add(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'))
  if (process.platform !== 'win32') {
    add('/usr/local/lib/node_modules')
    add('/usr/lib/node_modules')
  }
  return out
}

let cachedRoots = null

/**
 * engine 包根候选（按优先级，已去重、已过滤不存在的）。
 * 返回 [] = 这台机器上压根没装 engine。
 */
export function engineRoots() {
  if (cachedRoots) return cachedRoots
  const roots = []
  const push = (p) => {
    if (!p) return
    const abs = path.resolve(p)
    if (roots.some((x) => x.toLowerCase() === abs.toLowerCase())) return
    roots.push(abs)
  }

  // ① 显式指定（用户/测试可钉死；装了但找不到时这也是逃生口）
  const explicit = (process.env.DSH_BUTLER_ENGINE_ROOT ?? '').trim()
  if (explicit) push(explicit)

  // ② Node 自己的模块解析（面板与 engine 同树 / 被提升到同一 node_modules 时命中）
  for (const spec of [`${ENGINE_PKG}/package.json`, ENGINE_PKG]) {
    try { push(pkgRootOf(require_.resolve(spec))) } catch { /* 这一路走不通就下一路 */ }
  }

  // ③ 全局前缀（真实装载形态：engine 是 CLI，装到全局）
  for (const nm of globalNodeModules()) {
    const cand = path.join(nm, ...ENGINE_PKG.split('/'))
    try {
      const j = JSON.parse(fs.readFileSync(path.join(cand, 'package.json'), 'utf8'))
      if (j && j.name === ENGINE_PKG) push(cand)
    } catch { /* 不在这一档，继续 */ }
  }

  cachedRoots = roots.filter((r) => fs.existsSync(path.join(r, 'package.json')))
  return cachedRoots
}

/** 某个用途下**真实存在**的库目录（绝对路径，按优先级）。 */
export function engineLibDirs(kind = 'butler') {
  const subdirs = ENGINE_SUBDIRS[kind] ?? ENGINE_SUBDIRS.butler
  const out = []
  for (const root of engineRoots()) {
    for (const sub of subdirs) {
      const dir = path.join(root, sub)
      try { if (fs.statSync(dir).isDirectory()) out.push(dir) } catch { /* 没有这层 */ }
    }
  }
  return out
}

/** engine 的实际版本号（用于降级话术里给可照做的安装命令）；读不到返回 null。 */
export function engineVersion() {
  for (const root of engineRoots()) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
      if (j?.version) return String(j.version)
    } catch { /* 下一处 */ }
  }
  return null
}

/** 测试用：清掉缓存（换过 env 必须换进程，否则是假绿）。 */
export function resetEngineCache() { cachedRoots = null }
