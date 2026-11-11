// 方向纠偏与工具教练的离线测试：不启动 DSH、不连模型，只验证规则和边界。
import test from 'node:test'
import assert from 'node:assert/strict'

import * as mod from '../lib/index.js'
import {
  buildAnchor,
  classifyGoal,
  classifyIntent,
  extractPaths,
  isQuestion,
  isStatusOnly,
} from '../lib/anchor.js'
import {
  bashWrapperTip,
  isPathInScope,
  isVerificationCommand,
  isWriteTool,
  turnStopReason,
} from '../lib/signals.js'

/* ---------------- 假环境 ---------------- */

let callSeq = 0

function makeExec(agent, overrides = {}) {
  callSeq += 1
  return {
    callId: `dir-call-${callSeq}`,
    name: 'read',
    arguments: {},
    agent,
    parent: undefined,
    toolSet: undefined,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function makeAgent({ request = null, assistant = '', header = {} } = {}) {
  const messages = []
  if (request !== null) {
    messages.push({ role: 'user', content: [{ type: 'text', text: request }], source: { kind: 'user' } })
  }
  if (assistant !== '') {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: assistant }], source: { kind: 'assistant' } })
  }
  const steered = []
  return {
    id: 'a1',
    session: { id: 's1', header, deriveMessages: () => messages },
    steer(message) {
      steered.push(message)
    },
    steered,
    messages,
  }
}

function makeCtx(env = {}) {
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
    get(name) {
      if (name === 'goals') return { get: () => env.goal ?? null }
      if (name === 'sessionProjections') return {
        snapshot: () => ({ values: { todos: env.todos ?? null, plan: env.planView ?? null } }),
      }
      if (name === 'planMode') {
        if (env.planModeService === false) return undefined
        return { get: () => ({ active: env.planMode === true }) }
      }
      return undefined
    },
  }
  const handlersOf = (type) => listeners.get(type) ?? []
  const post = (exec, result = { isError: false }, downstream = { kind: 'accept', content: [{ type: 'text', text: 'ok' }], value: null }) => {
    const handler = handlersOf('tools/post-execute')[0]
    return handler(exec, result, async () => downstream)
  }
  const stopping = async () => {
    for (const handler of handlersOf('agent/turn-stopping')) {
      await handler({ agent: env.agent, turn: 1, signal: new AbortController().signal })
    }
  }
  return { ctx, tools, listeners, post, stopping }
}

function boot({ config = {}, env = {}, agent = makeAgent() } = {}) {
  const context = makeCtx({ ...env, agent })
  mod.apply(context.ctx, { softLimit: 50, hardLimit: 60, ...config })
  return { ...context, agent }
}

async function report(env, args) {
  const tool = env.tools[0]
  await tool.execute(args, { agent: env.agent })
  return env.post(makeExec(env.agent, { name: 'report_progress' }), { isError: false })
}

async function write(env, path, name = 'edit') {
  return env.post(makeExec(env.agent, { name, arguments: { file_path: path } }), { isError: false })
}

async function bash(env, command) {
  return env.post(makeExec(env.agent, { name: 'bash', arguments: { command } }), { isError: false })
}

/* ---------------- 纯规则 ---------------- */

test('目标分类：有路径/命令/报错才算清晰，模糊目标按模糊处理', () => {
  assert.equal(classifyGoal('修复 src/auth.ts 的登录 500'), 'clear')
  assert.equal(classifyGoal('npm test 失败了，帮我看下'), 'clear')
  assert.equal(classifyGoal('帮我做个好看的待办应用'), 'vague')
  assert.equal(classifyGoal('随便弄一个页面'), 'vague')
  assert.equal(classifyIntent('修复 src/auth.ts 的登录 500'), 'change')
  assert.equal(classifyIntent('分析一下为什么构建失败'), 'research')
  assert.equal(classifyIntent('帮我做个好看的待办应用'), 'unknown')
  assert.equal(isQuestion('已经完成。\n需要我继续吗？'), true)
  assert.equal(isQuestion('已经完成，直接收工。'), false)
})

