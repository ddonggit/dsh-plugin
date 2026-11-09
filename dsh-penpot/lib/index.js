import { resolveConfig } from './config.js'
import { ensureLayout, layout } from './paths.js'
import { loadSettings } from './settings.js'
import { createStack } from './stack.js'
import { registerRoutes } from './routes.js'
import { registerTools } from './tools.js'
import { registerSkill } from './skill.js'

export const name = 'dsh-penpot'
export const inject = ['webServer', 'tools', 'skills', 'webApp']

/**
 * Host half: owns the Docker stack, the direct-port public URL, the panel
 * API, model tools and the poster skill. The browser half is client.js.
 * Penpot is intentionally NOT proxied under DSH: users open the independent
 * frontend port and log in there, so DSH's auth cookies never enter the path.
 */
export async function apply(ctx, rawConfig = {}) {
  const logger = ctx.logger || console
  const advertised = ctx.webApp?.getAdvertisedUrl?.()
  const env = advertised ? { ...process.env, DSH_WEB_URL: advertised } : process.env
  const base = resolveConfig(rawConfig, {}, env)
  await ensureLayout(base.dataDir)
  const stored = await loadSettings(layout(base.dataDir).settingsFile)
  const config = resolveConfig(rawConfig, stored, env)

  const stack = createStack({ config, logger })
  const routes = registerRoutes(ctx, { stack, config, logger })
  const tools = registerTools(ctx, { stack, config })
  const skill = registerSkill(ctx)

  ctx.effect(() => {
    return () => {
      skill.dispose()
      tools.dispose()
      routes.dispose()
      stack.cleanup()
    }
  })

  if (config.autoStart) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        stack.startInBackground().catch((error) => {
          logger?.warn?.('[dsh-penpot] auto start failed', error)
        })
      }, 1200)
      return () => clearTimeout(timer)
    })
  }

  logger?.info?.(`[dsh-penpot] mounted at ${config.publicUri} (Penpot ${config.penpotVersion})`)
}