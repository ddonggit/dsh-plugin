/**
 * Notification content: one notice, rendered for every channel.
 *
 * Both halves use this module. The host renders a notice once and either sends
 * it (host path) or serves it at `/api/dsh-mobile/notice` so the browser half can
 * post the very same card from its own webhook. That is the whole reason the
 * renderers live here instead of inside the channel adapters: a Feishu card must
 * not look different depending on which half delivered it.
 *
 * Field order is chosen for a phone notification banner: the first line is the
 * outcome (result / error / waiting), the task follows, the long text and the
 * fact line stay below the fold.
 */

import path from 'node:path';

export const MAX_HEADLINE = 48;
export const MAX_TASK = 100;
export const MAX_OUTCOME = 200;
export const MAX_DETAIL = 500;
export const MAX_FACTS = 120;
export const MAX_SUMMARY = 160;

/** Per-variant presentation. `kind` is what `notify.events` gates on. */
const STYLES = {
  done: { emoji: '✅', word: '完成', template: 'green', tags: 'white_check_mark', priority: 3, kind: 'done' },
  'max-tokens': { emoji: '⚠️', word: '跑满上限', template: 'orange', tags: 'warning', priority: 4, kind: 'done' },
  error: { emoji: '❌', word: '失败', template: 'red', tags: 'warning', priority: 4, kind: 'error' },
  ask: { emoji: '❓', word: '待确认', template: 'orange', tags: 'question', priority: 4, kind: 'ask' },
  auto: { emoji: '🤖', word: '已自动处理', template: 'blue', tags: 'robot', priority: 3, kind: 'auto' },
  aborted: { emoji: '⏹', word: '已中断', template: 'grey', tags: 'stop_sign', priority: 2, kind: '' },
  blocked: { emoji: '⏸', word: '已阻塞', template: 'grey', tags: 'pause_button', priority: 2, kind: '' },
  interrupted: { emoji: '⏹', word: '已中断', template: 'grey', tags: 'stop_sign', priority: 2, kind: '' },
  forked: { emoji: '⑂', word: '已分叉', template: 'grey', tags: 'twisted_rightwards_arrows', priority: 2, kind: '' },
};

export const styleOf = (variant) => STYLES[variant] ?? STYLES.done;

