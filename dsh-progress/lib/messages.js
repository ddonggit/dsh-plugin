// 所有自动消息都在这里生成。只追加到对话，不改写工具结果，也不冒充用户的新指令。

import { createMessageId, truncate } from './text.js'

export const PROGRESS_KIND = '进度提醒'
export const DIRECTION_CHECK_KIND = '方向核对'
export const DIRECTION_CORRECTION_KIND = '方向纠偏'
export const TOOL_TIP_KIND = '工具提示'

export function noticeMessage(kind, text, summary) {
  return {
    id: createMessageId(),
    role: 'user',
    content: [{ type: 'text', text: truncate(text, 900) }],
    source: { kind, form: 'notice', summary: truncate(summary, 120) },
  }
}

function goalLine(anchor) {
  if (typeof anchor?.goal === 'string' && anchor.goal !== '') return truncate(anchor.goal, 300)
  if (typeof anchor?.request === 'string' && anchor.request !== '') return truncate(anchor.request, 300)
  return '（没有读到明确的用户目标）'
}

/** 模糊目标开始前的一次对齐；模型已经写了 goal/todo 就不会再发。 */
export function alignmentNotice(anchor) {
  const text = [
    '这个目标比较开放。开始前先用一句话写下：',
    '1. 你理解用户想要的结果；',
    '2. 第一步做什么；',
    '3. 怎么算完成、可以给用户看。',
    '可以用 todo_write 或 report_progress 记下来；如果目标已经清楚，忽略这条。',
    `用户原话：${truncate(anchor?.request ?? '', 300)}`,
  ].join('\n')
  return noticeMessage(DIRECTION_CHECK_KIND, text, '目标较开放，先对齐再动手')
}

/**
 * 中级别提醒：把硬事实摆出来，让模型自己决定是否继续。
 * reason 是短标签；observed/next 由调用方按规则生成。
 */
export function directionCheckNotice({ anchor, reason, observed, next }) {
  const text = [
    '方向核对：先别继续展开，用几秒钟对照用户目标。',
    `用户目标：${goalLine(anchor)}`,
    `观察到：${truncate(observed ?? '最近的动作和用户目标没有明显关联', 300)}`,
    `可疑点：${truncate(reason ?? '可能偏离了用户目标', 200)}`,
    `建议先做：${truncate(next ?? '回到用户目标，做最小的一步', 300)}`,
    '如果这是必要的关联，用一句话说明；如果已经回到目标，忽略这条。这是自动提醒，不是用户的新指令。',
  ].join('\n')
  return noticeMessage(DIRECTION_CHECK_KIND, text, `方向可能偏了：${truncate(reason ?? '请核对', 80)}`)
}

/** 高级别拉回：用 agent.steer 注入，让模型下一步先处理方向问题。 */
export function directionCorrectionNotice({ anchor, reason, observed, next }) {
  const text = [
    '停一下，方向可能偏了。',
    `用户要的是：${goalLine(anchor)}`,
    `你最近在做：${truncate(observed ?? '最近的动作和用户目标没有明显关联', 300)}`,
    `为什么可疑：${truncate(reason ?? '可能偏离了用户目标', 200)}`,
    `建议先回到：${truncate(next ?? '回到用户目标，做最小的一步', 300)}`,
    '如果这是用户明确要求的转向，先用一句话说明并更新 goal/todo；否则回到上面的目标继续。这是自动提醒，不是用户的新指令。',
  ].join('\n')
  return noticeMessage(DIRECTION_CORRECTION_KIND, text, `已偏离目标：${truncate(reason ?? '请拉回', 80)}`)
}

export function toolTipNotice(text, summary = '有更直接的用法') {
  const body = `工具提示：${truncate(text, 600)}`
  return noticeMessage(TOOL_TIP_KIND, body, summary)
}

/** bash 里做了 read/grep/glob 能直接做的事。 */
export function bashTipNotice(tip) {
  const hint =
    tip.tool === 'read'
      ? '用 file_path 指定文件'
      : tip.tool === 'grep'
        ? '用 pattern 和 path 搜索'
        : '用 pattern 查找文件'
  const text = `这条 bash 命令只是${tip.action}。可以直接用 ${tip.tool} 工具（${hint}），bash 留给管道和组合命令。命令：${truncate(tip.command, 120)}`
  return toolTipNotice(text, `bash 里的简单${tip.action}可以直接用 ${tip.tool}`)
}

/** 报了 done，但上次写文件后没有成功的测试/构建。 */
export function doneUnverifiedTip() {
  const text =
    '你刚报了完成，但上次写文件后没有看到成功的测试/构建。先跑一个最小验证；如果确实没法自动验证，在汇报里写明“手动验证/需要你看”，不要直接算完成。'
  return toolTipNotice(text, '报完成前先补一次验证')
}

/** 写入目标不在用户点名的路径里。 */
export function scopeTip(target, anchor) {
  const paths = Array.isArray(anchor?.paths) ? anchor.paths.join('、') : ''
  const text = `这次写入的 ${truncate(target, 160)} 不在用户点名的范围（${truncate(paths, 200)}）。如果是必要关联，用一句话说明；否则先回到点名范围。`
  return toolTipNotice(text, '写入目标超出用户点名范围')
}
