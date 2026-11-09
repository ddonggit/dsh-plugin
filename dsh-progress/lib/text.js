// 小工具：截断、消息 id、参数预览。只依赖标准库/全局对象。

export function truncate(text, limit) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, Math.max(0, limit - 1))}…`
}

export function createMessageId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (typeof uuid === 'string') return uuid
  return `progress-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 把工具参数压成一行，用于本地规则和日志；不发送给模型。 */
export function previewValue(value, limit = 200) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return truncate(value.replace(/\s+/g, ' '), limit)
  try {
    return truncate(JSON.stringify(value), limit)
  } catch {
    return ''
  }
}