test('纯状态/确认消息：只认已经发生的结果，不认动作请求', () => {
  const yes = [
    '已经重启了web',
    '重启了web',
    '已经重启 了web',
    '好了',
    '收到，谢谢',
    '测试通过了',
    '部署完成',
    'OK',
    '嗯嗯',
    '已经修好了',
    '现在可以了',
    '没问题了',
    '好的，已经重启了web',
    '测试通过，谢谢',
  ]
  for (const text of yes) assert.equal(isStatusOnly(text), true, text)

  const no = [
    '重启服务',
    '修复登录',
    '完成这个功能',
    '加个按钮',
    '还是不行',
    '已经重启了web，你看看',
    '帮我重启',
    '为什么登录失败',
    '测试失败了',
    '好了，继续',
    '继续',
  ]
  for (const text of no) assert.equal(isStatusOnly(text), false, text)
})

test('路径提取跳过版本号和 URL，范围判断支持同主名测试文件', () => {
  assert.deepEqual(extractPaths('修复 0.2.0 的 src/auth.ts，参考 https://x.test/a.js'), ['src/auth.ts'])
  assert.equal(isPathInScope('src/auth.test.ts', ['src/auth.ts']), true)
  assert.equal(isPathInScope('src/auth-b.test.ts', ['src/auth.ts']), true)
  assert.equal(isPathInScope('src/billing.ts', ['src/auth.ts']), false)
  assert.equal(isPathInScope('src/auth/login.ts', ['src/auth']), true)
  assert.equal(isPathInScope('anything.ts', []), true)
})

test('工具分类：写工具排除 todo_write/report_progress，验证命令只认常见测试/构建', () => {
  assert.equal(isWriteTool('edit'), true)
  assert.equal(isWriteTool('write'), true)
  assert.equal(isWriteTool('apply_patch'), true)
  assert.equal(isWriteTool('todo_write'), false)
  assert.equal(isWriteTool('report_progress'), false)
  assert.equal(isVerificationCommand({ name: 'bash', arguments: { command: 'npm test' } }), true)
  assert.equal(isVerificationCommand({ name: 'bash', arguments: { command: 'pytest -q' } }), true)
  assert.equal(isVerificationCommand({ name: 'bash', arguments: { command: 'cat package.json' } }), false)
})

test('bash 包装提示只在简单命令且原生工具可见时出现', () => {
  const agent = makeAgent()
  assert.equal(bashWrapperTip({ name: 'bash', arguments: { command: 'cat src/a.ts' } }, agent)?.tool, 'read')
  assert.equal(bashWrapperTip({ name: 'bash', arguments: { command: 'grep foo src' } }, agent)?.tool, 'grep')
  assert.equal(bashWrapperTip({ name: 'bash', arguments: { command: 'find . -name x' } }, agent)?.tool, 'glob')
  assert.equal(bashWrapperTip({ name: 'bash', arguments: { command: 'npm test' } }, agent), null)
  assert.equal(bashWrapperTip({ name: 'bash', arguments: { command: 'cat src/a.ts | head' } }, agent), null)
  const invisible = { view: () => new Map() }
  assert.equal(bashWrapperTip({ name: 'bash', arguments: { command: 'cat src/a.ts' }, toolSet: invisible }, agent), null)
})

test('收工原因：清晰目标先查验证/目标/收口，模糊目标只按自己的计划', () => {
  const clearChange = { mode: 'clear', goalActive: false, intent: 'change' }
  const clearGoal = { mode: 'clear', goalActive: true, intent: 'change' }
  const vague = { mode: 'vague', hasPlan: false }
  assert.equal(turnStopReason(clearChange, { toolCalls: 0 }), null)
  assert.equal(turnStopReason(clearChange, { toolCalls: 1, doneUnverified: true }), 'done-unverified')
  assert.equal(turnStopReason(clearGoal, { toolCalls: 1 }), 'goal-active')
  assert.equal(turnStopReason(clearChange, { toolCalls: 1, hasWritten: true }), 'not-done')
  assert.equal(turnStopReason(vague, { toolCalls: 2 }), null)
  assert.equal(turnStopReason(vague, { toolCalls: 3 }), 'vague-no-plan')
  assert.equal(turnStopReason({ ...vague, hasPlan: true }, { toolCalls: 1 }), 'own-plan')
})

