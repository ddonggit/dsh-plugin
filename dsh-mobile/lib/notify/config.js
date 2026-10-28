/**
 * Notification config: defaults, normalization and source merging.
 *
 * Two sources, later wins per field:
 *   1. the `notify:` block in cordis.patch.yml (defaults live in this bundle's
 *      own patch file);
 *   2. `$DSH_HOME/dsh-mobile/settings.json` — the only place secrets belong,
 *      kept 0600 and hot-reloaded, so the profile patch is never edited by hand.
 */

export const EVENT_KINDS = ['done', 'error', 'ask'];
export const CHANNEL_NAMES = ['wecom', 'dingtalk', 'feishu', 'telegram', 'ntfy', 'serverchan', 'webhook'];

export const CHANNEL_LABELS = {
  wecom: '企业微信群机器人',
  dingtalk: '钉钉群机器人',
  feishu: '飞书群机器人',
  telegram: 'Telegram Bot',
  ntfy: 'ntfy 主题',
  serverchan: 'Server酱',
  webhook: '通用 Webhook',
};

const CHANNEL_DEFAULTS = {
  wecom: { enabled: false, webhook: '' },
  dingtalk: { enabled: false, webhook: '' },
  feishu: { enabled: false, webhook: '' },
  telegram: { enabled: false, botToken: '', chatId: '' },
  ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', token: '' },
  serverchan: { enabled: false, sendKey: '' },
  webhook: { enabled: false, url: '', headers: {} },
};

/** Approval decisions the timeout may pick on the user's behalf. `none` = never decide. */
export const APPROVAL_ACTIONS = ['rejected', 'allowed-once', 'none'];
/** How a timed-out question picks among its options. `none` = never decide. */
export const QUESTION_PICKS = ['first', 'none'];

export function defaultNotifyConfig() {
  return {
    enabled: true,
    baseUrl: '',
    events: ['done', 'error', 'ask'],
    debounceMs: 1500,
    maxPerMinute: 20,
    minSessionIntervalMs: 10000,
    askRepeatMs: 60000,
    /**
     * Unattended waiting: when nobody answers a pending approval or question
     * within `askTimeoutMs`, settle it with the recommended answer so the turn
     * never stalls. Off by default — it decides on the user's behalf.
     */
    askAutoAnswer: false,
    askTimeoutMs: 120000,
    /** What a timed-out approval settles as. `rejected` is the fail-safe default; `none` never decides. */
    approvalAutoAction: 'rejected',
    /** `first` answers a timed-out question with its first option; `none` never decides. */
    questionAutoPick: 'first',
    channels: structuredClone(CHANNEL_DEFAULTS),
  };
}

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const int = (value, fallback, min, max) => {
  const number = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
};
const trimmedUrl = (value) => str(value).replace(/\/+$/, '');

function pickEvents(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const picked = value.map((item) => str(item).toLowerCase()).filter((item) => EVENT_KINDS.includes(item));
  return picked.length > 0 ? [...new Set(picked)] : [...fallback];
}

function pickHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    const name = str(key);
    if (!name) continue;
    // Strip control characters: header values are written verbatim.
    const text = str(entry).replace(/[\u0000-\u001f\u007f]/g, '');
    if (text) out[name] = text;
  }
  return out;
}

function normalizeChannel(name, raw, base) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  switch (name) {
    case 'wecom':
    case 'dingtalk':
    case 'feishu':
      return { enabled: bool(source.enabled, base.enabled), webhook: trimmedUrl(source.webhook ?? base.webhook) };
    case 'telegram':
      return {
        enabled: bool(source.enabled, base.enabled),
        botToken: str(source.botToken ?? base.botToken),
        chatId: str(source.chatId ?? base.chatId),
      };
    case 'ntfy':
      return {
        enabled: bool(source.enabled, base.enabled),
        server: trimmedUrl(source.server ?? base.server) || 'https://ntfy.sh',
        topic: str(source.topic ?? base.topic),
        token: str(source.token ?? base.token),
      };
    case 'serverchan':
      return { enabled: bool(source.enabled, base.enabled), sendKey: str(source.sendKey ?? base.sendKey) };
    case 'webhook':
      return {
        enabled: bool(source.enabled, base.enabled),
        url: trimmedUrl(source.url ?? base.url),
        headers: source.headers === undefined ? base.headers : pickHeaders(source.headers),
      };
    default:
      return structuredClone(base);
  }
}

