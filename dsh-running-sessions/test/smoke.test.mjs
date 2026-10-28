// 无头冒烟测试：不启动浏览器、不用真 React。
// 校验模块契约、三个槽位注册，以及计数片 / 弹层 / 整页面板渲染出的内容。
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(pkgDir, 'lib/client.js'), 'utf8')

/* ---------------- 最小 React 替身 ---------------- */
const FRAGMENT = Symbol('Fragment')
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
  return { type, props: { ...(props ?? {}), children: flat } }
}
// useState 按调用序号取值：给出下标覆盖，未给出的用初始值。
let stateSlots = {}
let stateIndex = 0
const ReactShim = {
  Fragment: FRAGMENT,
  createElement,
  useState: (initial) => {
    const index = stateIndex++
    const value = Object.prototype.hasOwnProperty.call(stateSlots, index)
      ? stateSlots[index]
      : typeof initial === 'function'
        ? initial()
        : initial
    return [value, () => {}]
  },
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
  useSyncExternalStore: (_subscribe, read) => read(),
}

/* ---------------- 假数据 ---------------- */
const MINUTE = 60_000
const now = Date.now()
const source0 = (value) => ({ getSnapshot: () => value, subscribe: () => () => {} })

const sessions = {
  ids: ['s-run', 's-wait', 's-done', 's-stale', 's-blank', 's-archived', 's-sub'],
  byId: {
    's-run': { id: 's-run', displayTitle: '批量校对 README', updatedAt: now - 3 * MINUTE, running: true, cwd: '/work/a' },
    's-wait': { id: 's-wait', displayTitle: '重构 runner', updatedAt: now - 1 * MINUTE, running: true, cwd: '/work/b' },
    's-done': { id: 's-done', displayTitle: '翻译 manifest', updatedAt: now - 12 * MINUTE, running: false, cwd: '/work/b' },
    's-stale': { id: 's-stale', displayTitle: '老会话', updatedAt: now - 300 * MINUTE, running: false, cwd: '/work/a' },
    's-blank': { id: 's-blank', displayTitle: '新会话', updatedAt: now, running: false, blank: true },
    's-archived': { id: 's-archived', displayTitle: '归档的', updatedAt: now, running: false },
    's-sub': { id: 's-sub', displayTitle: '子代理', updatedAt: now, running: true, origin: 'subagent' },
  },
  phase: 'ready',
}
const statuses = new Map([
  ['s-run', { running: true, completionUnread: false }],
  ['s-wait', { running: true, pendingInteraction: { key: 'k1', kind: 'approval', sessionId: 's-wait' }, completionUnread: false }],
  ['s-done', { running: false, completionUnread: true }],
])
const workspaces = {
  items: [
    { workspaceId: 'w1', title: 'dsh-0.2.1-rc.2', path: '/work/a', sessionIds: ['s-run', 's-stale'] },
    { workspaceId: 'w2', title: 'pi-agent-web', path: '/work/b', sessionIds: ['s-wait', 's-done'] },
  ],
  archivedSessionIds: ['s-archived'],
  phase: 'ready',
}

const opened = []
const cleanups = []
const registered = new Map()
const storage = new Map()
const ctx = {
  effect(fn) {
    cleanups.push(fn() ?? (() => {}))
  },
  slots: {
    inject(_name, factory) {
      factory()
      return () => {}
    },
    register(options, Component) {
      const key = options.name === 'main' ? `main:${options.key}` : `${options.name}:${options.id ?? ''}`
      registered.set(key, { options, Component })
      return () => registered.delete(key)
    },
  },
  sessions: { list: source0(sessions) },
  uiSession: { sessionStatus: source0(statuses) },
  workspaces: { list: source0(workspaces) },
  uiWorkspace: { openSession: (id) => opened.push(id) },
}

