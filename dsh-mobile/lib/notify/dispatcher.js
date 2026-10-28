/**
 * Host-side notification dispatcher.
 *
 * A notification is emitted for one and only one situation: a *root* session's
 * turn finished on its own (completed / error / max-tokens) and the agent has no
 * follow-up turn queued. Everything else — aborted turns, blocked pre-steps,
 * crash-orphaned turns, subagent sessions — stays silent.
 *
 * Signals used (all host-side, none of them require a browser):
 *   session/event  'turn/end'  -> the reason and turn number (dsh-session)
 *   agent/status   'idle'      -> the driving loop settled (dsh-agent-loop)
 *   agent/error                -> structured failures worth an immediate alert
 *   approval/request           -> a tool is waiting for the human (waterfall)
 *   user-questions/request     -> ask_user_question is waiting (waterfall, agent scoped)
 *
 * Content is composed from the session event stream itself (prompt, last answer,
 * tool count, model, tokens) so a message says what was asked and what came out
 * of it, not just that something happened. Composition happens at `turn/end`,
 * before the debounce timer, because the browser half reads the same notice from
 * `/api/dsh-mobile/notice` to feed its own webhook.
 */

import { activeChannels, redact } from './config.js';
import { deliver, describeTarget } from './channels.js';
import {
  clip,
  createNotice,
  createSampleNotice,
  failureText,
  oneLine,
  workspaceName,
} from './compose.js';

export { clip };

const NOTICE_TTL_MS = 10 * 60 * 1000;
const NOTICE_MAX = 100;

/** Turn reasons that never become a notification. */
const SILENT_REASONS = new Set(['aborted', 'blocked', 'interrupted', 'forked']);

/** `notify.events` value for a turn-end reason; `''` means stay silent. */
function deliverableKind(reason) {
  if (reason === 'completed' || reason === 'max-tokens') return 'done';
  if (reason === 'error') return 'error';
  return '';
}

/** Presentation variant for a turn-end reason (`done` / `max-tokens` / `error` / silent ones). */
function variantOf(reason) {
  if (reason === 'completed') return 'done';
  if (reason === 'max-tokens' || reason === 'error') return reason;
  if (SILENT_REASONS.has(reason)) return reason;
  return 'done';
}

