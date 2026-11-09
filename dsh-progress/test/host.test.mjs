// 无头测试：不启动 DSH、不连模型，只验证宿主端的契约与门禁状态机。
// 重点锁住两条设计约束：
//   1. 插件绝不碰 ctx.systemPrompt（fake ctx 里根本没有这个服务，碰了就 TypeError）
//   2. 提醒只追加在尾部，不替换下游 content/value
import test from 'node:test'
import assert from 'node:assert/strict'

import * as mod from '../lib/index.js'

/* ---------------- 假环境 ---------------- */

function makeCtx() {
  const listeners = new Map()
  const tools = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
      return () => {}
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
  }

  const handlersOf = (type) => listeners.get(type) ?? []

  const pre = (exec, downstream = { kind: 'allow' }) => {
    const handler = handlersOf('tools/pre-execute')[0]
    return handler(exec, async () => downstream)
  }

  const post = (exec, result = { isError: false }, downstream = { kind: 'accept', content: [{ type: 'text', text: 'ok' }], value: null }) => {
    const handler = handlersOf('tools/post-execute')[0]
    return handler(exec, result, async () => downstream)
  }

  const event = (type, data = {}) => {
    for (const handler of handlersOf('session/event')) handler({ id: 's1' }, { type, data, seq: 1, time: Date.now() })
  }

  const disposed = (sessionId = 's1') => {
    for (const handler of handlersOf('session/disposed')) handler({ id: sessionId })
  }

  return { ctx, tools, listeners, pre, post, event, disposed }
}

function makeAgent(header = {}) {
  return { id: 'a1', session: { id: 's1', header } }
}

let callSeq = 0

