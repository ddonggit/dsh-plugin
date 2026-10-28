/**
 * dsh-mobile: the "任务通知" settings section.
 *
 * Loaded on demand (see settingsSection in the entry) because it is only needed
 * once the user opens Settings. Values live in localStorage — the host half
 * only reloads its own copy on a restart — so this page must work without it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  chunk: 'client.settings.js',

  factory(require) {
    const React = require('react');

/** Notification API handed over by the entry (built in client.notify.js). */
let api = null;

/**
 * Entry-owned platform facts: live context, chunk table, sidebar, the header
 * menu button's registration, the forensics recorder (read-only) and the two
 * lazy chunk loaders.
 */
let platform = null;

function install(provided, extra) {
  api = provided;
  platform = extra;
}

// Thin delegates so the page below reads exactly like it did when everything
// lived in one file; the owner of each function is client.notify.js.
function readSettings() { return api.readSettings(); }
function writeSettings(patch) { return api.writeSettings(patch); }
function subscribeSettings(listener) { return api.subscribeSettings(listener); }
function pushWebhook(message) { return api.pushWebhook(message); }
function fallbackNotice(...args) { return api.fallbackNotice(...args); }
function probeSecurePort() { return api.probeSecurePort(); }
function secureUrlFor(port) { return api.secureUrlFor(port); }
function notificationState() { return api.notificationState(); }
function fetchSampleNotice() { return api.fetchSampleNotice(); }

/** One labelled checkbox row. */
function SettingCheck(props) {
  return React.createElement(
    'label',
    { className: 'dshm-check' },
    React.createElement('input', {
      type: 'checkbox',
      checked: props.checked,
      onChange: (event) => props.onChange(event.target.checked),
    }),
    React.createElement('span', null, props.label),
  );
}

/** One labelled `<select>` row. */
function SettingSelect(props) {
  return React.createElement(
    'div',
    { className: 'dshm-row' },
    React.createElement('span', { className: 'dshm-rowLabel' }, props.label),
    React.createElement(
      'select',
      {
        className: 'dshm-select',
        value: props.value,
        onChange: (event) => props.onChange(event.target.value),
      },
      props.options.map((option) =>
        React.createElement('option', { key: option.value, value: option.value }, option.label),
      ),
    ),
  );
}

/**
 * Host-side auto-answer: the settings that live in the host process.
 *
 * This is the only auto-answer mechanism: it runs in the host dispatcher, so it
 * also works when every browser is closed and the phone is locked. Default off,
 * because it decides on the user's behalf.
 */
const HOST_TIMEOUT_MIN_SEC = 15;
const HOST_TIMEOUT_MAX_SEC = 86400;

async function hostSettingsRequest(method, body) {
  const init = { method, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch('/api/dsh-mobile/host-settings', init);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error ? String(payload.error) : `HTTP ${response.status}`);
  }
  return payload;
}

