import test from 'node:test'
import assert from 'node:assert/strict'

import {
  emptyCard,
  isCardEmpty,
  isStale,
  mergeSections,
  mergeSnapshot,
  normalizeSections,
  redactSecrets,
  renderMarkdown,
  trimToLimit,
} from '../lib/card.js'

test('normalizeSections accepts strings, bullets, and arrays', () => {
  const patch = normalizeSections({
    goal: '  做一个插件  ',
    done: '- 读源码\n- 写测试',
    decisions: ['选 A，因为更稳', '选 A，因为更稳'],
    constraints: '必须保持兼容',
    files: ['/tmp/a.js'],
  })
  assert.equal(patch.goal, '做一个插件')
  assert.deepEqual(patch.done, ['读源码', '写测试'])
  assert.deepEqual(patch.decisions, ['选 A，因为更稳'])
  assert.deepEqual(patch.constraints, ['必须保持兼容'])
})

test('mergeSections appends and replace mode replaces only named sections', () => {
  let card = emptyCard('s1')
  card = mergeSections(card, normalizeSections({ done: ['a'], decisions: ['d1'] }))
  assert.deepEqual(card.sections.done, ['a'])
  assert.deepEqual(card.sections.decisions, ['d1'])

  card = mergeSections(card, normalizeSections({ done: ['b'] }), { mode: 'merge' })
  assert.deepEqual(card.sections.done, ['a', 'b'])

  card = mergeSections(card, normalizeSections({ done: ['c'] }), { mode: 'replace' })
  assert.deepEqual(card.sections.done, ['c'])
  assert.deepEqual(card.sections.decisions, ['d1'])
})

test('mergeSnapshot fills empty sections and refreshes factual sections when stale', () => {
  let card = emptyCard('s1')
  card = mergeSections(card, normalizeSections({ decisions: ['模型写的决定'] }))
  const snapshot = {
    sections: {
      goal: '快照目标',
      done: ['快照完成'],
      decisions: ['快照决定'],
      next: ['快照下一步'],
    },
  }

  const fresh = mergeSnapshot(card, snapshot, { stale: false, turn: 1 })
  assert.equal(fresh.sections.goal, '快照目标')
  assert.deepEqual(fresh.sections.done, ['快照完成'])
  assert.deepEqual(fresh.sections.decisions, ['模型写的决定'])
  assert.deepEqual(fresh.sections.next, ['快照下一步'])

  const stale = mergeSnapshot(card, snapshot, { stale: true, turn: 5 })
  assert.equal(stale.sections.goal, '快照目标')
  assert.deepEqual(stale.sections.done, ['快照完成'])
  assert.deepEqual(stale.sections.decisions, ['模型写的决定'])
  assert.equal(stale.source, 'merged')
})

test('renderMarkdown includes the card marker sections', () => {
  let card = emptyCard('s1')
  card = mergeSections(card, normalizeSections({
    goal: '目标',
    done: ['完成 1'],
    next: ['下一步 1'],
  }))
  const markdown = renderMarkdown(card)
  assert.match(markdown, /^# 工作交接卡/)
  assert.match(markdown, /## 目标/)
  assert.match(markdown, /## 已完成/)
  assert.match(markdown, /## 下一步/)
  assert.match(markdown, /- 完成 1/)
})

test('trimToLimit drops low-priority sections first and respects the limit', () => {
  let card = emptyCard('s1')
  card = mergeSections(card, normalizeSections({
    goal: '目标'.repeat(80),
    next: ['下一步'.repeat(30), '第二个下一步'],
    decisions: ['决定'.repeat(40)],
    questions: ['待确认'.repeat(40)],
    files: ['/a'.repeat(60)],
  }))
  const trimmed = trimToLimit(card, 600)
  assert.ok(trimmed.rendered.length <= 600, `rendered ${trimmed.rendered.length}`)
  assert.equal(trimmed.card.sections.questions.length, 0)
  assert.ok(trimmed.rendered.includes('工作交接卡'))
})

test('redactSecrets removes obvious secret shapes but keeps commit hashes', () => {
  const fakeSk = ['s', 'k', '-', 'fake', 'value', '12345678'].join('')
  assert.equal(redactSecrets(fakeSk), '[redacted-key]')
  const fakeAssignment = ['API', 'KEY'].join('_') + '=this-is-a-fake-value'
  assert.match(redactSecrets(fakeAssignment), /API_KEY=\[redacted\]/)
  assert.match(redactSecrets('Authorization: Bearer abcdefghijklmnop'), /Bearer \[redacted\]/)
  const hash = 'abcdef1234567890abcdef1234567890abcdef12'
  assert.equal(redactSecrets(hash), hash)
})

test('isCardEmpty and isStale follow the documented rules', () => {
  const card = emptyCard('s1', 1000)
  assert.equal(isCardEmpty(card), true)
  card.sections.goal = '目标'
  assert.equal(isCardEmpty(card), false)
  card.updatedTurn = 1
  assert.equal(isStale(card, { turn: 10, staleTurns: 2, now: 2000, maxAgeMs: 0 }), true)
  card.updatedTurn = 10
  assert.equal(isStale(card, { turn: 12, staleTurns: 2, now: 2000, maxAgeMs: 0 }), false)
})