/* ---------------- 按真实加载契约取模块 ---------------- */
let spec
const sandbox = {
  window: {
    __ModuleLoader__: { load: (value) => (spec = value) },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  },
  document: {
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', parentNode: { removeChild: () => {} } }),
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  setInterval: () => 0,
  clearInterval: () => {},
  console,
  Date,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.equal(spec.id, 'dsh-running-sessions', 'module id 必须等于包名')
const mod = spec.factory((name) => {
  if (name === 'react') return ReactShim
  throw new Error(`unexpected require: ${name}`)
})
assert.deepEqual(
  [...mod.inject].sort(),
  ['sessions', 'slots', 'uiSession', 'uiWorkspace', 'workspaces'],
  '注入的服务',
)

stateSlots = {}
mod.apply(ctx)
assert.deepEqual(
  [...registered.keys()].sort(),
  [
    'conversation.session.header.utilities:running-sessions',
    'main:running-sessions',
    'settings.section:running-sessions',
    'sidebar.panellist:running-sessions',
  ],
  '三个入口 + 设置页都已注册',
)
assert.equal(registered.get('sidebar.panellist:running-sessions').options.label(), '运行中')

/* ---------------- 渲染工具 ---------------- */
function render(node) {
  let value = node
  for (let depth = 0; depth < 20 && value && typeof value.type === 'function'; depth += 1) {
    value = value.type(value.props)
  }
  return value
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node.type === 'function') {
    collectText(node.type(node.props), out)
    return out
  }
  collectText(node.props?.children, out)
  return out
}

function findNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, out)
    return out
  }
  if (typeof node.type === 'function') {
    findNodes(node.type(node.props), predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findNodes(node.props?.children, predicate, out)
  return out
}

const byClass = (name) => (node) => String(node.props?.className ?? '').split(' ').includes(name)
const textOf = (node) => collectText(node).join('')

/* ---------------- 标题栏计数片（收起） ---------------- */
const chip = registered.get('conversation.session.header.utilities:running-sessions').Component
stateSlots = {}
stateIndex = 0
const chipTree = render(chip({ ctx }))
const triggers = findNodes(chipTree, byClass('rs-trigger'))
assert.equal(triggers.length, 1, '计数片只有一个触发按钮')
// 等你的会话只计入「待确认」，不重复计进「运行中」。
assert.equal(textOf(triggers[0]), '1运行中1待确认', '计数片文案（数字与标签靠 CSS 间距分段）')
assert.equal(findNodes(chipTree, byClass('rs-pop')).length, 0, '默认收起')

/* ---------------- 标题栏计数片（展开） ---------------- */
// useFeed 占 0/1，HeaderChip 的 open 是第 2 个 state。
stateSlots = { 2: true }
stateIndex = 0
const openTree = render(chip({ ctx }))
const pops = findNodes(openTree, byClass('rs-pop'))
assert.equal(pops.length, 1, '展开后只有一个弹层')
const popText = textOf(pops[0])
for (const label of ['3 个 · 2 个工作区', '待我处理', '运行中', '刚完成', 'pi-agent-web · 等你确认', 'pi-agent-web · 已完成']) {
  assert.ok(popText.includes(label), `弹层缺少「${label}」：${popText}`)
}
// 页脚那句「非运行会话保留 N 分钟」是说明文案，不算行内冗余；只看行标题/副标题。
for (const excluded of ['老会话', '新会话', '归档的', '子代理']) {
  assert.ok(!popText.includes(excluded), `弹层不该出现「${excluded}」`)
}

const rows = findNodes(openTree, byClass('rs-row'))
assert.equal(rows.length, 3, '待我处理 + 运行中 + 刚完成 各一行')
assert.deepEqual(rows.map(textOf), [
  '待确认重构 runnerpi-agent-web · 等你确认1 分钟',
  '批量校对 READMEdsh-0.2.1-rc.2 · 正在执行3 分钟',
  '翻译 manifestpi-agent-web · 已完成12 分钟',
], '顺序：待我处理 → 运行中 → 刚完成，副标题不重复分组名')
rows[0].props.onClick()
assert.deepEqual(opened, ['s-wait'], '点第一行打开等待中的会话')

/* ---------------- 中间面板 ---------------- */
const main = registered.get('main:running-sessions').Component
stateSlots = {}
stateIndex = 0
const pageTree = render(main({ ctx }))
const pageText = textOf(pageTree)
assert.ok(pageText.includes('进行中的会话'), '面板标题')
assert.ok(pageText.includes('3 个 · 2 个工作区'), '面板元信息')
assert.equal(findNodes(pageTree, byClass('rs-row')).length, 3, '面板里同样是三行')

/* ---------------- 侧栏图标 ---------------- */
const icon = render({ type: registered.get('sidebar.panellist:running-sessions').Component, props: { size: 18, active: false } })
assert.equal(icon.type, 'svg', '侧栏图标是纯 svg')
assert.equal(icon.props.width, 18, '尺寸跟随槽位')

/* ---------------- 设置页：两个独立开关 ---------------- */
const settings = registered.get('settings.section:running-sessions').Component
stateSlots = {}
stateIndex = 0
const settingsTree = render(settings({ ctx }))
const switches = findNodes(settingsTree, byClass('rs-switch'))
assert.equal(switches.length, 2, '设置页有两个开关')
assert.deepEqual(switches.map((node) => node.props['aria-checked']), ['true', 'true'], '默认都开')

// 关掉侧栏入口：只注销 sidebar.panellist + main，计数片与设置页仍在。
switches[0].props.onClick()
assert.equal(storage.get('dsh-running-sessions.entry.nav'), '0', '侧栏开关写入自己的键')
assert.ok(!registered.has('sidebar.panellist:running-sessions'), '侧栏入口已注销')
assert.ok(!registered.has('main:running-sessions'), '侧栏对应的整页面板一起注销')
assert.ok(registered.has('conversation.session.header.utilities:running-sessions'), '计数片不受影响')
assert.ok(registered.has('settings.section:running-sessions'), '设置页永远在')

// 再关计数片：两个都关，插件界面上不可见。
stateSlots = {}
stateIndex = 0
const settingsTree2 = render(settings({ ctx }))
const switches2 = findNodes(settingsTree2, byClass('rs-switch'))
assert.deepEqual(switches2.map((node) => node.props['aria-checked']), ['false', 'true'], '重渲染反映已关的侧栏开关')
switches2[1].props.onClick()
assert.equal(storage.get('dsh-running-sessions.entry.chip'), '0', '计数片开关写入自己的键')
assert.ok(!registered.has('conversation.session.header.utilities:running-sessions'), '计数片已注销')

// 再打开：按原顺序恢复。
stateSlots = {}
stateIndex = 0
const settingsTree3 = render(settings({ ctx }))
const switches3 = findNodes(settingsTree3, byClass('rs-switch'))
switches3[0].props.onClick()
switches3[1].props.onClick()
assert.ok(registered.has('sidebar.panellist:running-sessions'), '侧栏入口恢复')
assert.ok(registered.has('main:running-sessions'), '整页面板恢复')
assert.ok(registered.has('conversation.session.header.utilities:running-sessions'), '计数片恢复')

/* ---------------- 清理 ---------------- */
for (const cleanup of cleanups) cleanup()
console.log('✓ smoke test passed')