function makeHostAutoCard(t) {
  return function HostAutoAnswerSection() {
    const [state, setState] = React.useState({ status: 'loading', values: null, error: '', busy: false, notice: '' });

    React.useEffect(() => {
      let live = true;
      hostSettingsRequest('GET')
        .then((payload) => {
          if (live) setState({ status: 'ready', values: payload.settings, error: '', busy: false, notice: '' });
        })
        .catch((error) => {
          if (live) {
            setState({ status: 'unavailable', values: null, error: String(error?.message ?? error), busy: false, notice: '' });
          }
        });
      return () => {
        live = false;
      };
    }, []);

    const patch = (next) =>
      setState((previous) => ({ ...previous, values: { ...previous.values, ...next }, notice: '' }));

    const save = () => {
      const values = state.values;
      if (!values) return;
      const seconds = Math.min(
        HOST_TIMEOUT_MAX_SEC,
        Math.max(HOST_TIMEOUT_MIN_SEC, Math.trunc(Number(values.askTimeoutMs) / 1000) || 120),
      );
      setState((previous) => ({ ...previous, busy: true, notice: '' }));
      hostSettingsRequest('POST', {
        askAutoAnswer: values.askAutoAnswer === true,
        askTimeoutMs: seconds * 1000,
        approvalAutoAction: values.approvalAutoAction === 'allowed-once' ? 'allowed-once' : 'rejected',
        questionAutoPick: values.questionAutoPick === 'none' ? 'none' : 'first',
      })
        .then((payload) => setState({ status: 'ready', values: payload.settings, error: '', busy: false, notice: t('hSaved') }))
        .catch((error) =>
          setState((previous) => ({ ...previous, busy: false, error: String(error?.message ?? error), notice: t('hFailed') })),
        );
    };

    if (state.status === 'loading') {
      return React.createElement(
        'div',
        { className: 'dshm-card' },
        React.createElement('div', { className: 'dshm-cardHead' }, t('hTitle')),
        React.createElement('div', { className: 'dshm-rowHint' }, t('hLoading')),
      );
    }

    if (state.status === 'unavailable') {
      return React.createElement(
        'div',
        { className: 'dshm-card' },
        React.createElement('div', { className: 'dshm-cardHead' }, t('hTitle')),
        React.createElement('div', { className: 'dshm-rowHint' }, t('hHint')),
        React.createElement('div', { className: 'dshm-note dshm-bad' }, `${t('hUnavailable')}：${state.error}`),
      );
    }

    const values = state.values;
    return React.createElement(
      'div',
      { className: 'dshm-card' },
      React.createElement('div', { className: 'dshm-cardHead' }, t('hTitle')),
      React.createElement('div', { className: 'dshm-rowHint' }, t('hHint')),
      React.createElement(SettingCheck, {
        checked: values.askAutoAnswer === true,
        label: t('hEnable'),
        onChange: (value) => patch({ askAutoAnswer: value }),
      }),
      React.createElement(
        'div',
        { className: 'dshm-row' },
        React.createElement('span', { className: 'dshm-rowLabel' }, t('sTimeout')),
        React.createElement('input', {
          className: 'dshm-input dshm-inputSmall',
          type: 'number',
          min: HOST_TIMEOUT_MIN_SEC,
          max: HOST_TIMEOUT_MAX_SEC,
          step: 15,
          value: Math.round((Number(values.askTimeoutMs) || 120000) / 1000),
          onChange: (event) => {
            const seconds = Math.max(1, Math.trunc(Number(event.target.value)) || 120);
            patch({ askTimeoutMs: seconds * 1000 });
          },
        }),
        React.createElement('span', { className: 'dshm-note' }, t('sec')),
      ),
      React.createElement(SettingSelect, {
        label: t('sApproval'),
        value: values.approvalAutoAction,
        options: [
          { value: 'allowed-once', label: t('sApproveOnce') },
          { value: 'rejected', label: t('sReject') },
        ],
        onChange: (value) => patch({ approvalAutoAction: value }),
      }),
      React.createElement(SettingSelect, {
        label: t('sQuestion'),
        value: values.questionAutoPick,
        options: [
          { value: 'first', label: t('sFirst') },
          { value: 'none', label: t('sNothing') },
        ],
        onChange: (value) => patch({ questionAutoPick: value }),
      }),
      React.createElement(
        'div',
        { className: 'dshm-row' },
        React.createElement(
          'button',
          { type: 'button', className: 'dshm-btn dshm-btnPrimary', disabled: state.busy, onClick: save },
          state.busy ? t('hSaving') : t('hSave'),
        ),
        state.notice ? React.createElement('span', { className: 'dshm-note dshm-ok' }, state.notice) : null,
        state.error ? React.createElement('span', { className: 'dshm-note dshm-bad' }, state.error) : null,
      ),
    );
  };
}

/**
 * Diagnostics card: read-only, one tap to copy.
 *
 * The report itself is a separate chunk (client.diagnostics.js) loaded on the
 * first click, so troubleshooting code never joins the boot path.
 */
