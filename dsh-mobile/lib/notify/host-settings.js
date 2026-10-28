/**
 * Host-side auto-answer settings.
 *
 * These four fields already drive `withAutoAnswer` in the dispatcher; what was
 * missing was an entry point that does not require editing
 * `$DSH_HOME/dsh-mobile/settings.json` by hand. This module owns that entry
 * point's validation and its one hard rule:
 *
 *   read the existing settings.json -> merge only these four fields -> write it
 *   back.
 *
 * Never write the whole document (`saveSettings` would): settings.json also
 * holds channel webhooks, bot tokens and send keys entered in the UI, and a
 * wholesale write from a browser request would silently drop them.
 */

import { APPROVAL_ACTIONS, QUESTION_PICKS, defaultNotifyConfig, redact } from './config.js';
import { readSettingsDocument, writeRawSettings } from './store.js';

/** The only fields a client may change here. */
export const HOST_SETTING_KEYS = ['askAutoAnswer', 'askTimeoutMs', 'approvalAutoAction', 'questionAutoPick', 'browserSettings'];

/** Browser notification settings, stored next to the four auto-answer fields. */
export const BROWSER_SETTING_KEYS = ['browser', 'done', 'ask', 'webhook'];
export const BROWSER_WEBHOOK_KEYS = ['enabled', 'kind', 'url'];
export const BROWSER_WEBHOOK_KINDS = ['auto', 'feishu', 'dingtalk', 'serverchan', 'generic'];

/** The browser's defaults, identical to `DEFAULT_SETTINGS` in client.notify.js. */
export function browserSettingDefaults() {
  return { browser: true, done: true, ask: true, webhook: { enabled: false, kind: 'feishu', url: '' } };
}

/**
 * Normalise whatever was stored under `notify.browserSettings`.
 *
 * A browser may run ahead of the host (or behind it), so a missing field or a
 * malformed one falls back to its default instead of leaking `undefined` into
 * the settings page. `kind` keeps `auto` here: the browser resolves it from the
 * URL, and the host must not freeze that choice.
 */
export function pickBrowserSettings(source) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const webhook = raw.webhook && typeof raw.webhook === 'object' && !Array.isArray(raw.webhook) ? raw.webhook : {};
  return {
    browser: typeof raw.browser === 'boolean' ? raw.browser : true,
    done: typeof raw.done === 'boolean' ? raw.done : true,
    ask: typeof raw.ask === 'boolean' ? raw.ask : true,
    webhook: {
      enabled: typeof webhook.enabled === 'boolean' ? webhook.enabled : false,
      kind: BROWSER_WEBHOOK_KINDS.includes(webhook.kind) ? webhook.kind : 'feishu',
      url: typeof webhook.url === 'string' ? webhook.url.trim() : '',
    },
  };
}

/**
 * Validate the browser notification block of a patch.
 *
 * Partial on purpose: a client may send one checkbox or only `webhook.url`.
 * Unknown names are rejected so a typo cannot look saved. Error text carries
 * the full path (`browserSettings.webhook.kind`) because that is what the
 * settings page shows.
 */