function pickOne(value, allowed, fallback) {
  const text = str(value).toLowerCase();
  return allowed.includes(text) ? text : fallback;
}

/** Normalize one `notify:` object, layering it over `base`. */
export function normalizeNotifyConfig(raw, base = defaultNotifyConfig()) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const channels = {};
  for (const name of CHANNEL_NAMES) {
    channels[name] = normalizeChannel(name, source.channels?.[name], base.channels[name]);
  }
  return {
    enabled: bool(source.enabled, base.enabled),
    baseUrl: trimmedUrl(source.baseUrl ?? base.baseUrl),
    events: source.events === undefined ? [...base.events] : pickEvents(source.events, base.events),
    debounceMs: int(source.debounceMs, base.debounceMs, 0, 30000),
    maxPerMinute: int(source.maxPerMinute, base.maxPerMinute, 1, 120),
    minSessionIntervalMs: int(source.minSessionIntervalMs, base.minSessionIntervalMs, 0, 600000),
    askRepeatMs: int(source.askRepeatMs, base.askRepeatMs, 10000, 3600000),
    askAutoAnswer: bool(source.askAutoAnswer, base.askAutoAnswer),
    askTimeoutMs: int(source.askTimeoutMs, base.askTimeoutMs, 15000, 86400000),
    approvalAutoAction: pickOne(source.approvalAutoAction, APPROVAL_ACTIONS, base.approvalAutoAction),
    questionAutoPick: pickOne(source.questionAutoPick, QUESTION_PICKS, base.questionAutoPick),
    channels,
  };
}

/**
 * Extract the notify block from a plugin config. Accepts either the documented
 * `{ notify: {...} }` shape or a bare block (used by settings.json).
 */
export function extractNotify(config) {
  if (!config || typeof config !== 'object') return undefined;
  if (config.notify && typeof config.notify === 'object') return config.notify;
  return config;
}

export function mergeNotifyConfig(pluginConfig, settingsNotify) {
  const defaults = defaultNotifyConfig();
  const fromPatch = normalizeNotifyConfig(extractNotify(pluginConfig), defaults);
  return normalizeNotifyConfig(settingsNotify, fromPatch);
}

/** Channels that are enabled AND fully configured; reports what is missing. */
export function activeChannels(notify) {
  const ready = [];
  const missing = [];
  for (const name of CHANNEL_NAMES) {
    const channel = notify.channels[name];
    if (!channel?.enabled) continue;
    const gaps = [];
    if (name === 'wecom' || name === 'dingtalk' || name === 'feishu') {
      if (!channel.webhook) gaps.push('webhook');
    } else if (name === 'telegram') {
      if (!channel.botToken) gaps.push('botToken');
      if (!channel.chatId) gaps.push('chatId');
    } else if (name === 'ntfy') {
      if (!channel.topic) gaps.push('topic');
    } else if (name === 'serverchan') {
      if (!channel.sendKey) gaps.push('sendKey');
    } else if (name === 'webhook') {
      if (!channel.url) gaps.push('url');
    }
    if (gaps.length > 0) missing.push({ name, missing: gaps });
    else ready.push(name);
  }
  return { ready, missing };
}

/** Mask a secret for logs and API responses: keep the last four characters. */
export function redact(value) {
  const text = str(value);
  if (text.length <= 4) return text ? '****' : '';
  return `****${text.slice(-4)}`;
}
