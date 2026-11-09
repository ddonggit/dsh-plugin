// 无头冒烟测试：不启动浏览器、不用真 React。
// 覆盖合并后的一个插件：进展卡片 / 活动条 / 标题栏计数片 / 整页列表 / 入口开关。
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
  // 立即执行（相当于挂载后立刻跑一次）：进展卡片借此把内容写给状态条和列表。
  useEffect: (fn) => {
    const cleanup = fn()
    assert.ok(cleanup === undefined || typeof cleanup === 'function', 'effect 只能返回空或清理函数')
  },
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
      const key = options.name === 'main' ? `main:${options.key}` : `${options.name}:${options.id ?? options.key ?? ''}`
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
const appended = []
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
    head: { appendChild: (node) => appended.push(node) },
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

assert.equal(spec.id, 'dsh-progress', 'module id 必须等于包名')
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
    'conversation.input.dock:progress',
    'conversation.session.header.utilities:running-sessions',
    'main:running-sessions',
    'sidebar.panellist:running-sessions',
    'tool.call.toolview:report_progress',
  ],
  '四个展示位 + 工具卡片；不再注册设置页',
)
assert.ok(![...registered.keys()].some((key) => key.startsWith('settings.')), '设置面板里不应再有本插件')
assert.equal(registered.get('sidebar.panellist:running-sessions').options.label(), '进行中')
assert.equal(registered.get('tool.call.toolview:report_progress').options.key, 'report_progress', 'keyed 槽位按工具名命中')

const dock = registered.get('conversation.input.dock:progress')
assert.equal(dock.options.order, 5)
assert.equal(dock.options.inject('s1').sessionId, 's1', '注入会话 id')

assert.ok(appended.length === 1 && appended[0].id === 'dsh-progress/style', '样式已注入')
const css = appended[0].textContent

// 状态条在宽屏上必须自己收窄并居中，跟随输入框卡片宽度，否则会横贯整个窗口。
const stripRule = /\.dpg-strip\{([^}]*)\}/.exec(css)?.[1] ?? ''
assert.ok(stripRule.includes('--dsh-composer-side-clearance'), '状态条按输入区留白收窄')
assert.ok(stripRule.includes('--dsh-composer-card-max-width'), '状态条不超过输入卡片宽度')
assert.ok(stripRule.includes('margin:0 auto 6px'), '状态条水平居中')
assert.ok(css.includes('.rs-pop'), '会话弹层样式在同一个样式表里')
assert.ok(css.includes('.rs-setd'), '入口显示样式在同一个样式表里')

