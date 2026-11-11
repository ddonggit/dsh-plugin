import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FakeSession,
  createAgent,
  createHost,
  emitAgentCreated,
  emitSessionEvent,
  preStep,
  toolByName,
} from './helpers/fake-host.mjs'

const PRESSURE = {
  pressureTokens: 600000,
  projectedTokens: 600100,
  contextWindow: 1048576,
  surfaceTokens: 600000,
}

const LOW_PRESSURE = {
  pressureTokens: 500000,
  projectedTokens: 500000,
  contextWindow: 1048576,
  surfaceTokens: 500000,
}

const CONFIG = {
  autoCompact: {
    mode: 'boundary',
    idleGraceMs: 0,
    minNewSurfaceTokens: 0,
    minTurnsSinceLast: 0,
  },
  maxCardChars: 6000,
}

function userMessageData(text) {
  return {
    id: `u-${text.length}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

test('successful compaction injects exactly one card and survives restart', async () => {
  const host = await createHost({ config: CONFIG, pressure: PRESSURE, turn: 3 })
  try {
    const session = new FakeSession('s1')
    const agent = createAgent(session)
    await emitAgentCreated(host, agent)

    await emitSessionEvent(host, session, 'user/message', userMessageData('目标：做一个压缩插件'))
    await emitSessionEvent(host, session, 'compaction/start', { compactionId: 'c1', turn: 3 })
    await emitSessionEvent(host, session, 'compaction/summary', {
      compactionId: 'c1',
      shadowedTokenCount: 480000,
    })
    await emitSessionEvent(host, session, 'compaction/end', { compactionId: 'c1', turn: 3 })

    const first = await preStep(host, agent)
    assert.equal(first.kind, 'enter')
    assert.equal(first.messages.length, 1)
    assert.equal(first.messages[0].role, 'user')
    assert.equal(first.messages[0].source.kind, 'compact-memory')
    assert.match(first.messages[0].content[0].text, /工作交接卡/)

    const second = await preStep(host, agent)
    assert.equal(second.messages.length, 0)

    // The real loop commits admitted messages; simulate that, then reload the
    // same memory directory in a fresh plugin instance.
    session.append('user/message', first.messages[0])
    await new Promise((resolve) => setTimeout(resolve, 25))

    const host2 = await createHost({ config: CONFIG, pressure: PRESSURE, turn: 3, dir: host.dir })
    try {
      const session2 = new FakeSession('s1')
      session2.events = session.events
      session2.seq = session.seq
      const agent2 = createAgent(session2)
      await emitAgentCreated(host2, agent2)
      const third = await preStep(host2, agent2)
      assert.equal(third.messages.length, 0)
    } finally {
      await host2.dispose()
    }
  } finally {
    await host.dispose()
  }
})

test('a failed compaction does not inject a card', async () => {
  const host = await createHost({ config: CONFIG, pressure: PRESSURE, turn: 1 })
  try {
    const session = new FakeSession('s2')
    const agent = createAgent(session)
    await emitAgentCreated(host, agent)
    await emitSessionEvent(host, session, 'compaction/start', { compactionId: 'c2', turn: 1 })
    await emitSessionEvent(host, session, 'compaction/end', {
      compactionId: 'c2',
      turn: 1,
      error: 'summary failed',
    })
    const decision = await preStep(host, agent)
    assert.equal(decision.messages.length, 0)
  } finally {
    await host.dispose()
  }
})

test('boundary scheduler calls /compact at the native threshold', async () => {
  const host = await createHost({ config: CONFIG, pressure: PRESSURE, turn: 3 })
  try {
    const session = new FakeSession('s3')
    const agent = createAgent(session)
    await emitAgentCreated(host, agent)
    await emitSessionEvent(host, session, 'user/message', userMessageData('继续做事'))
    await emitSessionEvent(host, session, 'turn/end', { turn: 3, reason: 'complete' })
    assert.equal(host.commandCalls.length, 1)
    assert.equal(host.commandCalls[0].line, '/compact')
  } finally {
    await host.dispose()
  }
})

test('boundary scheduler does not call /compact below the native threshold', async () => {
  const host = await createHost({ config: CONFIG, pressure: LOW_PRESSURE, turn: 3 })
  try {
    const session = new FakeSession('s4')
    const agent = createAgent(session)
    await emitAgentCreated(host, agent)
    await emitSessionEvent(host, session, 'turn/end', { turn: 3, reason: 'complete' })
    assert.equal(host.commandCalls.length, 0)
  } finally {
    await host.dispose()
  }
})

test('subagent sessions are skipped by the compaction scheduler', async () => {
  const host = await createHost({ config: CONFIG, pressure: PRESSURE, turn: 1 })
  try {
    const session = new FakeSession('s5', { header: { origin: 'subagent' } })
    const agent = createAgent(session)
    await emitAgentCreated(host, agent)
    await emitSessionEvent(host, session, 'turn/end', { turn: 1, reason: 'complete' })
    assert.equal(host.commandCalls.length, 0)
  } finally {
    await host.dispose()
  }
})

test('worklog tools and /handoff expose the card', async () => {
  const host = await createHost({ config: CONFIG, pressure: PRESSURE, turn: 2 })
  try {
    const session = new FakeSession('s6')
    const agent = createAgent(session)
    await emitAgentCreated(host, agent)

    const write = toolByName(host, 'worklog_write')
    assert.ok(write, 'worklog_write registered')
    const written = await write.execute(
      { goal: '目标', decisions: ['选 A 因为稳'], next: ['写测试'] },
      { agent },
    )
    assert.equal(written.ok, true)
    assert.match(written.card, /选 A 因为稳/)

    const read = toolByName(host, 'worklog_read')
    const readResult = await read.execute({}, { agent })
    assert.match(readResult.card, /选 A 因为稳/)

    const statusTool = toolByName(host, 'compact_status')
    const statusResult = await statusTool.execute({}, { agent })
    assert.match(statusResult.note, /原生阈值=599040/)
    assert.match(statusResult.note, /57\.13%/)

    const command = host.commands.find((item) => item.name === 'handoff')
    assert.ok(command, '/handoff registered')
    const commandResult = await command.handler({
      agent,
      rawInput: '',
      signal: new AbortController().signal,
    })
    assert.equal(commandResult.kind, 'success')
    assert.match(commandResult.text, /工作交接卡/)
  } finally {
    await host.dispose()
  }
})
