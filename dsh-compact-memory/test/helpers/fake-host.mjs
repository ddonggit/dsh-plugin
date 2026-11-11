import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { apply } from '../../lib/index.js'

export class FakeSession {
  constructor(id, { header = {} } = {}) {
    this.id = id
    this.header = { origin: undefined, parentSession: undefined, ...header }
    this.events = []
    this.seq = 0
  }

  snapshotEvents(fromSeq = 0, toSeqExclusive) {
    return this.events.filter(
      (event) =>
        event.seq >= fromSeq &&
        (toSeqExclusive === undefined || event.seq < toSeqExclusive),
    )
  }

  requestHeader() {
    return this.header.requestHeader
  }

  append(type, data, extra = {}) {
    const event = { type, seq: this.seq, time: Date.now(), data, ...extra }
    this.seq += 1
    this.events.push(event)
    return event
  }
}

export function createAgent(session, { idle = true } = {}) {
  return {
    session,
    status: idle ? 'idle' : 'running',
    options: { maxTokens: 384000 },
    async whenIdle() {
      this.status = 'idle'
    },
  }
}

export async function createHost({
  config = {},
  pressure = {},
  turn = 1,
  commandResult = { kind: 'success', text: 'Compacted 10 items' },
  dir = null,
} = {}) {
  const handlers = new Map()
  const tools = []
  const commands = []
  const effects = []
  const commandCalls = []
  const warnings = []
  let currentTurn = turn

  const logger = {
    info() {},
    debug() {},
    warn(message) {
      warnings.push(String(message))
    },
  }

  const ctx = {
    logger,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
      return () => {}
    },
    async emit(name, ...args) {
      const list = handlers.get(name) ?? []
      const results = []
      for (const handler of list) results.push(await handler(...args))
      return results
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    effect(effect) {
      const dispose = effect()
      effects.push(dispose)
      return dispose
    },
    tools: {
      register(definition) {
        tools.push(definition)
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
      },
      async execute(agent, line, attachments, signal) {
        commandCalls.push({ agent, line, attachments, signal })
        return typeof commandResult === 'function' ? commandResult(agent, line) : commandResult
      },
    },
    tokenMeter: {
      contextPressure() {
        return { ...pressure }
      },
      measure() {
        return { surfaceTokens: pressure.surfaceTokens ?? 0 }
      },
    },
    agents: {
      turnBoundaryOf() {
        return { lastTurn: currentTurn }
      },
    },
  }

  const ownsDir = dir === null
  const memoryDir = dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-compact-memory-')))
  apply(ctx, { ...config, memoryDir })

  return {
    ctx,
    dir: memoryDir,
    ownsDir,
    tools,
    commands,
    commandCalls,
    warnings,
    handlers,
    setTurn(value) {
      currentTurn = value
    },
    async dispose() {
      for (const effect of effects) {
        try {
          await effect?.()
        } catch {
          // best effort
        }
      }
      if (ownsDir) await fs.rm(memoryDir, { recursive: true, force: true })
    },
  }
}

export async function emitSessionEvent(host, session, type, data = {}, extra = {}) {
  const event = session.append(type, data, extra)
  await host.ctx.emit('session/event', session, event)
  return event
}

export async function emitAgentCreated(host, agent, source = 'startup') {
  await host.ctx.emit('agent/created', { agent, source })
}

export async function preStep(host, agent, messages = []) {
  const list = host.handlers.get('agent/pre-step') ?? []
  const signal = new AbortController().signal
  const enter = async () => ({ kind: 'enter', messages: [...messages] })
  const call = async (index) => {
    if (index < 0) return enter()
    const handler = list[index]
    return handler({ agent, signal }, () => call(index - 1))
  }
  return call(list.length - 1)
}

export function toolByName(host, name) {
  return host.tools.find((tool) => tool.name === name)
}