/* ---------------- 渲染工具 ---------------- */
function render(Component, props = {}, slots = {}) {
  stateSlots = slots
  stateIndex = 0
  let value = Component(props)
  for (let depth = 0; depth < 30 && value && typeof value.type === 'function'; depth += 1) {
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

const useSessionRunning = (snapshot) => (selector) => selector(snapshot)
const useSessionIdle = useSessionRunning({ sessionId: 's1', running: false })
const useSessionBusy = useSessionRunning({ sessionId: 's1', running: true })

const resultBlock = (args, extra = {}) => ({
  kind: 'tool-result',
  callId: 'c1',
  name: 'report_progress',
  args: args ?? {},
  call: { name: 'report_progress', argsRaw: args === null ? '{not json' : JSON.stringify(args) },
  content: [],
  isError: false,
  ...extra,
})

const card = registered.get('tool.call.toolview:report_progress')

/* ---------------- 卡片 ---------------- */

const pending = textOf(render(card.Component, { phase: 'start', block: { phase: 'start', name: 'report_progress', callId: 'c1', argsRaw: '{}' }, sessionId: 's1' }))
assert.ok(pending.includes('正在汇报'), pending)

const full = textOf(
  render(card.Component, {
    phase: 'result',
    block: resultBlock({ phase: 'problem', summary: '构建失败：缺依赖', detail: 'pnpm build 报 ERR_MODULE_NOT_FOUND', next: '先补依赖再重跑' }),
    sessionId: 's1',
  }),
)
for (const needle of ['遇到问题', '构建失败：缺依赖', 'ERR_MODULE_NOT_FOUND', '下一步', '先补依赖再重跑']) {
  assert.ok(full.includes(needle), `卡片缺少 ${needle}：${full}`)
}

const noSummary = textOf(render(card.Component, { phase: 'result', block: resultBlock({ phase: 'working' }), sessionId: 's1' }))
assert.ok(noSummary.includes('没写说明'))

const unknownPhase = textOf(render(card.Component, { phase: 'result', block: resultBlock({ phase: 'weird', summary: 'x' }), sessionId: 's1' }))
assert.ok(unknownPhase.includes('进行中'), '未知相位退回 working')

const failed = textOf(
  render(card.Component, {
    phase: 'result',
    block: resultBlock(null, { isError: true, call: null, content: [{ type: 'text', text: 'report_progress: summary 不能为空' }] }),
    sessionId: 's1',
  }),
)
assert.ok(failed.includes('汇报失败') && failed.includes('summary 不能为空'), failed)

// 调用记录滑出已加载窗口（call 为 null）不是失败，不能显示成红卡片。
const truncated = textOf(render(card.Component, { phase: 'result', block: resultBlock(null, { call: null }), sessionId: 's1' }))
assert.ok(!truncated.includes('汇报失败'), `历史裁剪不该算失败：${truncated}`)
assert.ok(truncated.includes('已汇报'), truncated)

/* ---------------- 活动条：本会话进展 ---------------- */

render(card.Component, {
  phase: 'result',
  block: resultBlock({ phase: 'working', summary: '正在跑测试', next: '看失败用例' }),
  sessionId: 's1',
})
let bar = textOf(render(dock.Component, { sessionId: 's1', useSession: useSessionBusy }))
assert.ok(bar.includes('进行中') && bar.includes('正在跑测试') && bar.includes('下一步：看失败用例'), bar)

// 宿主没给 sessionId 时靠快照里的 sessionId 兜底（SessionSnapshot 的字段叫 sessionId，不是 id）。
const bySnapshot = textOf(render(dock.Component, { useSession: useSessionBusy }))
assert.ok(bySnapshot.includes('正在跑测试'), `应能靠会话快照兜底：${bySnapshot}`)

// 本会话空闲、别处有活动 → 显示其他会话计数，而不是自己的进展。
const others = textOf(render(dock.Component, { sessionId: 's1', useSession: useSessionIdle }))
assert.ok(others.includes('其他会话') && others.includes('1 个运行中') && others.includes('1 个等你确认'), others)

// 别处也没有活动 → 什么都不显示。
const savedIds = sessions.ids
const savedById = sessions.byId
sessions.ids = []
sessions.byId = {}
assert.equal(render(dock.Component, { sessionId: 's1', useSession: useSessionIdle }), null, '没有别处活动时不占位置')
sessions.ids = savedIds
sessions.byId = savedById

// 宿主没给会话快照时，仍能靠 sessionId 判断“本会话空闲”，显示别处活动而不崩。
const noSnapshot = textOf(render(dock.Component, { sessionId: 's1', useSession: () => undefined }))
assert.ok(noSnapshot.includes('其他会话'), noSnapshot)
// 连会话 id 都没有时，无法把自己排除在“其他会话”之外，宁可不显示。
assert.equal(render(dock.Component, { useSession: () => undefined }), null, '会话 id 未知时不乱报其他会话')
assert.equal(render(dock.Component, { sessionId: 'other', useSession: useSessionBusy }), null, '别的会话没有记录')

// 收尾之后不再占位置。
render(card.Component, { phase: 'result', block: resultBlock({ phase: 'done', summary: '全部通过' }), sessionId: 's1' })
assert.equal(render(dock.Component, { sessionId: 's1', useSession: useSessionBusy }), null, 'done 之后不再占位置')

/* ---------------- 跨会话列表：行里显示最新进展 ---------------- */
// 列表读的是卡片写进 latest 的内容：s-run 正在校对，s-done 的收尾说明也要显示。
render(card.Component, {
  phase: 'result',
  block: resultBlock({ phase: 'working', summary: '正在校对 README' }),
  sessionId: 's-run',
})
render(card.Component, {
  phase: 'result',
  block: resultBlock({ phase: 'done', summary: '翻译已完成' }),
  sessionId: 's-done',
})

const chip = registered.get('conversation.session.header.utilities:running-sessions').Component
stateSlots = {}
stateIndex = 0
const chipTree = render(chip, { ctx })
const triggers = findNodes(chipTree, byClass('rs-trigger'))
assert.equal(triggers.length, 1, '计数片只有一个触发按钮')
// 等你的会话只计入「待确认」，不重复计进「运行中」。
assert.equal(textOf(triggers[0]), '1运行中1待确认', '计数片文案（数字与标签靠 CSS 间距分段）')
assert.equal(findNodes(chipTree, byClass('rs-pop')).length, 0, '默认收起')

// useFeed 占 0/1，HeaderChip 的 open 是第 2 个 state。
const openTree = render(chip, { ctx }, { 2: true })
const pops = findNodes(openTree, byClass('rs-pop'))
assert.equal(pops.length, 1, '展开后只有一个弹层')
const popText = textOf(pops[0])
for (const label of ['3 个 · 2 个工作区', '待我处理', '运行中', '刚完成', 'pi-agent-web · 等你确认', 'pi-agent-web · 翻译已完成']) {
  assert.ok(popText.includes(label), `弹层缺少「${label}」：${popText}`)
}
for (const excluded of ['老会话', '新会话', '归档的', '子代理']) {
  assert.ok(!popText.includes(excluded), `弹层不该出现「${excluded}」`)
}
assert.ok(popText.includes('刚完成会话保留 30 分钟'), `页脚窗口文案：${popText}`)

const rows = findNodes(openTree, byClass('rs-row'))
assert.equal(rows.length, 3, '待我处理 + 运行中 + 刚完成 各一行')
assert.deepEqual(rows.map(textOf), [
  '待确认重构 runnerpi-agent-web · 等你确认1 分钟',
  '批量校对 READMEdsh-0.2.1-rc.2 · 正在校对 README3 分钟',
  '翻译 manifestpi-agent-web · 翻译已完成12 分钟',
], '顺序：待我处理 → 运行中 → 刚完成；行里显示该会话最新进展')
rows[0].props.onClick()
assert.deepEqual(opened, ['s-wait'], '点第一行打开等待中的会话')

/* ---------------- 整页面板 ---------------- */
const main = registered.get('main:running-sessions').Component
const pageTree = render(main, { ctx })
const pageText = textOf(pageTree)
assert.ok(pageText.includes('进行中的会话'), '面板标题')
assert.ok(pageText.includes('3 个 · 2 个工作区'), '面板元信息')
assert.equal(findNodes(pageTree, byClass('rs-row')).length, 3, '面板里同样是三行')

/* ---------------- 侧栏图标 ---------------- */
const icon = render(registered.get('sidebar.panellist:running-sessions').Component, { ctx, size: 18, active: false })
assert.equal(icon.type, 'svg', '侧栏图标是纯 svg')
assert.equal(icon.props.width, 18, '尺寸跟随槽位')

/* ---------------- 入口显示：开关在插件里，不在设置页 ---------------- */
function switchesOf(tree) {
  return findNodes(tree, byClass('rs-switch'))
}
function settingsTree() {
  return render(chip, { ctx }, { 2: true })
}

let switches = switchesOf(settingsTree())
assert.equal(switches.length, 2, '插件自己的入口显示里有两个开关')
assert.deepEqual(switches.map((node) => node.props['aria-checked']), ['true', 'true'], '默认都开')
assert.equal(switches.filter((node) => node.props.disabled === true).length, 0, '两个都开时都不锁')

// 关掉侧栏入口：只注销 sidebar.panellist + main，计数片与插件内的开关仍在。
switches[0].props.onClick()
assert.equal(storage.get('dsh-progress.entry.nav'), '0', '侧栏开关写入自己的键')
assert.ok(!registered.has('sidebar.panellist:running-sessions'), '侧栏入口已注销')
assert.ok(!registered.has('main:running-sessions'), '侧栏对应的整页面板一起注销')
assert.ok(registered.has('conversation.session.header.utilities:running-sessions'), '计数片不受影响')

switches = switchesOf(settingsTree())
assert.deepEqual(switches.map((node) => node.props['aria-checked']), ['false', 'true'], '重渲染反映已关的侧栏开关')
assert.equal(switches[1].props.disabled, true, '只剩一个入口时锁住，避免连设置都找不到')

// 最后一个入口不能再关：点了也保持开启。
switches[1].props.onClick()
assert.notEqual(storage.get('dsh-progress.entry.chip'), '0', '不能把最后一个入口关掉')
assert.ok(registered.has('conversation.session.header.utilities:running-sessions'), '计数片仍在')

// 再打开侧栏入口，两个都开；然后单独关计数片。
switchesOf(settingsTree())[0].props.onClick()
assert.ok(registered.has('sidebar.panellist:running-sessions'), '侧栏入口恢复')
assert.ok(registered.has('main:running-sessions'), '整页面板恢复')
switchesOf(settingsTree())[1].props.onClick()
assert.ok(!registered.has('conversation.session.header.utilities:running-sessions'), '计数片已注销')
assert.ok(registered.has('sidebar.panellist:running-sessions'), '侧栏入口保持')
switchesOf(settingsTree())[1].props.onClick()
assert.ok(registered.has('conversation.session.header.utilities:running-sessions'), '计数片恢复')

// 整页列表里也带同一套入口开关。
const pageSettings = switchesOf(render(main, { ctx }))
assert.equal(pageSettings.length, 2, '整页列表里也有入口开关')

/* ---------------- 回归：缺时间戳 / 未来时间戳 / 工作区计数 ---------------- */
sessions.byId['s-run'].updatedAt = undefined
{
  const tree = render(chip, { ctx }, { 2: true })
  const row = findNodes(tree, byClass('rs-row')).find((node) => textOf(node).includes('批量校对 README'))
  assert.ok(row, '缺 updatedAt 的运行中会话仍应出现')
  const time = findNodes(row, byClass('rs-time')).map(textOf).join('')
  assert.notEqual(time, '', '缺 updatedAt 时不能渲染空的时间列')
}
sessions.byId['s-run'].updatedAt = now - 3 * MINUTE

sessions.byId['s-done'].updatedAt = now + 900 * MINUTE
{
  const text = textOf(render(chip, { ctx }, { 2: true }))
  assert.ok(!text.includes('翻译 manifest'), '远离窗口的未来时间戳应已淡出')
}
sessions.byId['s-done'].updatedAt = now - 12 * MINUTE

// 两个不同工作区里的会话，cwd 的 basename 相同，也不能被算成 1 个工作区。
const savedItems = workspaces.items
workspaces.items = [
  { workspaceId: 'w1', title: 'dsh-0.2.1-rc.2', path: '/work/a', sessionIds: ['s-run', 's-stale'] },
  { workspaceId: 'w2', title: 'pi-agent-web', path: '/work/b', sessionIds: ['s-wait', 's-done'] },
]
assert.ok(textOf(render(chip, { ctx }, { 2: true })).includes('2 个工作区'), '按真实工作区去重应为 2')
// 完全没有工作区归属时，cwd 目录名不能冒充工作区参与计数。
workspaces.items = []
assert.ok(!/\d+ 个工作区/.test(textOf(render(chip, { ctx }, { 2: true }))), '无工作区归属时不该出现「N 个工作区」')
workspaces.items = savedItems

/* ---------------- 清理 ---------------- */
for (const cleanup of cleanups) cleanup()
console.log('✓ client test passed')
