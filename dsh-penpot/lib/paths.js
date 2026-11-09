import { mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'

async function makeDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o755 })
  // Windows ignores POSIX modes; chmod can throw EPERM on some filesystems.
  if (process.platform !== 'win32') await chmod(dir, 0o755)
}

export function layout(dataDir) {
  const root = path.resolve(dataDir)
  return {
    root,
    composeFile: path.join(root, 'docker-compose.yml'),
    envFile: path.join(root, '.env'),
    settingsFile: path.join(root, 'settings.json'),
    importsDir: path.join(root, 'imports'),
    logsDir: path.join(root, 'logs'),
  }
}

export async function ensureLayout(dataDir) {
  const paths = layout(dataDir)
  await makeDir(paths.root)
  await makeDir(paths.importsDir)
  await makeDir(paths.logsDir)
  return paths
}