/* ---------------- 双模式 ---------------- */

test('模糊目标第一次工具调用先对齐，之后不重复', async () => {
  const agent = makeAgent({ request: '帮我做个好看的待办应用' })
  const env = boot({ agent })
  const first = await env.post(makeExec(agent))
  assert.equal(first.additionalContexts.length, 1)
  assert.equal(first.additionalContexts[0].source.kind, '方向核对')
  assert.ok(first.additionalContexts[0].content[0].text.includes('开始前先用一句话'))

  const second = await env.post(makeExec(agent))
  assert.equal(second.additionalContexts, undefined)
})

test('纯状态消息不触发模糊对齐，也不做收工拉回', async () => {
  const agent = makeAgent({ request: '已经重启了web' })
  const env = boot({ agent })
  const decision = await env.post(makeExec(agent))
  assert.equal(decision.additionalContexts, undefined)

  await env.stopping()
  assert.equal(agent.steered.length, 0)
})

test('纯状态消息不触发工具提示，也不拿它做完成判断', async () => {
  const agent = makeAgent({ request: '好了' })
  const env = boot({ agent })

  const bashDecision = await bash(env, 'cat src/a.ts')
  assert.equal(bashDecision.additionalContexts, undefined)

  await write(env, 'src/a.ts')
  const done = await report(env, { phase: 'done', summary: '好了' })
  assert.equal(done.additionalContexts, undefined)
})

test('模糊目标不检查只读不写，也不检查改出范围', async () => {
  const agent = makeAgent({ request: '帮我做个好看的待办应用' })
  const env = boot({ agent })
  for (let i = 0; i < 10; i += 1) {
    const decision = await env.post(makeExec(agent))
    if (i > 0) assert.equal(decision.additionalContexts, undefined, `第 ${i + 1} 次不该有额外提醒`)
  }
  assert.equal(agent.steered.length, 0)
})

test('清晰 + 要改动 + 连续只读：第一次核对，第二次汇报拉回', async () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent })
  for (let i = 0; i < 8; i += 1) await env.post(makeExec(agent))

  const first = await report(env, { phase: 'working', summary: '还在看代码' })
  assert.equal(first.additionalContexts.length, 1)
  assert.equal(first.additionalContexts[0].source.kind, '方向核对')

  await env.post(makeExec(agent))
  const second = await report(env, { phase: 'working', summary: '继续看' })
  assert.equal(second.additionalContexts, undefined)
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].source.kind, '方向纠偏')
})

test('清晰 + 点名路径：写入超出范围第一次核对，第二次拉回', async () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent })
  await write(env, 'src/auth.ts')

  const first = await write(env, 'src/billing.ts')
  assert.equal(first.additionalContexts.length, 1)
  assert.equal(first.additionalContexts[0].source.kind, '方向核对')

  const second = await write(env, 'src/billing.ts')
  assert.equal(second.additionalContexts, undefined)
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].source.kind, '方向纠偏')
})

test('清晰模式下，新用户消息会切回清晰并重置模糊对齐', async () => {
  const agent = makeAgent({ request: '帮我做个好看的待办应用' })
  const env = boot({ agent })
  const first = await env.post(makeExec(agent))
  assert.equal(first.additionalContexts[0].source.kind, '方向核对')

  agent.messages[0].content[0].text = '修复 src/auth.ts 的登录 500'
  const second = await env.post(makeExec(agent))
  assert.equal(second.additionalContexts, undefined, '清晰模式不再做模糊对齐')
})

/* ---------------- 收工与验证 ---------------- */

test('报了完成但没验证：先给工具提示，收工时再拉回', async () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent })
  await write(env, 'src/auth.ts')

  const done = await report(env, { phase: 'done', summary: '修好了' })
  assert.equal(done.additionalContexts.length, 1)
  assert.equal(done.additionalContexts[0].source.kind, '工具提示')

  await env.stopping()
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].source.kind, '方向纠偏')
})

