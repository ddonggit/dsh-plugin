// 纯规则：只认工具名、参数、路径、错误文本这些硬事实，不做语义理解。
// 所有函数都不访问网络/模型；上层负责把结论变成提醒或 steer。

import { posix } from 'node:path'

import { truncate } from './text.js'

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'multi_edit'])
const VERIFY_RE =
  /(\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|build|lint|typecheck|check)\b|\b(vitest|jest|pytest|tsc|mypy|ruff|eslint)\b|\b(go\s+test|cargo\s+test)\b|\bnode\s+--test\b)/i

export function isWriteTool(name) {
  if (typeof name !== 'string' || name === '') return false
  if (name === 'todo_write' || name === 'report_progress') return false
  if (WRITE_TOOLS.has(name)) return true
  return /(^|_)(write|edit|patch)(_|$)/.test(name)
}

export function isVerificationCommand(exec) {
  if (exec?.name !== 'bash') return false
  const command = typeof exec?.arguments?.command === 'string' ? exec.arguments.command : ''
  return command !== '' && VERIFY_RE.test(command)
}

/** 从 write/edit 参数里取目标路径；取不到就不做范围判断。 */
export function extractWritePath(exec) {
  const args = exec?.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  for (const key of ['file_path', 'filePath', 'path', 'target', 'destination']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function normalizePath(value) {
  return String(value)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
}

/**
 * 用户点名了文件/目录时，写入目标是否在范围内。
 * 文件：精确路径，或同目录下同主名（auth.ts -> auth.test.ts）的变体。
 * 目录：目录本身或子路径。
 * 没有点名路径时一律返回 true（不检查范围）。
 */
export function isPathInScope(target, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return true
  const targetPath = normalizePath(target)
  if (targetPath === '') return true
  const targetBase = posix.basename(targetPath)
  const targetStem = posix.parse(targetBase).name

  for (const raw of paths) {
    const anchor = normalizePath(raw)
    if (anchor === '') continue

    if (!posix.extname(anchor)) {
      if (targetPath === anchor || targetPath.startsWith(`${anchor}/`)) return true
      continue
    }

    const anchorBase = posix.basename(anchor)
    const anchorStem = posix.parse(anchorBase).name
    if (targetPath === anchor) return true
    if (targetPath.endsWith(`/${anchor}`)) return true

    if (!anchor.includes('/')) {
      if (targetBase === anchorBase) return true
      if (targetStem === anchorStem) return true
      if (targetBase.startsWith(`${anchorStem}.`) || targetBase.startsWith(`${anchorStem}-`) || targetBase.startsWith(`${anchorStem}_`)) return true
      continue
    }

    if (posix.dirname(targetPath) === posix.dirname(anchor)) {
      if (targetStem === anchorStem) return true
      if (targetBase.startsWith(`${anchorStem}.`) || targetBase.startsWith(`${anchorStem}-`) || targetBase.startsWith(`${anchorStem}_`)) return true
    }
  }
  return false
}

/**
 * bash 里用 cat/grep/find 这类简单命令时给一条工具提示。
 * 有管道/重定向/组合命令就不提示；原生工具不可见也不提示。
 */
export function bashWrapperTip(exec, agent) {
  if (exec?.name !== 'bash') return null
  const raw = exec?.arguments?.command
  if (typeof raw !== 'string') return null
  let command = raw.trim()
  if (command === '') return null
  if (/[|&;<>$()`]|\n/.test(command)) return null
  command = command.replace(/^["']|["']$/g, '').trim()
  if (command === '') return null

  const view = exec?.toolSet?.view?.(agent)
  const visible = (name) => view === undefined || view?.has?.(name) === true

  if (/^(cat|head|tail|sed\s+-n)\b/.test(command)) {
    return visible('read') ? { command, tool: 'read', action: '读取文件' } : null
  }
  if (/^(grep|rg)\b/.test(command)) {
    return visible('grep') ? { command, tool: 'grep', action: '搜索内容' } : null
  }
  if (/^(find|ls)\b/.test(command)) {
    return visible('glob') ? { command, tool: 'glob', action: '查找文件' } : null
  }
  return null
}

/** 失败结果的短错误文本，用于本地日志/规则；不发送给模型。 */
export function errorText(result) {
  if (result?.isError !== true) return ''
  const error = result.error
  if (typeof error === 'string') return truncate(error, 160)
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    return truncate(error.message, 160)
  }
  if (Array.isArray(result.content)) {
    const block = result.content.find((item) => item?.type === 'text' && typeof item.text === 'string')
    if (block !== undefined) return truncate(block.text, 160)
  }
  return ''
}

/**
 * 回合即将结束时是否需要拉回/核对。返回 null 表示不该打扰。
 * 模糊模式只按“模型自己写下的计划”拉回；没计划就只做一次轻核对。
 */
export function turnStopReason(anchor, state) {
  if (!anchor || !state) return null
  if (state.toolCalls === 0) return null
  if (anchor.mode === 'clear' && state.doneUnverified) return 'done-unverified'

  const report = state.lastReport
  const reportedDone = report?.phase === 'done' || report?.phase === 'blocked'
  if (reportedDone) return null

  if (anchor.mode === 'clear') {
    if (anchor.goalActive) return 'goal-active'
    if (anchor.intent === 'change' && state.hasWritten) return 'not-done'
    return null
  }

  if (anchor.mode === 'vague') {
    if (anchor.hasPlan) return 'own-plan'
    if (state.toolCalls >= 3) return 'vague-no-plan'
  }
  return null
}
