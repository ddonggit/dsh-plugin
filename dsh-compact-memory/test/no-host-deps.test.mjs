import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('lib modules import only node: builtins and relative files', async () => {
  const libDir = path.join(root, 'lib')
  const files = (await fs.readdir(libDir)).filter((name) => name.endsWith('.js'))
  assert.ok(files.length > 0)
  for (const file of files) {
    const text = await fs.readFile(path.join(libDir, file), 'utf8')
    const specifiers = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('.'),
        `${file} imports ${specifier}; external plugins must stay self-contained`,
      )
      assert.ok(
        !specifier.startsWith('@deepseek-ai/'),
        `${file} imports host package ${specifier}; it would resolve a different module copy`,
      )
    }
  }
})

test('package manifest has no runtime dependencies and points at the bundle patch', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-compact-memory')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.files.includes('lib/**'))
  await fs.access(path.join(root, 'cordis.patch.yml'))
  await fs.access(path.join(root, 'icon.svg'))
})
