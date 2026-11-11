/** Synthetic session events used by the snapshot and lifecycle tests. */

export function userMessage(seq, text) {
  return {
    type: 'user/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      id: `u${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }
}

export function assistantMessage(seq, text, { toolCall } = {}) {
  const content = [{ type: 'text', text }]
  if (toolCall) {
    content.push({
      type: 'tool-call',
      id: `call-${seq}`,
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments ?? {}),
    })
  }
  return {
    type: 'assistant/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `a${seq}`,
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
      stream: [],
    },
  }
}

export function todoWrite(seq, todos) {
  return {
    type: 'todo/write',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { todos },
  }
}

export function toolResult(seq, text, { isError = false } = {}) {
  return {
    type: 'tool/result',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `r${seq}`,
        role: 'tool',
        content: [{ type: 'text', text }],
        toolCallId: `call-${seq}`,
        isError,
        source: { kind: 'tool', callId: `call-${seq}` },
      },
      ...(isError ? { error: { name: 'TestError', code: 'ENOENT' } } : {}),
    },
  }
}

export function sampleSessionEvents() {
  return [
    userMessage(0, '开发一个自动压缩 dsh 会话记录的插件'),
    assistantMessage(1, '决定：先读 dsh 的压缩源码，再写方案\n下一步：写测试'),
    todoWrite(2, [
      { content: '读 dsh 压缩源码', status: 'completed' },
      { content: '写测试', status: 'in_progress' },
    ]),
    assistantMessage(3, '继续实现', {
      toolCall: { name: 'fs_write', arguments: { file_path: '/tmp/plugin/lib/index.js' } },
    }),
    toolResult(4, 'ENOENT: no such file or directory, open /tmp/plugin/lib/index.js', {
      isError: true,
    }),
  ]
}
