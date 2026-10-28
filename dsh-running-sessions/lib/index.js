// Host half. 本插件的数据全部来自浏览器端已有服务，宿主只做出口与日志。
export const name = 'dsh-running-sessions'

/** Nothing in the Host is required beyond the bundle entry itself. */
export function apply(ctx, config) {
  const window = Number(config?.activeWindowMinutes ?? 30)
  ctx.logger?.debug?.(`[${name}] active window ${window} min`)
}
