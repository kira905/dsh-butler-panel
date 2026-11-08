// dsh-butler-panel / _test / fallback.test.mjs
//
// 回归夹具：面板「多路回落」的行为锁定。
// 为什么要有它：回落链是"全靠路径猜"，坏掉时**不会报错**——只会静默退回占位、
// 面板显示「不可用」。那种退化没人会主动发现，所以必须用夹具把每条路的**顺序**和
// **阴性对照**钉住。
//
// 跑法：node _test/fallback.test.mjs        （退出码 0 = 全绿）
// 覆盖：显式 > 工作区约定 > npm 包 的顺序 / 占位话术可照做 / 版本号取自盘上包 /
//       包目录不存在时不许假装找到。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const LIB = path.join(HERE, '..', 'lib')

const root = await import(pathToFileURL(path.join(LIB, 'butler-root.mjs')).href)
const search = await import(pathToFileURL(path.join(LIB, 'engine-search.mjs')).href)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-fallback-'))
const results = []
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]) } catch (e) { results.push(['FAIL', name + ' — ' + String(e.message).split('\n')[0]]) }
}
process.on('exit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清不掉也无所谓 */ }
  const fail = results.filter((r) => r[0] === 'FAIL').length
  for (const [st, name] of results) console.log(`${st === 'PASS' ? '✅' : '❌'} ${name}`)
  console.log(`\n${results.length} 条：${results.length - fail} 通过 / ${fail} 失败`)
  process.exitCode = fail ? 1 : 0
})

// ── ① 顺序：显式指定必须排第一，工作区约定第二，engine 包在其后 ─────────────
const fakeWorkspace = path.join(tmp, 'ws')
const fakeButler = path.join(tmp, 'my-butler')
fs.mkdirSync(path.join(fakeButler, 'lib'), { recursive: true })
fs.mkdirSync(path.join(fakeWorkspace, 'tools', 'dsh-butler', 'lib'), { recursive: true })
process.env.DSH_WORKSPACE = fakeWorkspace
process.env.BUTLER_ROOT = fakeButler
delete process.env.DSH_BUTLER_LIB_DIR
delete process.env.BUTLER_LIB_DIR

check('① 显式 BUTLER_ROOT 排第一', () => {
  const dirs = root.butlerLibSearchDirs()
  assert.equal(path.resolve(dirs[0]).toLowerCase(), path.resolve(path.join(fakeButler, 'lib')).toLowerCase(), `首位是 ${dirs[0]}`)
})
check('① 工作区约定排在显式之后', () => {
  const dirs = root.butlerLibSearchDirs().map((d) => d.toLowerCase())
  const explicit = path.resolve(path.join(fakeButler, 'lib')).toLowerCase()
  const wsDir = path.resolve(path.join(fakeWorkspace, 'tools', 'dsh-butler', 'lib')).toLowerCase()
  assert.ok(dirs.indexOf(explicit) < dirs.indexOf(wsDir), '显式没排在工作区之前')
})

// ── ② 占位话术：必须可照做（含安装命令与 BUTLER_ROOT 两条出路）──────────────
check('② 缺件话术含安装命令 + BUTLER_ROOT 出路', () => {
  const msg = root.guidanceFor('nonexistent-module.mjs')
  assert.match(msg, /^缺 nonexistent-module\.mjs：/)
  assert.ok(msg.includes('npm i -g @kira905/dsh-butler-engine'), '没给安装命令')
  assert.ok(msg.includes('BUTLER_ROOT='), '没给 BUTLER_ROOT 出路')
})
check('② 降级是占位对象、可被认出（不抛在加载期）', async () => {
  // 这条是同步检查块，真正的 async 校验放在下面单独跑
  assert.ok(typeof root.guidanceFor === 'function')
})

// ── ③ engine 包探测：假的包根（含 src/dsh-butler/lib）必须被认出来 ──────────
const fakeEngine = path.join(tmp, 'engine-pkg')
for (const sub of ['lib', 'src/dsh-butler/lib', 'src/lib', 'jobs/lib']) fs.mkdirSync(path.join(fakeEngine, sub), { recursive: true })
fs.writeFileSync(path.join(fakeEngine, 'package.json'), JSON.stringify({ name: '@kira905/dsh-butler-engine', version: '9.9.9' }), 'utf8')
process.env.DSH_BUTLER_ENGINE_ROOT = fakeEngine
search.resetEngineCache()

check('③ 显式包根被认出来', () => {
  const roots = search.engineRoots().map((r) => r.toLowerCase())
  assert.ok(roots.includes(path.resolve(fakeEngine).toLowerCase()), `没认出假包根，roots=${roots.join(',')}`)
})
check('③ 版本号取自盘上那份 package.json（不是写死）', () => {
  assert.equal(search.engineVersion(), '9.9.9')
})
check('③ 包内四个候选子目录都进了搜索链', () => {
  const dirs = root.butlerLibSearchDirs().map((d) => d.toLowerCase())
  for (const sub of ['src/dsh-butler/lib', 'src/lib', 'jobs/lib']) {
    const want = path.resolve(path.join(fakeEngine, sub)).toLowerCase()
    assert.ok(dirs.includes(want), `缺候选 ${sub}`)
  }
})

// ── ④ 阴性对照：包根指到不存在的目录 ⇒ 不许假装找到 ─────────────────────────
process.env.DSH_BUTLER_ENGINE_ROOT = path.join(tmp, 'no-such-engine')
search.resetEngineCache()
check('④ 阴性对照：假包根不存在 ⇒ engineRoots 里没有它', () => {
  const roots = search.engineRoots().map((r) => r.toLowerCase())
  assert.ok(!roots.includes(path.resolve(tmp, 'no-such-engine').toLowerCase()), '不存在的包根被当成找到了')
})
check('④ 阴性对照：文件不存在 ⇒ 话术里不出现 9.9.9 这类"假版本"', () => {
  // 包探测已指到空处；此处只断言话术不会凭空编一个版本出来
  const msg = root.guidanceFor('whatever.mjs')
  assert.ok(!msg.includes('9.9.9'), '话术里出现了假版本号')
})

// ── ⑤ 占位对象的行为（async，单独跑）────────────────────────────────────────
const stub = await root.importButlerLib('this-module-does-not-exist.mjs')
check('⑤ 缺件返回占位而非抛错', () => {
  let fn
  assert.doesNotThrow(() => { fn = stub.anything })
  assert.equal(fn.butlerUnavailable, true, '占位上没有 butlerUnavailable 标记')
})
check('⑤ 调占位才抛、且抛的就是那句指引', () => {
  assert.throws(() => stub.anything(), /缺 this-module-does-not-exist\.mjs：/)
})
check('⑤ 占位不是 thenable（await 不会挂住）', () => {
  assert.equal(stub.then, undefined)
})
check('⑤ 占位带 butlerSearched（排障能看找过哪些目录）', () => {
  assert.ok(Array.isArray(stub.anything.butlerSearched.dirs))
})