test('汇报工具自身失败时，不重复使用上一次汇报', async () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent })
  await write(env, 'src/auth.ts')
  const done = await report(env, { phase: 'done', summary: '修好了' })
  assert.equal(done.additionalContexts.length, 1)

  const failed = await env.post(makeExec(agent, { name: 'report_progress' }), { isError: true })
  assert.equal(failed.additionalContexts, undefined)
})

test('写后跑过成功验证，报完成不再提示，也不拉回', async () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent })
  await write(env, 'src/auth.ts')
  await bash(env, 'npm test')

  const done = await report(env, { phase: 'done', summary: '修好了，测试通过' })
  assert.equal(done.additionalContexts, undefined)

  await env.stopping()
  assert.equal(agent.steered.length, 0)
})

test('汇报里写明“手动验证”就不再提示，也不再收工拉回', async () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent })
  await write(env, 'src/auth.ts')

  const done = await report(env, { phase: 'done', summary: '已改好，手动验证：打开页面点登录' })
  assert.equal(done.additionalContexts, undefined)

  await env.stopping()
  assert.equal(agent.steered.length, 0)
})

test('goal 还 active 就收工：拉回一次', async () => {
  const goal = { phase: 'active', objective: '修复 src/auth.ts 的登录 500' }
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent, env: { goal } })
  await env.post(makeExec(agent))
  await report(env, { phase: 'working', summary: '继续修' })

  await env.stopping()
  assert.equal(agent.steered.length, 1)
  assert.ok(agent.steered[0].content[0].text.includes('goal 还是 active'))
})

test('模糊 + 自己写过计划：收工按自己的计划拉回', async () => {
  const goal = { phase: 'active', objective: '做一个好看的待办应用' }
  const agent = makeAgent({ request: '帮我做个好看的待办应用' })
  const env = boot({ agent, env: { goal } })
  await env.post(makeExec(agent))
  await report(env, { phase: 'working', summary: '先搭页面' })

  await env.stopping()
  assert.equal(agent.steered.length, 1)
  assert.ok(agent.steered[0].content[0].text.includes('计划'))
})

test('模糊 + 没有计划：收工只做一次轻核对', async () => {
  const agent = makeAgent({ request: '帮我做个好看的待办应用' })
  const env = boot({ agent })
  for (let i = 0; i < 3; i += 1) await env.post(makeExec(agent))

  await env.stopping()
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].source.kind, '方向核对')
})

test('最后一句在问用户时，收工不打扰', async () => {
  const goal = { phase: 'active', objective: '修复 src/auth.ts 的登录 500' }
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500', assistant: '需要我继续吗？' })
  const env = boot({ agent, env: { goal } })
  await env.post(makeExec(agent))
  await report(env, { phase: 'working', summary: '继续修' })

  await env.stopping()
  assert.equal(agent.steered.length, 0)
})

/* ---------------- 工具教练 ---------------- */

test('bash 里的简单 cat 给出工具提示，带管道就不提示', async () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent })
  const decision = await bash(env, 'cat src/auth.ts')
  assert.equal(decision.additionalContexts.length, 1)
  assert.equal(decision.additionalContexts[0].source.kind, '工具提示')
  assert.ok(decision.additionalContexts[0].content[0].text.includes('read'))

  const piped = await bash(env, 'cat src/auth.ts | head')
  assert.equal(piped.additionalContexts, undefined)
})

test('同一操作原样失败 3 次不重复提醒（交给基座 repeat-tool-reminder）', async () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent })
  for (let i = 0; i < 3; i += 1) {
    const decision = await env.post(makeExec(agent), { isError: true })
    assert.equal(decision.additionalContexts, undefined)
  }
  assert.equal(agent.steered.length, 0)
})

/* ---------------- 边界 ---------------- */

test('子 agent 默认不做方向判断，也不收工拉回', async () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500', header: { origin: 'subagent' } })
  const env = boot({ agent })
  const decision = await env.post(makeExec(agent))
  assert.equal(decision.additionalContexts, undefined)
  await env.stopping()
  assert.equal(agent.steered.length, 0)
})