function makeExec(agent, overrides = {}) {
  callSeq += 1
  return {
    callId: `call-${callSeq}`,
    name: 'read',
    arguments: {},
    agent,
    parent: undefined,
    toolSet: undefined,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function boot(config) {
  const env = makeCtx()
  mod.apply(env.ctx, config)
  return env
}

/* ---------------- 模块契约 ---------------- */

test('模块导出：只注入 tools，不注入 systemPrompt', () => {
  assert.equal(mod.name, 'dsh-progress')
  assert.deepEqual([...mod.inject], ['tools'])
  assert.equal(typeof mod.apply, 'function')
})

test('工具定义：名字、必填参数、受支持的 JSON Schema 子集', () => {
  const { tools } = boot({})
  assert.equal(tools.length, 1)
  const tool = tools[0]

  assert.equal(tool.name, 'report_progress')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 200, '描述要能承载“什么时候汇报”的规则')

  // 只用 dsh-tools 支持的关键字：type / properties / required / additionalProperties / items / enum / const / description
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
  const walk = (node, path) => {
    for (const key of Object.keys(node)) {
      assert.ok(allowed.has(key), `${path} 使用了不受支持的关键字 ${key}`)
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.${key}`)
    if (node.items) walk(node.items, `${path}[]`)
  }
  walk(tool.parameters, 'parameters')
  walk(tool.output.schema, 'output.schema')

  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['phase', 'summary'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.properties.phase.enum, ['start', 'working', 'problem', 'blocked', 'done'])
  assert.deepEqual(Object.keys(tool.output.schema.properties), ['ok'])
})

test('工具描述里的阈值跟随配置，且是静态字符串（不随调用变化）', () => {
  const a = boot({ softLimit: 3, hardLimit: 5 }).tools[0].description
  const b = boot({ softLimit: 3, hardLimit: 5 }).tools[0].description
  assert.equal(a, b)
  assert.ok(a.includes('At 3 unreported calls'))
  assert.ok(a.includes('at 5 your next tool call is refused'))
})

test('render 给出模型可读的一行确认', () => {
  const tool = boot({}).tools[0]
  const blocks = tool.output.render({ phase: 'problem', summary: '构建失败：缺少依赖' })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('problem'))
  assert.ok(blocks[0].text.includes('构建失败：缺少依赖'))
})

/* ---------------- 门禁：计数、提醒、拦截 ---------------- */

test('连续 7 次未汇报提醒一次，第 10 次后下一次工具调用被拒，汇报后立刻恢复', async () => {
  const { tools, pre, post } = boot({})
  const agent = makeAgent()
  const tool = tools[0]

  for (let i = 1; i <= 6; i += 1) {
    const decision = await post(makeExec(agent))
    assert.equal(decision.additionalContexts, undefined, `第 ${i} 次不该提醒`)
  }

  const seventh = await post(makeExec(agent))
  assert.equal(seventh.kind, 'accept', '只追加，不改判')
  assert.equal(seventh.content[0].text, 'ok', '不改写下游 content')
  assert.equal(seventh.additionalContexts.length, 1)
  const notice = seventh.additionalContexts[0]
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, '进度提醒', '上下文行的标签直接用中文')
  assert.equal(notice.source.form, 'notice')
  assert.ok(notice.source.summary.includes('7'), '说明里带上次数，一眼看出原因')
  assert.equal(typeof notice.id, 'string')
  assert.ok(notice.content[0].text.includes('连续 7 次'))

  assert.equal((await post(makeExec(agent))).additionalContexts, undefined, '同一窗口只提醒一次')

  await post(makeExec(agent)) // 9
  await post(makeExec(agent)) // 10

  const blocked = await pre(makeExec(agent))
  assert.equal(blocked.kind, 'deny')
  assert.ok(blocked.reason.includes('10 次'))
  assert.ok(blocked.reason.includes('report_progress'))

  assert.equal((await pre(makeExec(agent))).kind, 'deny', '没汇报就一直拦')

  await tool.execute({ phase: 'working', summary: '正在看构建日志' }, { agent })
  assert.equal((await pre(makeExec(agent))).kind, 'allow', '汇报后立刻恢复')
})

test('被自己拦下的调用不会被重复计数', async () => {
  const { pre, post } = boot({})
  const agent = makeAgent()
  for (let i = 0; i < 10; i += 1) await post(makeExec(agent))

  const denied = makeExec(agent)
  assert.equal((await pre(denied)).kind, 'deny')
  // 真实管线里被拒的调用也会走一遍 post-execute（结果 isError），不能算成一次失败
  await post(denied, { isError: true })
  assert.equal((await pre(makeExec(agent))).kind, 'deny', '计数没有被这次拦截改写')
})

test('连续失败 3 次未汇报也会被拦，理由要求解释问题', async () => {
  const { pre, post } = boot({})
  const agent = makeAgent()
  for (let i = 0; i < 3; i += 1) await post(makeExec(agent), { isError: true })

  const decision = await pre(makeExec(agent))
  assert.equal(decision.kind, 'deny')
  assert.ok(decision.reason.includes('3 次工具调用失败'))
  assert.ok(decision.reason.includes('problem'))
})

test('软阈值 7 之前不会拦人', async () => {
  const { pre, post } = boot({})
  const agent = makeAgent()
  for (let i = 0; i < 6; i += 1) await post(makeExec(agent))
  assert.equal((await pre(makeExec(agent))).kind, 'allow')
})

/* ---------------- 不该管的调用 ---------------- */

test('子 agent 默认不管：既不计数也不拦', async () => {
  const { pre, post } = boot({})
  const child = makeAgent({ origin: 'subagent' })
  for (let i = 0; i < 20; i += 1) {
    const decision = await post(makeExec(child))
    assert.equal(decision.additionalContexts, undefined)
  }
  assert.equal((await pre(makeExec(child))).kind, 'allow')

  const deep = makeAgent({ delegationDepth: 1 })
  for (let i = 0; i < 20; i += 1) await post(makeExec(deep))
  assert.equal((await pre(makeExec(deep))).kind, 'allow')
})

test('subagents: true 时子 agent 也管', async () => {
  const { pre, post } = boot({ subagents: true })
  const child = makeAgent({ origin: 'subagent' })
  for (let i = 0; i < 10; i += 1) await post(makeExec(child))
  assert.equal((await pre(makeExec(child))).kind, 'deny')
})

test('PTC 内层调用（带 parent）不计数也不拦', async () => {
  const { pre, post } = boot({})
  const agent = makeAgent()
  for (let i = 0; i < 20; i += 1) await post(makeExec(agent, { parent: Symbol('outer') }))
  assert.equal((await pre(makeExec(agent, { parent: Symbol('outer') }))).kind, 'allow')
})

test('汇报工具自己、以及 exempt 里的工具不计数', async () => {
  const { pre, post } = boot({})
  const agent = makeAgent()
  for (let i = 0; i < 20; i += 1) {
    await post(makeExec(agent, { name: 'report_progress' }))
    await post(makeExec(agent, { name: 'ask_user_question' }))
  }
  assert.equal((await pre(makeExec(agent))).kind, 'allow')
})

test('汇报工具在本步不可见时绝不拦（防死锁）', async () => {
  const { pre, post } = boot({})
  const agent = makeAgent()
  for (let i = 0; i < 10; i += 1) await post(makeExec(agent))
  const invisible = { view: () => new Map() }
  assert.equal((await pre(makeExec(agent, { toolSet: invisible }))).kind, 'allow')

  const visible = { view: () => new Map([['report_progress', { name: 'report_progress' }]]) }
  assert.equal((await pre(makeExec(agent, { toolSet: visible }))).kind, 'deny')
})

test('下游已经 deny 时尊重下游，不重复改判', async () => {
  const { pre, post } = boot({})
  const agent = makeAgent()
  for (let i = 0; i < 10; i += 1) await post(makeExec(agent))
  const downstream = { kind: 'deny', reason: '别的策略拒绝了' }
  const decision = await pre(makeExec(agent), downstream)
  assert.equal(decision, downstream)
})

/* ---------------- 重置 ---------------- */

test('提醒的说明会写清其中有几次失败', async () => {
  const { post } = boot({})
  const agent = makeAgent()
  await post(makeExec(agent), { isError: true })
  for (let i = 2; i <= 6; i += 1) await post(makeExec(agent))
  const decision = await post(makeExec(agent))
  const summary = decision.additionalContexts[0].source.summary
  assert.ok(summary.includes('7') && summary.includes('失败'), summary)
})

test('下游要求审批（ask）时也受硬上限约束', async () => {
  const { pre, post } = boot({})
  const agent = makeAgent()

  const ask = { kind: 'ask', reason: '需要用户批准' }
  assert.equal(await pre(makeExec(agent), ask), ask, '预算内尊重下游的审批要求')

  for (let i = 0; i < 10; i += 1) await post(makeExec(agent))
  assert.equal((await pre(makeExec(agent), ask)).kind, 'deny', '超预算时审批类工具也要先汇报')
})

test('新回合开始重新给预算', async () => {
  const { pre, post, event } = boot({})
  const agent = makeAgent()
  for (let i = 0; i < 10; i += 1) await post(makeExec(agent))
  assert.equal((await pre(makeExec(agent))).kind, 'deny')

  event('turn/start', { turn: 2 })
  assert.equal((await pre(makeExec(agent))).kind, 'allow')
})

test('会话销毁后释放状态', async () => {
  const { pre, post, disposed } = boot({})
  const agent = makeAgent()
  for (let i = 0; i < 10; i += 1) await post(makeExec(agent))
  assert.equal((await pre(makeExec(agent))).kind, 'deny')

  disposed('s1')
  assert.equal((await pre(makeExec(agent))).kind, 'allow')
  assert.equal((await pre(makeExec(agent), { kind: 'deny', reason: 'x' })).reason, 'x', '不影响别的会话')
})

test('回合结束后释放状态', async () => {
  const { pre, post, event } = boot({})
  const agent = makeAgent()
  for (let i = 0; i < 10; i += 1) await post(makeExec(agent))
  event('turn/end', { turn: 1 })
  assert.equal((await pre(makeExec(agent))).kind, 'allow')
})

/* ---------------- 参数校验与开关 ---------------- */

test('工具参数校验给出中文、可执行的错误', async () => {
  const tool = boot({}).tools[0]
  const agent = makeAgent()
  await assert.rejects(() => tool.execute({ phase: 'working' }, { agent }), /summary 不能为空/)
  await assert.rejects(() => tool.execute({ phase: 'nope', summary: 'x' }, { agent }), /phase 必须是/)
  await assert.rejects(() => tool.execute(null, { agent }), /参数必须是一个对象/)
  await assert.rejects(() => tool.execute({ phase: 'working', summary: 'x', detail: 42 }, { agent }), /detail 必须是字符串/)
})

test('超长文本被截断而不是报错', async () => {
  const tool = boot({}).tools[0]
  await tool.execute({ phase: 'working', summary: 'x'.repeat(1000) }, { agent: makeAgent() })
  const blocks = tool.output.render({ phase: 'working', summary: 'x'.repeat(1000) })
  assert.ok(blocks[0].text.length < 400)
})

test('enabled: false 时完全不注册', () => {
  const { tools, listeners } = boot({ enabled: false })
  assert.equal(tools.length, 0)
  assert.equal(listeners.size, 0)
})

test('enforce: false 时只注册工具，不提醒也不拦截', async () => {
  const { tools, listeners } = boot({ enforce: false })
  assert.equal(tools.length, 1)
  assert.equal(listeners.get('tools/pre-execute'), undefined)
  assert.equal(listeners.get('tools/post-execute'), undefined)
})

test('坏配置 fail loud', () => {
  assert.throws(() => boot({ softLimit: 10, hardLimit: 10 }), /hardLimit\(10\) 必须大于 softLimit\(10\)/)
  assert.throws(() => boot({ softLimit: 0 }), /softLimit 必须是 >= 1 的整数/)
  assert.throws(() => boot({ hardLimit: 1 }), /hardLimit 必须是 >= 2 的整数/)
  assert.throws(() => boot({ softLimit: 7.5 }), /整数/)
  assert.throws(() => boot({ enabled: 'yes' }), /必须是 true\/false/)
  assert.throws(() => boot({ exempt: [1] }), /必须是字符串数组/)
  assert.throws(() => boot({ sofLimit: 3 }), /未知配置项 "sofLimit"/)
  assert.throws(() => boot([]), /config 必须是一个对象/)
})
