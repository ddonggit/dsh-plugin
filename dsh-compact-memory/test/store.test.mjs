import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'

import { CardStore } from '../lib/store.js'
import { emptyCard, mergeSections, normalizeSections } from '../lib/card.js'

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-store-'))
}

test('save/load round-trips and uses owner-only modes', async () => {
  const dir = await tempDir()
  try {
    const store = new CardStore(dir, { mirrorMarkdown: true, historyLimit: 2 })
    let card = emptyCard('s1')
    card = mergeSections(card, normalizeSections({ goal: '目标', next: ['下一步'] }))
    const file = await store.save(card)
    const stat = await fs.stat(file)
    assert.equal(stat.mode & 0o777, 0o600)
    const dirStat = await fs.stat(path.dirname(file))
    assert.equal(dirStat.mode & 0o777, 0o700)

    const loaded = await store.load('s1')
    assert.equal(loaded.sections.goal, '目标')
    assert.deepEqual(loaded.sections.next, ['下一步'])
    assert.match(await store.readMarkdown('s1'), /# 工作交接卡/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('corrupt JSON is quarantined and load returns null', async () => {
  const dir = await tempDir()
  try {
    const store = new CardStore(dir)
    await store.save(emptyCard('s1'))
    const file = store.cardPathFor('s1')
    await fs.writeFile(file, '{ this is not json')
    assert.equal(await store.load('s1'), null)
    const entries = await fs.readdir(path.dirname(file))
    assert.ok(entries.some((name) => name.startsWith('card.json.corrupt-')))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('history keeps only the configured number of versions', async () => {
  const dir = await tempDir()
  try {
    const store = new CardStore(dir, { mirrorMarkdown: true, historyLimit: 2 })
    for (let index = 0; index < 5; index += 1) {
      const card = emptyCard('s1')
      card.sections.goal = `目标 ${index}`
      card.updatedAt = Date.now() + index
      await store.save(card)
    }
    const historyDir = path.join(store.dirFor('s1'), 'history')
    const entries = (await fs.readdir(historyDir)).filter((name) => name.endsWith('.md'))
    assert.ok(entries.length <= 2, `history has ${entries.length} files`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('inherit copies the parent card and resets compaction state', async () => {
  const dir = await tempDir()
  try {
    const store = new CardStore(dir)
    let parent = emptyCard('parent')
    parent = mergeSections(parent, normalizeSections({ goal: '父目标', decisions: ['父决定'] }))
    parent.lastCompaction = { id: 'c1', endSeq: 10 }
    await store.save(parent)

    const child = await store.inherit('parent', 'child')
    assert.equal(child.sessionId, 'child')
    assert.equal(child.sections.goal, '父目标')
    assert.deepEqual(child.sections.decisions, ['父决定'])
    assert.equal(child.lastCompaction, null)
    assert.equal(child.source, 'inherited')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('unsafe session ids are sanitized deterministically', () => {
  const store = new CardStore('/tmp/dsh-cm-store-check')
  const first = store.dirFor('a/b:c')
  const second = store.dirFor('a/b:c')
  assert.equal(first, second)
  assert.ok(!first.includes(':'))
  assert.ok(first.includes(path.sep))
})
