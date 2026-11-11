import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSnapshot } from '../lib/snapshot.js'
import { assistantMessage, sampleSessionEvents, userMessage } from './helpers/fixtures.mjs'

test('buildSnapshot extracts goal, todos, decisions, constraints, files, and pitfalls', () => {
  const snapshot = buildSnapshot({ session: { id: 's1' }, events: sampleSessionEvents(), now: 123 })

  assert.match(snapshot.sections.goal, /自动压缩 dsh 会话记录/)
  assert.ok(snapshot.sections.done.includes('读 dsh 压缩源码'))
  assert.ok(snapshot.sections.next.some((item) => item.includes('写测试')))
  assert.ok(snapshot.sections.decisions.some((item) => item.includes('决定')))
  assert.deepEqual(snapshot.sections.constraints, [])
  assert.ok(snapshot.sections.files.includes('/tmp/plugin/lib/index.js'))
  assert.ok(snapshot.sections.pitfalls.some((item) => item.includes('ENOENT')))
  assert.equal(snapshot.source, 'snapshot')
})

test('buildSnapshot handles an empty log without throwing', () => {
  const snapshot = buildSnapshot({ session: { id: 's1' }, events: [], now: 1 })
  assert.equal(snapshot.sections.goal, '')
  assert.deepEqual(snapshot.sections.done, [])
  assert.deepEqual(snapshot.sections.files, [])
})

test('buildSnapshot picks the latest todo snapshot', () => {
  const events = sampleSessionEvents()
  events.push({
    type: 'todo/write',
    seq: 5,
    data: {
      todos: [
        { content: '旧任务', status: 'pending' },
        { content: '新任务', status: 'completed' },
      ],
    },
  })
  const snapshot = buildSnapshot({ session: { id: 's1' }, events, now: 1 })
  assert.ok(snapshot.sections.done.includes('新任务'))
  assert.ok(snapshot.sections.next.includes('旧任务'))
  assert.ok(!snapshot.sections.next.some((item) => item.includes('写测试')))
  assert.ok(!snapshot.sections.done.includes('读 dsh 压缩源码'))
})

test('buildSnapshot turns shell commands into clean path tokens', () => {
  const events = [
    userMessage(0, '查状态'),
    assistantMessage(1, '查状态', {
      toolCall: {
        name: 'bash',
        arguments: {
          command:
            "cd /opt/dsh-plugins/dsh-compact-memory && npm test 2>&1 | tail -20; cat '/tmp/dsh-compact-memory-restart.log' >/dev/null; grep -rn x lib/*.js",
        },
      },
    }),
  ]
  const files = buildSnapshot({ session: { id: 's1' }, events, now: 1 }).sections.files
  assert.deepEqual(files, ['/opt/dsh-plugins/dsh-compact-memory', '/tmp/dsh-compact-memory-restart.log'])
  assert.ok(!files.some((item) => item.includes('npm test') || item.includes(';')))
})

test('buildSnapshot keeps explicit file paths ahead of command paths', () => {
  const events = [
    assistantMessage(1, '读文件', {
      toolCall: { name: 'read', arguments: { file_path: '/opt/app/src/index.js' } },
    }),
    assistantMessage(2, '搜索', {
      toolCall: { name: 'grep', arguments: { pattern: 'token', path: '.' } },
    }),
  ]
  for (let index = 0; index < 8; index += 1) {
    events.push(
      assistantMessage(3 + index, '跑脚本', {
        toolCall: { name: 'bash', arguments: { command: `node /opt/app/logs/run-${index}.js` } },
      }),
    )
  }
  const files = buildSnapshot({ session: { id: 's1' }, events, now: 1 }).sections.files
  assert.equal(files[0], '/opt/app/src/index.js')
  assert.ok(files.includes('/opt/app/logs/run-7.js'))
  assert.ok(!files.includes('.'))
  assert.equal(files.length, 8)
})