/** Truncate without splitting a surrogate pair. */
export function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+$/, '');
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/** Collapse every run of whitespace, so one field stays one line. */
export function oneLine(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return '<1s';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function workspaceName(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  return path.basename(cwd) || cwd;
}

export function failureText(error) {
  if (!error) return '';
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : String(error);
  return oneLine(code ? `${code}: ${message}` : message).slice(0, 240);
}

function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1000) return String(Math.round(value));
  if (value < 1000000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1000000).toFixed(1)}M`;
}

/**
 * The grey fact line: workspace, duration, turn, steps, tools, tokens, model.
 * Parts drop from the tail first, so a long model name never squeezes out the
 * workspace or the elapsed time.
 */
export function factsLine(facts = {}) {
  const duration = formatDuration(facts.durationMs);
  const tokens = formatTokens(facts.tokens);
  const parts = [
    facts.workspace ? `工作区 ${facts.workspace}` : '',
    duration ? `用时 ${duration}` : '',
    Number.isFinite(facts.turn) && facts.turn > 0 ? `第 ${facts.turn} 轮` : '',
    Number.isFinite(facts.steps) && facts.steps > 0 ? `${facts.steps} 步` : '',
    Number.isFinite(facts.tools) && facts.tools > 0 ? `${facts.tools} 次工具调用` : '',
    tokens ? `${tokens} tokens` : '',
    facts.model ? String(facts.model) : '',
  ].filter(Boolean);
  while (parts.length > 0 && Array.from(parts.join(' · ')).length > MAX_FACTS) parts.pop();
  return parts.join(' · ');
}

/** Body blocks in reading order; the first one is what the banner previews. */
function bodyBlocks(input) {
  const { variant } = input;
  const result = String(input.result ?? '');
  const outcome = oneLine(result);
  const blocks = [];

  if (variant === 'done') {
    blocks.push({ label: '结果', text: clip(outcome || '（本轮没有文字输出）', MAX_OUTCOME) });
  } else if (variant === 'max-tokens') {
    blocks.push({ label: '提示', text: '输出达到 token 上限，结论可能不完整' });
    if (outcome) blocks.push({ label: '最后输出', text: clip(outcome, MAX_OUTCOME) });
  } else if (variant === 'error') {
    blocks.push({ label: '错误', text: clip(failureText(input.error) || outcome || '本轮以错误结束', MAX_OUTCOME) });
    if (outcome) blocks.push({ label: '最后输出', text: clip(outcome, MAX_OUTCOME) });
  } else if (variant === 'ask') {
    blocks.push({ label: '等待', text: clip(oneLine(input.waitText) || '需要你确认', 120) });
    if (input.waitReason) blocks.push({ label: '原因', text: clip(oneLine(input.waitReason), MAX_OUTCOME) });
    const options = Array.isArray(input.waitOptions) ? input.waitOptions.filter((item) => oneLine(item)).slice(0, 4) : [];
    if (options.length > 0) blocks.push({ label: '选项', text: options.map((item, index) => `${index + 1}) ${oneLine(item)}`).join('   ') });
  } else if (variant === 'auto') {
    blocks.push({ label: '处理', text: clip(oneLine(input.handled) || '已代为处理', 160) });
  }

  if (variant !== 'ask' && input.task) blocks.push({ label: '任务', text: clip(oneLine(input.task), MAX_TASK) });
  return blocks;
}

/**
 * Build one notice.
 *
 * `variant` picks the wording and colour; the resulting object is plain data so
 * it can cross the host/browser boundary as JSON unchanged.
 */
export function createNotice(input = {}) {
  const variant = STYLES[input.variant] ? input.variant : 'done';
  const style = styleOf(variant);
  const sessionId = String(input.sessionId ?? '');
  const sessionTitle = oneLine(input.sessionTitle);
  // Body blocks read the normalized variant: `completed` and friends are turn
  // reasons, not presentation variants, and must render as `done`.
  const blocks = bodyBlocks({ ...input, variant });

  const rawOutcome = variant === 'error'
    ? String(failureText(input.error) || input.result || '')
    : String(input.result ?? '');
  const detailSource = input.detail ? String(input.detail) : rawOutcome;
  const detail = Array.from(detailSource).length > MAX_OUTCOME ? clip(detailSource, MAX_DETAIL) : '';

  const facts = { ...(input.facts ?? {}) };
  const line = factsLine(facts);
  const link = String(input.link ?? '');
  const title = clip(sessionTitle ? `${style.emoji} ${style.word} · ${sessionTitle}` : `${style.emoji} ${style.word}`, MAX_HEADLINE);

  const lead = blocks[0] ? `${blocks[0].label}：${blocks[0].text}` : style.word;
  const tail = [facts.workspace ? `工作区 ${facts.workspace}` : '', formatDuration(facts.durationMs)].filter(Boolean).join(' · ');
  const summary = clip([lead, tail].filter(Boolean).join(' · '), MAX_SUMMARY);

  const notice = {
    kind: style.kind,
    variant,
    sessionId,
    title,
    summary,
    blocks,
    detail,
    facts,
    factsLine: line,
    link,
    at: Number.isFinite(input.at) ? input.at : Date.now(),
  };
  notice.text = renderPlain(notice);
  notice.markdown = renderMarkdown(notice);
  // The banner already shows the title, so the body repeats only the content.
  notice.toast = [
    ...blocks.map((block) => `${block.label}：${block.text}`),
    notice.factsLine,
  ].filter(Boolean).join('\n');
  notice.payloads = {
    feishu: renderFeishu(notice),
    dingtalk: renderDingtalk(notice),
    wecom: renderWecom(notice),
    serverchan: renderServerchan(notice),
    telegram: renderTelegram(notice),
    ntfy: renderNtfy(notice),
    generic: renderGeneric(notice),
  };
  return notice;
}

/** Plain text: notification body, Telegram, Feishu fallback, feed body. */
export function renderPlain(notice) {
  const lines = [notice.title];
  for (const block of notice.blocks ?? []) lines.push(`${block.label}  ${block.text}`);
  if (notice.detail) lines.push('', notice.detail);
  if (notice.factsLine) lines.push('', notice.factsLine);
  if (notice.link) lines.push(notice.link);
  return lines.join('\n').trim();
}

/** Markdown for DingTalk / WeCom / ServerChan. */
export function renderMarkdown(notice) {
  const lines = [`### ${notice.title}`];
  if (notice.blocks?.length) lines.push(notice.blocks.map((block) => `> **${block.label}** ${block.text}`).join('\n\n'));
  if (notice.detail) lines.push(notice.detail);
  if (notice.factsLine) lines.push(notice.factsLine);
  if (notice.link) lines.push(`[打开会话](${notice.link})`);
  return lines.filter(Boolean).join('\n\n').trim();
}