function makeDiagnosticsCard(t) {
  return function DiagnosticsSection() {
    const [Panel, setPanel] = React.useState(null);
    const [error, setError] = React.useState('');

    const open = () => {
      if (!platform?.loadDiagnostics) {
        setError('entry did not provide the diagnostics loader');
        return;
      }
      setError('');
      platform
        .loadDiagnostics()
        .then((module) => {
          if (!module) {
            const failed = platform.chunkStatus?.get('diagnostics');
            setError(`diagnostics chunk failed to load: ${failed?.error ?? 'unknown'}`);
            return;
          }
          setPanel(() =>
            module.createPanel({
              ctx: platform.ctx,
              chunkStatus: platform.chunkStatus,
              sidebar: platform.sidebar,
              menu: platform.menu,
              forensics: platform.forensics,
              resourceCompat: platform.resourceCompat,
              api,
              t,
            }),
          );
        })
        .catch((caught) => setError(`diagnostics failed: ${String(caught?.message ?? caught)}`));
    };

    return React.createElement(
      'div',
      { className: 'dshm-card' },
      React.createElement('div', { className: 'dshm-cardHead' }, t('dTitle')),
      React.createElement('div', { className: 'dshm-rowHint' }, t('dHint')),
      Panel
        ? React.createElement(Panel)
        : React.createElement(
            'div',
            { className: 'dshm-row' },
            React.createElement('button', { type: 'button', className: 'dshm-btn', onClick: open }, t('dOpen')),
            error ? React.createElement('span', { className: 'dshm-note dshm-bad' }, error) : null,
          ),
    );
  };
}

/**
 * Settings page: everything the notification path needs in one place.
 *
 * Values live in localStorage (see {@link readSettings}) because the host half
 * only loads on a restart; the page therefore has to work without it.
 */
