import { readFileSync } from 'node:fs'

const SKILL_FILE = new URL('../skills/penpot-poster.md', import.meta.url)

export function registerSkill(ctx) {
  const content = readFileSync(SKILL_FILE, 'utf8')
  const dispose = ctx.skills.register({
    name: 'penpot-poster',
    description:
      '在 Penpot 里生成可编辑的广告海报、促销图、社媒封面：原生文字/形状/渐变图层，可继续改字改色改版式，并导出 PNG/SVG/PDF。',
    whenToUse:
      '用户要在 Penpot 里做海报、Banner、朋友圈图、电商主图、传单或需要可编辑矢量稿时；先确认 Penpot 已连接 MCP 并有打开的设计文件。',
    source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: false },
    content,
  })

  return {
    dispose() {
      try {
        dispose()
      } catch {
        /* already removed */
      }
    },
  }
}