test('PTC 内层调用不做方向判断', async () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent })
  const decision = await env.post(makeExec(agent, { parent: Symbol('outer') }))
  assert.equal(decision.additionalContexts, undefined)
})

test('plan mode 下收工不拉回', async () => {
  const goal = { phase: 'active', objective: '修复 src/auth.ts 的登录 500' }
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent, env: { goal, planMode: true } })
  await env.post(makeExec(agent))
  await report(env, { phase: 'working', summary: '继续修' })

  await env.stopping()
  assert.equal(agent.steered.length, 0)
})

test('planMode 服务不可见时，用 plan 投影判断计划模式，收工不拉回', async () => {
  const agent = makeAgent({ request: '帮我做个好看的待办应用' })
  const env = boot({
    agent,
    env: { planModeService: false, planView: { active: true, pending: false } },
  })
  await env.post(makeExec(agent))
  await report(env, { phase: 'working', summary: '继续', next: '写方案' })

  await env.stopping()
  assert.equal(agent.steered.length, 0)
})

test('工具主动结束回合（exit_plan_mode 被要求修改）后，收工不再拉回', async () => {
  const agent = makeAgent({ request: '帮我做个好看的待办应用' })
  const env = boot({ agent })
  await env.post(makeExec(agent))
  await report(env, { phase: 'working', summary: '继续', next: '写方案' })
  await env.post(
    makeExec(agent, { name: 'exit_plan_mode', arguments: { plan: '# 方案\n\n先做一件事。' } }),
    { isError: false, concludesTurn: true },
  )

  await env.stopping()
  assert.equal(agent.steered.length, 0)
})

test('普通工具调用结束后，写下的计划没做收工仍会拉回（回归）', async () => {
  const agent = makeAgent({ request: '帮我做个好看的待办应用' })
  const env = boot({ agent })
  await env.post(makeExec(agent))
  await report(env, { phase: 'working', summary: '继续', next: '写方案' })

  await env.stopping()
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].source.kind, '方向纠偏')
})

test('direction: false 时不注册收工监听，也不做方向核对', async () => {
  const agent = makeAgent({ request: '帮我做个好看的待办应用' })
  const env = boot({ agent, config: { direction: false } })
  assert.equal(env.listeners.get('agent/turn-stopping'), undefined)
  const decision = await env.post(makeExec(agent))
  assert.equal(decision.additionalContexts, undefined)
})

test('新配置 fail loud', () => {
  assert.throws(() => boot({ config: { maxCorrections: -1 } }), /maxCorrections/)
  assert.throws(() => boot({ config: { noWriteLimit: 2 } }), /noWriteLimit/)
  assert.throws(() => boot({ config: { direction: 'yes' } }), /direction/)
  assert.throws(() => boot({ config: { coach: 1 } }), /coach/)
})

test('不访问 systemPrompt / llm 服务也能完整跑完', async () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const env = boot({ agent })
  assert.equal(typeof env.ctx.systemPrompt, 'undefined')
  assert.equal(typeof env.ctx.llm, 'undefined')
  await env.post(makeExec(agent))
  await report(env, { phase: 'working', summary: '继续' })
  await env.stopping()
})

/* ---------------- buildAnchor 直接契约 ---------------- */

test('buildAnchor 只取真实用户消息、active goal 和 todos', () => {
  const agent = makeAgent({ request: '修复 src/auth.ts 的登录 500' })
  const ctx = makeCtx({
    goal: { phase: 'active', objective: '修复登录' },
    todos: [{ content: '先复现 500', status: 'in_progress' }],
  }).ctx
  const anchor = buildAnchor(ctx, agent, { lastReport: null })
  assert.equal(anchor.request, '修复 src/auth.ts 的登录 500')
  assert.equal(anchor.goal, '修复登录')
  assert.equal(anchor.hasPlan, true)
  assert.equal(anchor.mode, 'clear')
  assert.equal(anchor.intent, 'change')
  assert.deepEqual(anchor.paths, ['src/auth.ts'])
})