/** Visible text of a message's content blocks. */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function createDispatcher({ ctx, logger, getConfig, feed, log }) {
  const turns = new Map(); // sessionId -> { turn, reason, error, draft, notice }
  const drafts = new Map(); // sessionId -> in-flight turn content
  const notices = new Map(); // sessionId -> last composed notice (browser path reads this)
  const runningSince = new Map(); // sessionId -> epoch ms
  const timers = new Map(); // sessionId -> timeout handle
  const sent = new Map(); // dedupe key -> epoch ms
  // `${sessionId}:${kind}` -> epoch ms. Per kind on purpose: an `auto` notice
  // (or an `ask`) must not start the window that suppresses the completion that
  // follows it, and a `done` must not suppress the `ask` of the next turn.
  const lastSentAt = new Map();
  const recentSends = []; // epoch ms, for the global token bucket
  const sentErrors = new Map(); // sessionId:turn -> epoch ms
  const askSentAt = new Map(); // sessionId -> epoch ms
  const disposers = [];
  let disposed = false;

  const now = () => Date.now();

  const remember = (map, key, at, ttl) => {
    map.set(key, at);
    for (const [other, stamp] of map) {
      if (at - stamp > ttl) map.delete(other);
    }
  };

  const isDuplicate = (key, ttl = 60000) => {
    const stamp = sent.get(key);
    if (stamp !== undefined && now() - stamp < ttl) return true;
    return false;
  };

  const overRateLimit = () => {
    const cutoff = now() - 60000;
    while (recentSends.length > 0 && recentSends[0] < cutoff) recentSends.shift();
    return recentSends.length >= getConfig().maxPerMinute;
  };

  const linkFor = (sessionId) => {
    const baseUrl = String(getConfig().baseUrl ?? '').replace(/\/+$/, '');
    return baseUrl && sessionId ? `${baseUrl}/#session=${encodeURIComponent(sessionId)}` : '';
  };

  const pruneNotices = () => {
    const cutoff = now() - NOTICE_TTL_MS;
    for (const [sessionId, notice] of notices) {
      if (notice.at < cutoff) notices.delete(sessionId);
    }
    while (notices.size > NOTICE_MAX) notices.delete(notices.keys().next().value);
  };

  /** Remember the last notice for a session; served to the browser half. */
  const rememberNotice = (notice) => {
    if (!notice?.sessionId || notice.sessionId === 'sample') return;
    notices.set(notice.sessionId, notice);
    pruneNotices();
  };

  /** Everything a message needs, computed from the session alone. */
  const contextForSession = (session) => {
    const header = session?.header;
    const sessionId = header?.id ?? session?.id ?? '';
    let title = '';
    try {
      title = ctx.get('sessionTitle')?.get(session)?.title ?? '';
    } catch {
      title = '';
    }
    return {
      sessionId,
      title: oneLine(title) || `会话 ${String(sessionId).slice(0, 8)}`,
      workspace: workspaceName(header?.cwd),
      workspacePath: header?.cwd ?? '',
      isSubagent: header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0,
      startedAt: runningSince.get(sessionId),
    };
  };

  const contextFor = (agent) => contextForSession(agent?.session);

  const factsFor = (info, draft, turn) => ({
    workspace: info.workspace,
    workspacePath: info.workspacePath,
    durationMs: Math.max(0, now() - (draft?.startedAt ?? info.startedAt ?? now())),
    turn: Number.isFinite(turn) ? turn : draft?.turn,
    steps: draft?.steps,
    tools: draft?.tools,
    tokens: draft?.tokens,
    model: draft?.model,
  });

  /** Reset or lazily create the in-flight turn content for a session. */
  const ensureDraft = (sessionId, turn) => {
    let draft = drafts.get(sessionId);
    if (!draft) {
      draft = {
        turn: Number.isFinite(turn) ? turn : 0,
        startedAt: now(),
        prompt: '',
        result: '',
        steps: 0,
        tools: 0,
        model: '',
        tokens: 0,
      };
      drafts.set(sessionId, draft);
    } else if (Number.isFinite(turn) && turn > draft.turn) {
      draft.turn = turn;
    }
    return draft;
  };

  const pushFeed = (notice) => {
    try {
      feed.push({
        kind: notice.kind,
        sessionId: notice.sessionId,
        title: notice.title,
        summary: notice.summary,
        body: notice.toast || notice.text,
        link: notice.link,
      });
    } catch (error) {
      logger?.warn?.(`[dsh-mobile] feed 写入失败：${error?.message ?? error}`);
    }
  };

  const safeTarget = (name, channel) => {
    try {
      return describeTarget(name, channel);
    } catch {
      return name;
    }
  };

  const send = async (kind, notice, source) => {
    const config = getConfig();
    if (!config.enabled) return { delivered: 0, skipped: 'disabled' };
    const { ready, missing } = activeChannels(config);
    for (const gap of missing) {
      logger?.warn?.(`[dsh-mobile] 渠道 ${gap.name} 已启用但缺少 ${gap.missing.join('/')}，已跳过`);
    }

    pushFeed(notice);
    remember(lastSentAt, `${notice.sessionId}:${kind}`, now(), 600000);

    if (ready.length === 0) {
      log(`skip(no-channel) ${source} ${kind} ${notice.sessionId}`);
      return { delivered: 0, skipped: 'no-channel' };
    }

    const results = await Promise.allSettled(
      ready.map(async (name) => {
        const result = await deliver(name, config.channels[name], notice);
        const target = safeTarget(name, config.channels[name]);
        log(`${result.ok ? 'ok' : 'fail'} ${name} ${target} ${kind} ${notice.sessionId} :: ${result.detail}`);
        if (!result.ok) logger?.warn?.(`[dsh-mobile] ${name} 推送失败：${result.detail}`);
        return { name, ...result };
      }),
    );

    const delivered = results.filter((item) => item.status === 'fulfilled' && item.value.ok).length;
    if (delivered > 0) recentSends.push(now());
    return {
      delivered,
      results: results.map((item) => (item.status === 'fulfilled' ? item.value : { ok: false, detail: String(item.reason) })),
    };
  };

  /** Gate shared by every trigger: enabled, event kind allowed, not a subagent. */
  const allowed = (kind, info) => {
    const config = getConfig();
    if (!config.enabled) return 'disabled';
    // An auto-answered step is the tail of the same "waiting for you" story, so
    // it follows the `ask` switch instead of needing one of its own.
    if (!config.events.includes(kind === 'auto' ? 'ask' : kind)) return 'event-off';
    if (info.isSubagent) return 'subagent';
    if (!info.sessionId) return 'no-session';
    return '';
  };

  /** Gate, throttle and deliver a notice that was already composed. */
  const sendNotice = async (kind, info, notice, options = {}) => {
    const reason = allowed(kind, info);
    if (reason) {
      log(`skip(${reason}) ${kind} ${info.sessionId || '?'}`);
      return { delivered: 0, skipped: reason };
    }
    rememberNotice(notice);
    const last = lastSentAt.get(`${info.sessionId}:${kind}`);
    if (!options.bypassThrottle && last !== undefined && now() - last < getConfig().minSessionIntervalMs) {
      log(`skip(throttle) ${kind} ${info.sessionId}`);
      return { delivered: 0, skipped: 'throttle' };
    }
    if (overRateLimit()) {
      log(`skip(rate-limit) ${kind} ${info.sessionId}`);
      return { delivered: 0, skipped: 'rate-limit' };
    }
    return send(kind, notice, options.source ?? kind);
  };

  /** Compose and send in one step (immediate paths: error, ask, auto). */
  const notifyNow = (variant, agent, parts, options = {}) => {
    const info = contextFor(agent);
    if (!info.sessionId) return Promise.resolve({ delivered: 0, skipped: 'no-session' });
    const draft = drafts.get(info.sessionId);
    const notice = createNotice({
      variant,
      sessionId: info.sessionId,
      sessionTitle: info.title,
      task: parts.task ?? draft?.prompt ?? '',
      result: parts.result ?? draft?.result ?? '',
      error: parts.error,
      waitText: parts.waitText,
      waitReason: parts.waitReason,
      waitOptions: parts.waitOptions,
      handled: parts.handled,
      detail: parts.detail,
      facts: factsFor(info, draft, draft?.turn),
      link: linkFor(info.sessionId),
    });
    const kind = notice.kind || variant;
    return sendNotice(kind, info, notice, options);
  };

  /**
   * Tell the human what the watchdog just decided.
   *
   * Bypasses the ask throttle on purpose: the earlier "waiting for you" message
   * and this "answered for you" message describe the same stuck step, and the
   * second one is the one that says the turn is moving again.
   */
  const notifyText = (agent, extra) => {
    if (disposed || !agent) return;
    notifyNow('auto', agent, { handled: extra }, { bypassThrottle: true }).catch(() => {});
  };

  const cancelTimer = (sessionId) => {
    const handle = timers.get(sessionId);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(sessionId);
    }
  };

  const onSessionEvent = (session, event) => {
    if (!event) return;
    const sessionId = session?.header?.id ?? session?.id;
    if (!sessionId) return;
    if (disposed) return;
    const info = contextForSession(session);
    if (info.isSubagent) return; // subagent content never reaches a message

    const data = event.data ?? {};
    switch (event.type) {
      case 'turn/start': {
        drafts.set(sessionId, {
          turn: Number.isFinite(data.turn) ? data.turn : 0,
          startedAt: now(),
          prompt: '',
          result: '',
          steps: 0,
          tools: 0,
          model: '',
          tokens: 0,
        });
        return;
      }
      case 'user/message': {
        const draft = ensureDraft(sessionId, data.turn);
        // Only a direct human prompt is "the task"; injected context (AGENTS.md,
        // runtime context, goal rounds, relayed messages) is skipped.
        if (!draft.prompt && data.source?.kind === 'user') draft.prompt = oneLine(textOf(data.content));
        return;
      }
      case 'assistant/message': {
        const draft = ensureDraft(sessionId, data.turn);
        const text = textOf(data.message?.content);
        if (text) draft.result = text;
        if (data.message?.source?.model) draft.model = data.message.source.model;
        const usage = data.usage;
        if (usage) {
          const total = Number.isFinite(usage.totalTokens)
            ? usage.totalTokens
            : (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
          if (total > 0) draft.tokens += total;
        }
        return;
      }
      case 'tool/call': {
        const draft = ensureDraft(sessionId, data.turn);
        draft.tools += 1;
        return;
      }
      case 'step/end': {
        const draft = ensureDraft(sessionId, data.turn);
        if (Number.isFinite(data.step)) draft.steps = Math.max(draft.steps, data.step);
        return;
      }
      case 'request/header': {
        const draft = ensureDraft(sessionId);
        const model = data.header?.config?.model;
        if (model) draft.model = String(model);
        return;
      }
      case 'turn/end': {
        const draft = ensureDraft(sessionId, data.turn);
        const reason = data.reason?.kind ?? '';
        const turn = Number.isFinite(data.turn) ? data.turn : draft.turn;
        const variant = variantOf(reason);
        const notice = createNotice({
          variant,
          sessionId,
          sessionTitle: info.title,
          task: draft.prompt,
          result: draft.result,
          error: data.reason?.error,
          facts: factsFor(info, draft, turn),
          link: linkFor(sessionId),
        });
        rememberNotice(notice);
        turns.set(sessionId, {
          turn,
          reason,
          error: data.reason?.error,
          draft: { ...draft },
          notice,
        });
        drafts.delete(sessionId);
        return;
      }
      default:
        return;
    }
  };

  const onAgentStatus = ({ agent, status }) => {
    if (disposed || !agent) return;
    const sessionId = agent.session?.header?.id ?? agent.session?.id;
    if (!sessionId) return;

    if (status === 'running') {
      cancelTimer(sessionId);
      if (!runningSince.has(sessionId)) runningSince.set(sessionId, now());
      return;
    }
    if (status !== 'idle') return;
    runningSince.delete(sessionId);

    cancelTimer(sessionId);
    const handle = setTimeout(() => {
      timers.delete(sessionId);
      if (disposed) return;
      if (agent.status !== 'idle') return; // a follow-up turn claimed the agent
      const record = turns.get(sessionId);
      if (!record) return;
      const kind = deliverableKind(record.reason);
      if (!kind) {
        log(`skip(reason:${record.reason || 'unknown'}) ${sessionId}`);
        return;
      }
      const key = `${sessionId}:${record.turn}`;
      if (isDuplicate(`turn:${key}`)) return;
      remember(sent, `turn:${key}`, now(), 120000);

      const info = contextFor(agent);
      const notice = record.notice ?? createNotice({
        variant: variantOf(record.reason),
        sessionId,
        sessionTitle: info.title,
        task: record.draft?.prompt ?? '',
        result: record.draft?.result ?? '',
        error: record.error,
        facts: factsFor(info, record.draft, record.turn),
        link: linkFor(sessionId),
      });
      sendNotice(kind, info, notice, { source: kind }).catch((error) => {
        logger?.warn?.(`[dsh-mobile] 通知调度失败：${error?.message ?? error}`);
      });
    }, getConfig().debounceMs);
    if (typeof handle?.unref === 'function') handle.unref();
    timers.set(sessionId, handle);
  };

  const onAgentError = ({ agent, turn, error }) => {
    if (disposed || !agent) return;
    const sessionId = agent.session?.header?.id ?? agent.session?.id;
    if (!sessionId) return;
    const key = `${sessionId}:${turn ?? 0}`;
    if (sentErrors.has(key) && now() - sentErrors.get(key) < 120000) return;
    remember(sentErrors, key, now(), 120000);
    // The turn-end handler sends the richer message; this is the immediate path
    // for failures the loop reports before the turn closes.
    notifyNow('error', agent, { error }, { source: 'error' }).catch(() => {});
  };

  const notifyAsk = (agent, waitText, waitReason, waitOptions) => {
    if (disposed || !agent) return;
    const sessionId = agent.session?.header?.id ?? agent.session?.id;
    if (!sessionId) return;
    const last = askSentAt.get(sessionId);
    if (last !== undefined && now() - last < getConfig().askRepeatMs) return;
    remember(askSentAt, sessionId, now(), getConfig().askRepeatMs * 2);
    notifyNow('ask', agent, { waitText, waitReason, waitOptions }, { source: 'ask' }).catch(() => {});
  };

  /**
   * Race a pending human question against the configured wait.
   *
   * `running` stays true while a step waits for the human, so an unanswered
   * approval or question parks the turn forever. When enabled, the timer settles
   * it with the panel's recommended action; otherwise `work` is returned as is.
   * The timeout value is always a legal outcome, so a late answer cannot corrupt
   * the waterfall.
   *
   * `work` is the downstream chain (the web forwarder that asks the browser). A
   * human answering first resolves it and cancels the timer, so exactly one
   * answer is ever produced.
   */
  const withAutoAnswer = (work, onTimeout, label) => {
    const config = getConfig();
    if (!config.askAutoAnswer) return work;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          const value = onTimeout();
          log(`auto ${label} ${JSON.stringify(value)}`);
          resolve(value);
        } catch (error) {
          log(`auto ${label} failed ${error?.message ?? error}`);
          reject(error);
        }
      }, config.askTimeoutMs);
      timer?.unref?.();
      Promise.resolve(work).then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
        }
        reject(error);
      });
    });
  };

  const onApproval = (request, next) => {
    try {
      const tool = request?.toolName ? `工具 ${request.toolName} 需要授权` : '需要你确认一个操作';
      notifyAsk(request?.agent, tool, request?.reason);
    } catch {
      // Never disturb the approval waterfall.
    }
    const config = getConfig();
    // `none` is the documented "never decide for me" value: leave this request
    // to the browser, exactly like `askAutoAnswer: false`. Without this branch
    // the fallthrough below turned it into an allow-once — the opposite of the
    // configured intent, and only reachable through the settings file or route.
    if (!config.askAutoAnswer || config.approvalAutoAction === 'none') return next();
    // Only the explicit opt-in may allow; every other value (including one that
    // slipped past normalization) falls back to the fail-safe rejection.
    const action = config.approvalAutoAction === 'allowed-once' ? 'allowed-once' : 'rejected';
    return withAutoAnswer(
      next(),
      () => {
        notifyText(request?.agent, `超时未应答，已自动${action === 'rejected' ? '拒绝' : '允许一次'}`);
        return action;
      },
      `approval ${action}`,
    );
  };

  const onUserQuestion = (request, next) => {
    try {
      const first = Array.isArray(request?.questions) ? request.questions[0] : undefined;
      const header = oneLine(first?.header);
      const question = oneLine(first?.question);
      const options = Array.isArray(first?.options) ? first.options.map((option) => option?.label ?? option?.value ?? '') : [];
      notifyAsk(
        request?.agent,
        header || '需要你回答一个问题',
        header && question && question !== header ? question : undefined,
        options.filter(Boolean),
      );
    } catch {
      // Never disturb the questions waterfall.
    }
    const config = getConfig();
    // `none` ("不回答") means the timeout must not answer: the question stays
    // with the browser, exactly like `askAutoAnswer: false`.
    if (!config.askAutoAnswer || config.questionAutoPick === 'none') return next();
    return withAutoAnswer(
      next(),
      () => {
        const questions = Array.isArray(request?.questions) ? request.questions : [];
        const answers = questions.map((question) => {
          const options = Array.isArray(question?.options) ? question.options : [];
          const preferred = question?.intent?.approve ?? options[0]?.label;
          return { id: question?.id, selected: preferred ? [preferred] : [] };
        });
        const picked = answers.map((answer) => answer.selected[0]).filter(Boolean).join('、');
        notifyText(request?.agent, `超时未应答，已自动选择：${picked || '（无选项）'}`);
        return { answers };
      },
      'question',
    );
  };

  const sampleNotice = () => createSampleNotice({ link: String(getConfig().baseUrl ?? '').replace(/\/+$/, '') });

  return {
    attach() {
      disposers.push(ctx.on('session/event', onSessionEvent));
      disposers.push(ctx.on('agent/status', onAgentStatus));
      disposers.push(ctx.on('agent/error', onAgentError));
      // Both interactions are waterfalls whose downstream is the web forwarder
      // (`dsh-api-remotes`) that asks the open browser. Registered plainly we
      // sit *inside* that forwarder, so with every browser closed `next()` is
      // never called, the timer below never starts, and the turn hangs forever.
      // Prepended we run outside it: `next()` still fires the forwarder, but our
      // timer now races the (possibly infinite) browser wait.
      disposers.push(ctx.on('approval/request', onApproval, { prepend: true }));
      disposers.push(ctx.on('user-questions/request', onUserQuestion, { prepend: true }));
      return () => {
        disposed = true;
        for (const sessionId of [...timers.keys()]) cancelTimer(sessionId);
        for (const dispose of disposers.splice(0)) {
          try {
            dispose?.();
          } catch {
            // Detach is best effort.
          }
        }
      };
    },

    /**
     * The last notice composed for a session, or `null`.
     *
     * Served read-only to the browser half so its own webhook carries the same
     * task/result/button content the host path would send.
     */
    noticeFor(sessionId) {
      pruneNotices();
      return notices.get(String(sessionId ?? '')) ?? null;
    },

    sampleNotice,

    /** Send one message right now (test endpoint). Bypasses dedupe, keeps the rate gate. */
    async test(channelNames) {
      const config = getConfig();
      const notice = sampleNotice();
      const target = channelNames ?? activeChannels(config).ready;
      if (target.length === 0) return { ok: false, detail: '没有已启用的渠道', results: [] };
      const results = [];
      for (const name of target) {
        const channel = config.channels[name];
        const result = await deliver(name, channel, notice);
        const detail = `${result.ok ? 'ok' : 'fail'} ${name} ${safeTarget(name, channel)} :: ${result.detail}`;
        log(`test ${detail}`);
        results.push({ channel: name, ...result });
      }
      pushFeed(notice);
      return { ok: results.every((item) => item.ok), results };
    },

    /** Redacted snapshot for the meta endpoint and logs. */
    summary() {
      const config = getConfig();
      return {
        enabled: config.enabled,
        events: config.events,
        baseUrl: config.baseUrl,
        channels: Object.fromEntries(
          Object.entries(config.channels).map(([name, channel]) => [
            name,
            {
              enabled: Boolean(channel?.enabled),
              target: safeTarget(name, channel),
              detail: redact(channel?.webhook || channel?.botToken || channel?.sendKey || channel?.topic || channel?.url || ''),
            },
          ]),
        ),
      };
    },
  };
}
