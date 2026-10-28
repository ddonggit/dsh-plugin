// Contract checks for the browser half: loader id, inject list, and lifecycle wiring.
// The page itself needs a React renderer, so these tests only assert the plugin
// surface the harness depends on (id/apply/inject + settings.section registration).

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

function loadClient({ withSlots = true } = {}) {
  const registered = []
  const styleTags = []
  const cleanups = []
  let loaderConfig = null

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  }

  const document = {
    visibilityState: 'visible',
    head: {
      appendChild(node) {
        styleTags.push(node)
        node.parentNode = this
      },
      removeChild(node) {
        const index = styleTags.indexOf(node)
        if (index >= 0) styleTags.splice(index, 1)
      },
    },
    createElement: (tag) => ({
      tagName: String(tag).toUpperCase(),
      dataset: {},
      set id(value) {
        this.attrs = Object.assign({}, this.attrs, { id: value })
      },
      get id() {
        return (this.attrs && this.attrs.id) || ''
      },
      parentNode: null,
      attrs: {},
    }),
    getElementById: (id) => styleTags.find((node) => node.id === id) || null,
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(config) {
          loaderConfig = config
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document,
    fetch: async () => Response.json({ ok: false }),
    console,
    Response,
    URL,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(clientSource, sandbox, { filename: 'lib/client.js' })

  assert.ok(loaderConfig, 'client.js must call window.__ModuleLoader__.load')
  const exported = loaderConfig.factory((name) => {
    assert.equal(name, 'react')
    return fakeReact
  })

  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      cleanups.push({ label, dispose })
      return dispose
    },
    get: () => undefined,
    slots: {
      inject(slotName, factory) {
        if (!withSlots) throw new Error('unexpected slot access: ' + slotName)
        registered.push({ slotName, factory })
      },
      register(descriptor, component) {
        return { descriptor, component }
      },
    },
  }

  return { loaderConfig, exported, ctx, registered, styleTags, cleanups }
}

test('loader id matches the package name and the patch insert id', () => {
  const { loaderConfig } = loadClient()
  assert.equal(loaderConfig.id, packageJson.name)
  const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('id: ' + packageJson.name), 'cordis.patch.yml insert id must match the package name')
})

test('the client declares only the slots service it truly needs', () => {
  const { exported } = loadClient()
  assert.deepEqual(Array.from(exported.inject), ['slots'])
  assert.equal(typeof exported.apply, 'function')
})

test('apply registers exactly one settings.section entry', () => {
  const { exported, ctx, registered } = loadClient()
  exported.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].slotName, 'settings.section')
  const section = registered[0].factory()
  // Cross-realm objects: compare fields, not prototypes.
  assert.equal(section.descriptor.name, 'settings.section')
  assert.equal(section.descriptor.id, 'usage-query')
  assert.equal(section.descriptor.label, '用量查询')
  assert.equal(section.descriptor.order, 41)
  assert.equal(typeof section.component, 'function')
})

test('apply injects one style tag and removes it on dispose', () => {
  const { exported, ctx, styleTags, cleanups } = loadClient()
  exported.apply(ctx)
  assert.equal(styleTags.length, 1)
  assert.equal(styleTags[0].id, 'dsh-usage-query/style')
  const styleCleanup = cleanups.find((entry) => String(entry.label).includes('styles'))
  assert.ok(styleCleanup, 'style injection must be registered through ctx.effect')
  styleCleanup.dispose()
  assert.equal(styleTags.length, 0)
})

test('re-applying replaces the previous style tag instead of duplicating it', () => {
  const { exported, ctx, styleTags } = loadClient()
  exported.apply(ctx)
  exported.apply(ctx)
  assert.equal(styleTags.length, 1)
})

test('the client never leaks a module-level "already loaded" guard', () => {
  // A global guard would make a second harness instance silently do nothing.
  assert.equal(clientSource.includes('__DSH_UQ_LOADED__'), false)
})