/** Feishu interactive card (custom bot accepts `msg_type: interactive`). */
export function renderFeishu(notice) {
  const style = styleOf(notice.variant);
  const elements = [];
  if (notice.blocks?.length) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: notice.blocks.map((block) => `**${block.label}**  ${block.text}`).join('\n') },
    });
  }
  if (notice.detail) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: notice.detail } });
  }
  if (notice.factsLine) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: notice.factsLine }] });
  }
  if (notice.link) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          type: 'primary',
          text: { tag: 'plain_text', content: '打开会话' },
          url: notice.link,
        },
      ],
    });
  }
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template: style.template, title: { tag: 'plain_text', content: notice.title } },
      elements,
    },
  };
}

export function renderDingtalk(notice) {
  return { msgtype: 'markdown', markdown: { title: notice.title, text: notice.markdown } };
}

export function renderWecom(notice) {
  return { msgtype: 'markdown', markdown: { content: notice.markdown } };
}

export function renderServerchan(notice) {
  return { title: notice.title, desp: notice.markdown || notice.text };
}

export function renderTelegram(notice) {
  return { text: notice.text, disable_web_page_preview: true };
}

export function renderNtfy(notice) {
  const style = styleOf(notice.variant);
  const payload = { title: clip(notice.title, 120), body: notice.text, tags: style.tags, priority: style.priority };
  if (notice.link) payload.click = notice.link;
  return payload;
}

export function renderGeneric(notice) {
  return {
    source: 'dsh-mobile',
    event: notice.kind || notice.variant,
    variant: notice.variant,
    sessionId: notice.sessionId,
    title: notice.title,
    summary: notice.summary,
    text: notice.text,
    markdown: notice.markdown,
    body: notice.text,
    link: notice.link,
    facts: notice.facts,
    at: new Date(notice.at).toISOString(),
  };
}

/**
 * Content the test endpoint sends. Same renderer as a live notice, so "send
 * test" shows the real card layout instead of a message that never occurs.
 */
export function createSampleNotice({ link = '', at = Date.now() } = {}) {
  return createNotice({
    variant: 'done',
    sessionId: 'sample',
    sessionTitle: '示例会话 · 修复登录接口',
    task: '修一下登录过期后自动重登，顺手补个测试',
    result: '已修复 token 刷新逻辑：401 后先静默刷新再重放请求，并补了 3 个用例，`npm test` 全绿。',
    facts: {
      workspace: 'workspace',
      workspacePath: '/path/to/workspace',
      durationMs: 133000,
      turn: 3,
      steps: 7,
      tools: 12,
      tokens: 8923,
      model: 'deepseek-v4-flash',
    },
    link,
    at,
  });
}
