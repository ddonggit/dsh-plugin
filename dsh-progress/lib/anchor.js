// 锚点：只从真实用户消息、goal、todo、显式路径和意图里取事实。
// 这里不做语义理解，只做可解释的字符串/结构判断；判断不了就返回 null，让上层跳过。

import { truncate } from './text.js'

const PATH_RE = /(?:^|[\s"'`(（])((?:\/|\.{1,2}\/)?(?:[\w.@-]+\/)*[\w.@-]+\.(?:[a-zA-Z0-9]{2,8}))(?=$|[\s"'`),.;:!?，。；：！？）])/g

const VAGUE_WORDS = /(优化|好看|好用|试试|看看|帮我弄|随便|你看着办|做个|实现一个|研究一下|有什么办法|怎么弄|搞一下|弄一个|改改|调整一下)/i
const CHANGE_WORDS = /(修复|修好|修一下|改|加|实现|重构|替换|删除|移除|新增|支持|接入|升级|迁移|写一个|做一个|补上|fix|implement|refactor|add|remove|update|change|build|create|migrate)/i
const RESEARCH_WORDS = /(分析|调研|看看|看下|为什么|怎么回事|排查|定位|研究|了解|评估|review|investigate|why|analy[sz]e|explore|research)/i
const COMMAND_WORDS = /(`[^`]+`|\b(npm|pnpm|yarn|bun|node|python|pytest|go\s+test|cargo\s+test|git|docker|make|tsc|vitest|jest)\b|(跑|执行|运行).*(测试|构建|test|build))/i
const ERROR_WORDS = /(\b(error|exception|traceback|failed|failure|crash|undefined|null)\b|报错|失败|崩溃|\b(500|404|403|401)\b)/i
const MANUAL_VERIFY_WORDS = /(手动|没法自动验证|无法自动验证|不能自动验证|需要你看|你可以打开|请你看看|你手动|没法跑|不能跑)/i
const QUESTION_WORDS = /(请确认|需要你|要我|你希望|你看看|你试试|你觉得|要不要|可以吗|是否|等你|我先做到这里|等你确认)/i

// 纯状态/确认：只认“已经发生的结果”，不认动作请求。
// 这些规则刻意保守：拿不准就当正常任务，宁可多问一句也不漏掉真正的工作。
const STATUS_ACK_RE = /^(?:好的?|好滴|行|可以|嗯+|哦+|收到|谢谢|多谢|辛苦了|明白(?:了)?|了解(?:了)?|知道了|ok|okay|👌|👍)$/i
const STATUS_NEGATIVE_RE = /(不行|失败|报错|错误|异常|崩溃|坏了|不能用|没成功|没通过|未通过|还没|没有成功|没修好|不对|有问题|问题)/i
const STATUS_REQUEST_RE = /(请|帮我|麻烦|需要你|你看看|你试试|检查一下|排查|为什么|怎么|如何|要不要|可以吗|好吗|行吗)/i
const STATUS_POSITIVE_ONLY_RE = /^(?:已经|已|都|现在)?(?:没问题|没有?问题|没事)(?:了)?$/
const STATUS_PREFIX = '(?:已经|已|刚刚|刚|现在|这边|那边|都|终于|一切)'
const STATUS_VERB = '(?:重启|部署|更新|升级|安装|配置|修好|修复|改好|做好|弄好|搞定|完成|做完|跑通|测试|构建|页面|服务|web|功能|项目|添加|加|删除|删|替换|换|写)'
const STATUS_RESULT = '(?:完成|好了|好啦|成功|通过|正常|可以了|行了|没问题|没有?问题|没事|完毕|搞定|修好|改好|做好|弄好|跑通|完了|了)'
const STATUS_TAIL_RE = /^(?:web|服务|页面|测试|构建|功能|项目|一切|全部|都|也|现在|已经|没问题|正常|可以|好了|成功|通过|了|啦|咯|呢|的|啊|呀)*$/
const STATUS_MAIN_RE = new RegExp(`^(${STATUS_PREFIX})?(${STATUS_VERB})?(${STATUS_RESULT})(了|啦|咯|呢)?(.*)$`)
const STATUS_ALREADY_RE = new RegExp(`^(已经|已|刚刚|刚|都|终于)(${STATUS_VERB})(.*)$`)

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function lastMeaningfulLine(text) {
  if (typeof text !== 'string') return ''
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.at(-1) ?? ''
}

/** 从用户请求和 goal 里提取显式路径；没有就返回空数组。 */
export function extractPaths(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const found = []
  const seen = new Set()
  for (const match of text.matchAll(PATH_RE)) {
    let value = String(match[1] ?? '').trim()
    if (value === '') continue
    if (value.includes('://')) continue
    value = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/[.,;:!?，。；：！？]+$/, '')
    // 版本号不是路径：0.2.0 / 1.2.3
    if (/^\d+(?:\.\d+)+$/.test(value)) continue
    if (value.length > 240) continue
    if (seen.has(value)) continue
    seen.add(value)
    found.push(value)
    if (found.length >= 5) break
  }
  return found
}

/** 清晰目标：给了路径、命令或报错；其余都按模糊处理，宁可少打断。 */
export function classifyGoal(text) {
  if (typeof text !== 'string' || text.trim() === '') return 'vague'
  if (extractPaths(text).length > 0) return 'clear'
  if (COMMAND_WORDS.test(text)) return 'clear'
  if (ERROR_WORDS.test(text)) return 'clear'
  if (VAGUE_WORDS.test(text)) return 'vague'
  if (text.trim().length < 80) return 'vague'
  return 'vague'
}

export function classifyIntent(text) {
  if (typeof text !== 'string' || text.trim() === '') return 'unknown'
  if (CHANGE_WORDS.test(text)) return 'change'
  if (RESEARCH_WORDS.test(text)) return 'research'
  return 'unknown'
}

export function isQuestion(text) {
  if (typeof text !== 'string') return false
  const last = lastMeaningfulLine(text)
  if (last === '') return false
  if (/[?？]$/.test(last)) return true
  return QUESTION_WORDS.test(text)
}

export function isManualVerification(text) {
  return typeof text === 'string' && MANUAL_VERIFY_WORDS.test(text)
}

function isStatusClause(clause) {
  if (STATUS_ACK_RE.test(clause)) return true

  const main = clause.match(STATUS_MAIN_RE)
  if (main !== null) {
    const [, prefix, verb, result, suffix, tail] = main
    if (!STATUS_TAIL_RE.test(tail)) return false
    // “了”单独出现没有意义；“完成/搞定/修好”单独出现更像命令而不是状态。
    if (result === '了' && prefix === undefined && verb === undefined) return false
    if (
      ['完成', '搞定', '修好', '改好', '做好', '弄好', '跑通'].includes(result) &&
      prefix === undefined &&
      verb === undefined &&
      suffix === undefined
    ) {
      return false
    }
    return true
  }

  const already = clause.match(STATUS_ALREADY_RE)
  if (already !== null) return STATUS_TAIL_RE.test(already[3])
  return false
}

/**
 * 纯状态/确认消息：例如“已经重启了web”“好了”“收到”“测试通过了”。
 * 这类消息没有新任务，不应该触发方向核对/纠偏或工具提示。
 * 动作请求（“重启服务”“修复登录”）、负面状态（“还是不行”）和问句都不算。
 */
export function isStatusOnly(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 80) return false
  if (/[?？]/.test(trimmed)) return false

  const flat = trimmed.replace(/\s+/g, '')
  if (STATUS_NEGATIVE_RE.test(flat) && !STATUS_POSITIVE_ONLY_RE.test(flat)) return false
  if (STATUS_REQUEST_RE.test(flat)) return false

  const clauses = trimmed
    .split(/[，,。；;！!、\n]+/)
    .map((clause) => clause.replace(/\s+/g, ''))
    .filter((clause) => clause !== '')
  if (clauses.length === 0) return false
  return clauses.every(isStatusClause)
}

/** 最新一条真实用户消息；忽略进度提醒、方向核对、goal/plan 等内部消息。 */
export function latestUserRequest(agent) {
  let messages
  try {
    messages = agent?.session?.deriveMessages?.()
  } catch {
    return null
  }
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (message?.source?.kind !== 'user') continue
    const text = textOfContent(message.content).trim()
    if (text !== '') return truncate(text, 1200)
  }
  return null
}

/** 最后一条助手可见文本，用来判断“是不是在问用户”。 */
export function lastAssistantText(agent) {
  let messages
  try {
    messages = agent?.session?.deriveMessages?.()
  } catch {
    return ''
  }
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = textOfContent(message.content).trim()
    if (text !== '') return truncate(text, 600)
  }
  return ''
}

/** 只取 active goal 的 objective；暂停/完成/阻塞都不算当前锚点。 */
export function readGoal(ctx, agent) {
  try {
    const view = ctx?.get?.('goals')?.get?.(agent)
    if (view?.phase === 'active' && typeof view.objective === 'string') {
      return truncate(view.objective, 400)
    }
  } catch {
    // 服务不存在或会话没挂 goal 时跳过，不影响现有功能。
  }
  return null
}

/** 读 todos 投影；返回 [{content,status}] 或 null。 */
export function readTodos(ctx, agent) {
  try {
    const projections = ctx?.get?.('sessionProjections')
    const snapshot = projections?.snapshot?.(agent?.session, ['todos'])
    const todos = snapshot?.values?.todos
    if (!Array.isArray(todos)) return null
    const clean = todos
      .filter((item) => item && typeof item.content === 'string' && typeof item.status === 'string')
      .map((item) => ({ content: truncate(item.content, 160), status: item.status }))
    return clean.length > 0 ? clean : null
  } catch {
    return null
  }
}

function planText(goal, todos, lastReport) {
  if (typeof goal === 'string' && goal !== '') return goal
  if (Array.isArray(todos) && todos.length > 0) {
    const lines = todos
      .filter((item) => item.status === 'in_progress' || item.status === 'pending')
      .slice(0, 3)
      .map((item) => `${item.status === 'in_progress' ? '进行中' : '待办'}：${item.content}`)
    if (lines.length > 0) return truncate(lines.join('；'), 400)
  }
  if (lastReport !== null && typeof lastReport === 'object') {
    const next = typeof lastReport.next === 'string' ? lastReport.next.trim() : ''
    if (next !== '') return truncate(next, 400)
    const summary = typeof lastReport.summary === 'string' ? lastReport.summary.trim() : ''
    if (summary !== '') return truncate(summary, 400)
  }
  return null
}

export function buildAnchor(ctx, agent, state) {
  const request = latestUserRequest(agent)
  if (request === null) return null
  const goal = readGoal(ctx, agent)
  const todos = readTodos(ctx, agent)
  const lastReport = state?.lastReport ?? null
  const declaredPlan = planText(goal, todos, lastReport)
  const hasPlan = Boolean(
    goal !== null ||
      (Array.isArray(todos) && todos.some((item) => item.status === 'in_progress' || item.status === 'pending')) ||
      (lastReport !== null && typeof lastReport?.next === 'string' && lastReport.next.trim() !== ''),
  )
  return {
    request,
    goal,
    todos,
    declaredPlan,
    hasPlan,
    goalActive: goal !== null,
    statusOnly: isStatusOnly(request),
    paths: extractPaths(`${request}\n${goal ?? ''}`),
    intent: classifyIntent(request),
    mode: classifyGoal(request),
  }
}
