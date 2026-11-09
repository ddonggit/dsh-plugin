const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render(_args, value) {
    return [{ type: 'text', text: String(value?.text ?? '') }]
  },
}

const EMPTY_PARAMS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

function text(value) {
  return { text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
}

function tool(ctx, definition) {
  const dispose = ctx.tools.register({ ...definition, output: TEXT_OUTPUT })
  return dispose
}

/** Agent-facing deployment tools; canvas edits go through MCP, not here. */
export function registerTools(ctx, { stack, config }) {
  const disposers = []

  disposers.push(
    tool(ctx, {
      name: 'penpot_status',
      description:
        '查看 DSH 里 Penpot 的安装与运行状态：容器、健康检查、公开/本地/MCP 地址和下一步。做图前先调用。',
      parameters: EMPTY_PARAMS,
      async execute() {
        return text(await stack.status())
      },
    }),
  )

  disposers.push(
    tool(ctx, {
      name: 'penpot_start',
      description:
        '启动 Penpot Docker 栈。立即返回 starting，首次启动约 1–3 分钟；用 penpot_status 查看是否就绪。',
      parameters: EMPTY_PARAMS,
      async execute() {
        const status = await stack.startInBackground()
        return text({ started: true, state: status.state, publicUri: status.publicUri })
      },
    }),
  )

  disposers.push(
    tool(ctx, {
      name: 'penpot_stop',
      description: '停止 Penpot 容器，保留数据库和素材卷；不会删除设计文件。',
      parameters: EMPTY_PARAMS,
      async execute() {
        const status = await stack.stopAndWait()
        return text({ stopped: status.state !== 'running', state: status.state })
      },
    }),
  )

  disposers.push(
    tool(ctx, {
      name: 'penpot_logs',
      description: '读取 Penpot 最近日志（已脱敏），用于排查启动或 MCP 问题。',
      parameters: {
        type: 'object',
        properties: {
          tail: { type: 'integer', minimum: 20, maximum: 1000, description: '读取最后多少行，默认 200' },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const tail = Number.isInteger(args?.tail) ? args.tail : 200
        return text(await stack.logs(tail))
      },
    }),
  )

  disposers.push(
    tool(ctx, {
      name: 'penpot_url',
      description:
        '返回 Penpot 的独立公开地址、本机地址、MCP 地址，以及手动登录和启用 MCP 的正确步骤。',
      parameters: EMPTY_PARAMS,
      async execute() {
        const status = await stack.status()
        return text({
          publicUri: status.publicUri,
          localUrl: status.localUrl,
          mcpUrl: status.mcpUrl,
          steps: [
            `用户在浏览器直接打开 ${status.publicUri}（独立端口，不经过 DSH 登录）并手动登录`,
            '注册/登录后新建或打开一个设计文件',
            '首次使用：账号 Settings → Integrations → MCP Server 启用，并 Generate MCP Key',
            '打开设计文件后插件会自动连接；工具栏出现绿点 MCP 即成功，不需要点 Connect（没有绿点就刷新文件页）',
            '先用 mcp__penpot__execute_code 返回 1 自检，再让 AI 画图',
            '导出前先确认当前页面和图层；印刷稿最后回 CorelDRAW 做 CMYK/出血',
          ],
          config,
        })
      },
    }),
  )

  return {
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already removed */
        }
      }
    },
  }
}