export function validateBrowserSettingsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'browserSettings must be an object' };
  }
  const unknown = Object.keys(input).filter((key) => !BROWSER_SETTING_KEYS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown field(s): ${unknown.map((key) => `browserSettings.${key}`).join(', ')}` };
  }

  const patch = {};
  for (const key of ['browser', 'done', 'ask']) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'boolean') {
      return { ok: false, error: `browserSettings.${key} must be a boolean` };
    }
    patch[key] = input[key];
  }

  if ('webhook' in input) {
    const webhook = input.webhook;
    if (!webhook || typeof webhook !== 'object' || Array.isArray(webhook)) {
      return { ok: false, error: 'browserSettings.webhook must be an object' };
    }
    const unknownWebhook = Object.keys(webhook).filter((key) => !BROWSER_WEBHOOK_KEYS.includes(key));
    if (unknownWebhook.length > 0) {
      return {
        ok: false,
        error: `unknown field(s): ${unknownWebhook.map((key) => `browserSettings.webhook.${key}`).join(', ')}`,
      };
    }
    const webhookPatch = {};
    if ('enabled' in webhook) {
      if (typeof webhook.enabled !== 'boolean') {
        return { ok: false, error: 'browserSettings.webhook.enabled must be a boolean' };
      }
      webhookPatch.enabled = webhook.enabled;
    }
    if ('kind' in webhook) {
      if (!BROWSER_WEBHOOK_KINDS.includes(webhook.kind)) {
        return {
          ok: false,
          error: `browserSettings.webhook.kind must be one of ${BROWSER_WEBHOOK_KINDS.join(', ')}`,
        };
      }
      webhookPatch.kind = webhook.kind;
    }
    if ('url' in webhook) {
      if (typeof webhook.url !== 'string') {
        return { ok: false, error: 'browserSettings.webhook.url must be a string' };
      }
      webhookPatch.url = webhook.url.trim();
    }
    if (Object.keys(webhookPatch).length > 0) patch.webhook = webhookPatch;
  }

  if (Object.keys(patch).length === 0) return { ok: false, error: 'no browser setting provided' };
  return { ok: true, patch };
}

/** Deep-merge the partial browser block; a shallow spread would drop webhook fields. */
function mergeBrowserSettings(existing, patch) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const next = { ...base };
  for (const key of ['browser', 'done', 'ask']) {
    if (key in patch) next[key] = patch[key];
  }
  if (patch.webhook) {
    const webhook = base.webhook && typeof base.webhook === 'object' && !Array.isArray(base.webhook) ? base.webhook : {};
    next.webhook = { ...webhook, ...patch.webhook };
  }
  return next;
}

/** Wait bounds, in ms: 15s .. 24h (the plan's contract). */
export const HOST_TIMEOUT_MIN_MS = 15_000;
export const HOST_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1000;

/** The patch-merge defaults, taken from the one place that defines them. */
const FALLBACK = defaultNotifyConfig();

/** The four fields as the browser should see them. */
export function pickHostSettings(config) {
  const source = config ?? {};
  return {
    askAutoAnswer: source.askAutoAnswer === true,
    askTimeoutMs: Number.isFinite(source.askTimeoutMs) ? source.askTimeoutMs : FALLBACK.askTimeoutMs,
    approvalAutoAction: APPROVAL_ACTIONS.includes(source.approvalAutoAction)
      ? source.approvalAutoAction
      : FALLBACK.approvalAutoAction,
    questionAutoPick: QUESTION_PICKS.includes(source.questionAutoPick) ? source.questionAutoPick : FALLBACK.questionAutoPick,
  };
}

/** Defaults as they apply when settings.json says nothing. */
export function hostSettingDefaults() {
  return pickHostSettings(defaultNotifyConfig());
}

/**
 * Validate one patch from the browser.
 *
 * Unknown fields are rejected rather than ignored: a typo in a field name must
 * not look like a successful save.
 */
export function validateHostPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const unknown = Object.keys(input).filter((key) => !HOST_SETTING_KEYS.includes(key));
  if (unknown.length > 0) return { ok: false, error: `unknown field(s): ${unknown.join(', ')}` };

  const patch = {};
  if ('askAutoAnswer' in input) {
    if (typeof input.askAutoAnswer !== 'boolean') return { ok: false, error: 'askAutoAnswer must be a boolean' };
    patch.askAutoAnswer = input.askAutoAnswer;
  }
  if ('askTimeoutMs' in input) {
    const value = Number(input.askTimeoutMs);
    if (!Number.isInteger(value) || value < HOST_TIMEOUT_MIN_MS || value > HOST_TIMEOUT_MAX_MS) {
      return {
        ok: false,
        error: `askTimeoutMs must be an integer between ${HOST_TIMEOUT_MIN_MS} and ${HOST_TIMEOUT_MAX_MS}`,
      };
    }
    patch.askTimeoutMs = value;
  }
  if ('approvalAutoAction' in input) {
    if (!APPROVAL_ACTIONS.includes(input.approvalAutoAction)) {
      return { ok: false, error: `approvalAutoAction must be one of ${APPROVAL_ACTIONS.join(', ')}` };
    }
    patch.approvalAutoAction = input.approvalAutoAction;
  }
  if ('questionAutoPick' in input) {
    if (!QUESTION_PICKS.includes(input.questionAutoPick)) {
      return { ok: false, error: `questionAutoPick must be one of ${QUESTION_PICKS.join(', ')}` };
    }
    patch.questionAutoPick = input.questionAutoPick;
  }
  if ('browserSettings' in input) {
    const validated = validateBrowserSettingsPatch(input.browserSettings);
    if (!validated.ok) return validated;
    patch.browserSettings = validated.patch;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'no setting provided' };
  return { ok: true, patch };
}

/**
 * The loggable form of a patch.
 *
 * `browserSettings.webhook.url` is a bearer credential (a Feishu/DingTalk/
 * ServerChan hook URL is the secret), and both log sinks are append-only files
 * that survive the browser session. Mask exactly that field; everything else in
 * a patch is a boolean or an enum the operator needs in the log.
 */
export function redactPatch(patch) {
  if (!patch || typeof patch !== 'object') return patch;
  const copy = structuredClone(patch);
  const webhook = copy.browserSettings?.webhook;
  if (webhook && typeof webhook.url === 'string' && webhook.url !== '') {
    webhook.url = redact(webhook.url);
  }
  return copy;
}

/**
 * Merge a validated patch into settings.json and write it back.
 *
 * Two document shapes are supported, matching `loadSettings`:
 *   { version, notify: {...} }  the shape this plugin writes
 *   { ...flat notify fields }   a legacy bare block
 * The shape found on disk is preserved, and every other key — channels,
 * secrets, baseUrl — is carried over untouched.
 */
export function applyHostPatch(dir, patch, logger) {
  const read = readSettingsDocument(dir);
  if (!read.ok) {
    // Refuse to write: the only way forward would be to replace a document we
    // could not read, which is exactly how channel secrets get lost.
    const error = new Error(read.error);
    error.code = 'settings-unreadable';
    throw error;
  }
  const document = read.document;
  const hasNotify = Boolean(document.notify) && typeof document.notify === 'object' && !Array.isArray(document.notify);
  // A document that carries only `version` is the wrapper shape with an empty
  // notify block, not a legacy bare block; anything else without `notify` is.
  const bare = !hasNotify && Object.keys(document).some((key) => key !== 'version');

  const next = {};
  if (bare) {
    Object.assign(next, document, patch);
    if (patch.browserSettings) {
      next.browserSettings = mergeBrowserSettings(document.browserSettings, patch.browserSettings);
    }
  } else {
    if (document.version !== undefined) next.version = document.version;
    else next.version = 1;
    Object.assign(next, pickNonNotify(document));
    next.notify = { ...(hasNotify ? document.notify : {}), ...patch };
    if (patch.browserSettings) {
      next.notify.browserSettings = mergeBrowserSettings(document.notify?.browserSettings, patch.browserSettings);
    }
  }

  writeRawSettings(dir, next, logger);
  logger?.info?.(`[dsh-mobile] 宿主端自动回答已更新：${JSON.stringify(redactPatch(patch))}`);
  return next;
}

/** Everything in a `{ version, notify }` document except the notify block itself. */
function pickNonNotify(document) {
  const rest = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === 'notify' || key === 'version') continue;
    rest[key] = value;
  }
  return rest;
}