function makeSettingsPage(t) {
  const DiagnosticsSection = makeDiagnosticsCard(t);
  const HostAutoSection = makeHostAutoCard(t);
  return function NotifySettings() {
    const [settings, setSettings] = React.useState(readSettings);
    const [hostNote, setHostNote] = React.useState('');
    const [probe, setProbe] = React.useState({ sending: false, text: '', ok: null });

    React.useEffect(() => {
      setSettings(readSettings());
      // Opening the page is the second sync point (the first is startup): the
      // host may have been changed from the other device since.
      let live = true;
      api.syncHostSettings().then(() => {
        if (live) setSettings(readSettings());
      });
      const unsubscribe = subscribeSettings(setSettings);
      return () => {
        live = false;
        unsubscribe();
      };
    }, []);

    const patch = (next) => {
      setHostNote('');
      writeSettings(next).then((result) => {
        if (!result.ok) setHostNote(`${t('hFailed')}：${result.error}`);
      });
      setSettings(readSettings());
    };

    /**
     * Webhook edits carry the computed dialect, so writing the whole object back
     * would freeze an inferred kind into storage. Only the raw choice is stored.
     */
    const patchWebhook = (next) =>
      patch({
        webhook: {
          enabled: next.enabled ?? settings.webhook.enabled,
          kind: next.kind ?? settings.webhook.kindChoice,
          url: next.url ?? settings.webhook.url,
        },
      });

    const permission = notificationState();
    const permissionText =
      permission === 'granted'
        ? t('sPermOk')
        : permission === 'denied'
          ? t('sPermNo')
          : permission === 'unsupported'
            ? ''
            : t('sPermAsk');

    const sendTest = async () => {
      setProbe({ sending: true, text: '', ok: null });
      // The sample comes from the host composer, so the test shows exactly what
      // a real completion looks like (card included) instead of a bare title.
      let notice = await fetchSampleNotice();
      if (!notice) {
        notice = fallbackNotice('done', { displayTitle: t('sSampleTitle'), workspace: t('sSampleWorkspace'), durationMs: 83000 }, 'test', t);
        // Keep the acknowledgement readable on a phone lock screen.
        notice.text = [notice.title, t('sTestOk'), notice.summary].filter(Boolean).join('\n');
      }
      const result = await pushWebhook(notice);
      setProbe({
        sending: false,
        text: result.ok ? t('sTestOk') : `${t('sTestFail')}：${result.detail}`,
        ok: result.ok,
      });
    };

    return React.createElement(
      'div',
      { className: 'dshm-page' },
      React.createElement(
        'div',
        { className: 'dshm-head' },
        React.createElement('div', { className: 'dshm-title' }, t('sTitle')),
        React.createElement('div', { className: 'dshm-desc' }, t('sDesc')),
      ),

      React.createElement(
        'div',
        { className: 'dshm-card' },
        React.createElement('div', { className: 'dshm-cardHead' }, t('sBrowser')),
        React.createElement(SettingCheck, {
          checked: settings.browser,
          label: t('enable'),
          onChange: (value) => patch({ browser: value }),
        }),
        React.createElement(SettingCheck, {
          checked: settings.done,
          label: t('sDone'),
          onChange: (value) => patch({ done: value }),
        }),
        React.createElement(SettingCheck, {
          checked: settings.ask,
          label: t('sAsk'),
          onChange: (value) => patch({ ask: value }),
        }),
        permissionText
          ? React.createElement(
              'div',
              { className: 'dshm-row' },
              React.createElement('span', { className: 'dshm-rowLabel' }, t('sPerm')),
              React.createElement(
                'span',
                { className: permission === 'granted' ? 'dshm-note dshm-ok' : 'dshm-note' },
                permissionText,
              ),
            )
          : null,
        permission === 'insecure'
          ? React.createElement(
              'div',
              { className: 'dshm-row' },
              React.createElement('span', { className: 'dshm-rowHint' }, t('sSecureHint')),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dshm-btn',
                  onClick: async () => {
                    const port = await probeSecurePort();
                    const url = secureUrlFor(port);
                    if (url) window.location.href = url;
                  },
                },
                t('sGo'),
              ),
            )
          : null,
        hostNote ? React.createElement('div', { className: 'dshm-note dshm-bad' }, hostNote) : null,
      ),

      React.createElement(HostAutoSection),

      React.createElement(
        'div',
        { className: 'dshm-card' },
        React.createElement('div', { className: 'dshm-cardHead' }, t('sWebhook')),
        React.createElement(SettingCheck, {
          checked: settings.webhook.enabled,
          label: t('sWebhook'),
          onChange: (value) => patchWebhook({ enabled: value }),
        }),
        React.createElement('div', { className: 'dshm-rowHint' }, t('sWebhookHint')),
        React.createElement(SettingSelect, {
          label: t('sKind'),
          value: settings.webhook.kindChoice,
          options: [
            { value: 'auto', label: t('sKindAuto') },
            { value: 'feishu', label: '飞书' },
            { value: 'dingtalk', label: '钉钉' },
            { value: 'serverchan', label: 'Server酱' },
            { value: 'generic', label: 'JSON' },
          ],
          onChange: (value) => patchWebhook({ kind: value }),
        }),
        React.createElement(
          'div',
          { className: 'dshm-row' },
          React.createElement('input', {
            className: 'dshm-input',
            type: 'url',
            inputMode: 'url',
            spellCheck: false,
            placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
            value: settings.webhook.url,
            onChange: (event) => patchWebhook({ url: event.target.value }),
          }),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dshm-btn dshm-btnPrimary',
              disabled: probe.sending || !settings.webhook.url,
              onClick: sendTest,
            },
            t('sTest'),
          ),
        ),
        probe.text
          ? React.createElement('div', { className: probe.ok ? 'dshm-note dshm-ok' : 'dshm-note dshm-bad' }, probe.text)
          : null,
      ),

      React.createElement(DiagnosticsSection),
    );
  };
}

return { install, makeSettingsPage };
  },
});
