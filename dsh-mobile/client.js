/**
 * dsh-mobile client half: entry point and registration.
 *
 * The bundle is split into package-local chunks that the client module loader
 * fetches with `require.async('./client.<name>.js')` (the same package-local
 * chunk mechanism other chunked clients use):
 *
 *   client.styles.js    presentation only: notification pill, settings and diagnostics
 *   client.deeplink.js  `#session=` / `?session=` routing
 *   client.notify.js    browser notifications, feed catch-up
 *   client.resource-compat.js  every resource provider under the `undefined` protocol key (Huawei browsers)
 *   client.forensics.js evidence recorder: resource subscriptions, console, preview failures
 *   client.settings.js  the "任务通知" settings section (loaded on demand)
 *
 * A chunk that fails to arrive disables its own feature and leaves the rest of
 * the plugin running; the diagnostics surface reports what failed.
 *
 * Hooks used (all shipped client services):
 *   - ctx.locale      : notification copy, one namespace ("dsh-mobile")
 *   - ctx.slots       : the settings section and the notification overlay
 *   - ctx.sessions    : every session's `running` flag / readiness for deep links
 *   - ctx.uiSession   : pending interaction, for the "waiting for you" notice
 *   - ctx.uiWorkspace : open the session a notification or `?session=` points at
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',

  factory(require) {
    const React = require('react');

/** Package-local chunks, resolved against this bundle's own resource URL. */
const CHUNK = {
  styles: './client.styles.js',
  deeplink: './client.deeplink.js',
  notify: './client.notify.js',
  resourceCompat: './client.resource-compat.js',
  forensics: './client.forensics.js',
  settings: './client.settings.js',
  diagnostics: './client.diagnostics.js',
};

/**
 * Load status per chunk, `{ ok: true }` or `{ ok: false, error }`.
 *
 * The client module loader records import failures for boot-graph rows only, and
 * a package-local chunk is not a row, so a missing file here would otherwise be
 * invisible. The diagnostics page reads this table.
 */
const chunkStatus = new Map();

/**
 * Load one chunk, or report null when it cannot be fetched.
 *
 * Failure is contained on purpose: a broken settings chunk must not cost the
 * notifications, and a broken notification chunk must not cost the deep links.
 */
async function loadChunk(require, name) {
  try {
    const module = await require.async(CHUNK[name]);
    chunkStatus.set(name, { ok: true });
    return module;
  } catch (error) {
    chunkStatus.set(name, { ok: false, error: String(error?.message ?? error) });
    console.error(`[dsh-mobile] chunk ${name} failed to load`, error);
    return null;
  }
}

/** Notification copy, registered through the Client locale service. */
const MESSAGES = {
  en: {
    enable: 'Enable task notifications',
    insecure: 'Notifications need HTTPS — tap to switch',
    kDone: 'Done',
    kFailed: 'Failed',
    kWaiting: 'Waiting',
    kEnded: 'Finished',
    kElapsed: 'in',
    askFallback: 'A step needs your confirmation — tap to open the session',
    sTitle: 'Task notifications',
    sDesc: 'Alert me when a task finishes or blocks on my confirmation. Changes apply immediately.',
    sBrowser: 'Browser notifications',
    sDone: 'Notify when a task finishes',
    sAsk: 'Notify when waiting for my approval or answer',
    sTimeout: 'Wait before auto-answering',
    sApproval: 'Timed-out approval becomes',
    sApproveOnce: 'Allow once (the panel default)',
    sReject: 'Reject (fail-safe)',
    sQuestion: 'Timed-out question picks',
    sFirst: 'The first option',
    sNothing: 'Leave it unanswered',
    sWebhook: 'Backup push webhook',
    sWebhookHint:
      'Posted directly from this browser, so it fires even in the background. It reuses the host-composed message (result, task, workspace, elapsed) and falls back to a one-line summary until the host half is ready. Feishu, DingTalk, ServerChan and generic JSON are supported.',
    sKind: 'Payload',
    sKindAuto: 'Auto-detect from URL',
    sTest: 'Send test',
    sTestOk: 'Test pushed',
    sTestFail: 'Push failed',
    sSampleTitle: 'Fix the login timeout',
    sSampleWorkspace: 'my-app',
    sec: 'seconds',
    sPerm: 'Browser permission',
    sPermAsk: 'Ask',
    sPermOk: 'Granted',
    sPermNo: 'Blocked',
    sSecureHint: 'Notifications require HTTPS. Open the HTTPS entry point to enable them.',
    sGo: 'Open HTTPS',
    dTitle: 'Diagnostics',
    dHint: 'Read-only. Copy the whole report when reporting a problem with previews or notifications.',
    dOpen: 'Collect diagnostics',
    dRefresh: 'Re-run',
    dCopy: 'Copy',
    dCopied: 'Copied',
    dCopyFail: 'Copy failed — select the text and copy it manually',
    dLoading: 'Collecting…',
    hTitle: 'Server-side auto-answer',
    hHint:
      'Runs in the host process, so it settles a blocked turn even when this browser is closed or the phone is locked. This is the only auto-answer mechanism — there is no browser-side copy.',
    hEnable: 'Enable (off by default — when on, it decides in your place)',
    hSave: 'Save to host',
    hSaving: 'Saving…',
    hSaved: 'Saved — effective immediately',
    hFailed: 'Save failed',
    hUnavailable: 'Host half not available',
    hLoading: 'Reading host settings…',
  },
  zh: {
    enable: '开启任务完成通知',
    insecure: '通知需要 HTTPS，点此切换',
    kDone: '完成',
    kFailed: '失败',
    kWaiting: '待确认',
    kEnded: '已结束',
    kElapsed: '用时',
    askFallback: '有步骤需要你确认，点按回到会话',
    sTitle: '任务通知',
    sDesc: '任务完成、或卡在需要你确认的步骤时提醒你。修改立即生效。',
    sBrowser: '浏览器通知',
    sDone: '任务完成时通知',
    sAsk: '等待审批或回答时通知',
    sTimeout: '超时等待时间',
    sApproval: '审批超时后',
    sApproveOnce: '允许一次（面板默认动作）',
    sReject: '拒绝（更安全）',
    sQuestion: '提问超时后',
    sFirst: '选第一个选项',
    sNothing: '不回答',
    sWebhook: '备用推送 Webhook',
    sWebhookHint:
      '直接由浏览器发出，页面在后台也能收到；内容复用宿主合成的消息（结果、任务、工作区、用时），宿主端未就绪时降级为一行摘要。支持飞书、钉钉、Server酱与通用 JSON。',
    sKind: '报文格式',
    sKindAuto: '自动识别（按 URL）',
    sTest: '发一条测试',
    sTestOk: '测试已推送',
    sTestFail: '推送失败',
    sSampleTitle: '排查登录超时',
    sSampleWorkspace: 'my-app',
    sec: '秒',
    sPerm: '浏览器权限',
    sPermAsk: '未授权',
    sPermOk: '已授权',
    sPermNo: '已拒绝',
    sSecureHint: '通知需要 HTTPS 安全上下文，请从 HTTPS 入口打开后授权。',
    sGo: '打开 HTTPS',
    dTitle: '诊断',
    dHint: '只读。反馈预览、通知、侧栏问题时，把整份报告复制出来。',
    dOpen: '生成诊断信息',
    dRefresh: '重新生成',
    dCopy: '复制',
    dCopied: '已复制',
    dCopyFail: '复制失败，请手动选中文本复制',
    dLoading: '正在收集…',
    hTitle: '服务端自动回答',
    hHint:
      '在宿主进程里生效：浏览器关掉、手机锁屏也会继续按下面规则替你放行/回答。这是唯一的一套自动回答机制，浏览器端没有副本。',
    hEnable: '开启（默认关闭，开启后会在你不在场时替你做决定）',
    hSave: '保存到宿主',
    hSaving: '保存中…',
    hSaved: '已保存，立即生效',
    hFailed: '保存失败',
    hUnavailable: '宿主端未就绪',
    hLoading: '正在读取宿主设置…',
  },
};


/**
 * Task-completion notifications are an opt-in extension point for this
 * release: the Host half still serves the Service Worker, but the browser half
 * only wires permission UI, the running->done watcher and the SW registration
 * when this flag is true. Notifications require a secure context (HTTPS), so
 * enable this after the Web GUI is reachable over HTTPS.
 */
const NOTIFICATIONS_ENABLED = true;

/**
 * The settings section, resolved on first render.
 *
 * Registering the slot entry stays synchronous (its label is used by the
 * settings navigation immediately); only the page component below it waits for
 * the chunk, which keeps the settings bundle out of the boot path.
 */
function settingsSection(t, api, platform) {
  let promise = null;
  const load = () => {
    promise ??= platform.loadSettings().then((module) => {
      if (!module) return null;
      module.install(api, platform);
      return module.makeSettingsPage(t);
    });
    return promise;
  };

  return function DshMobileSettingsSection(props) {
    const [Page, setPage] = React.useState(null);
    React.useEffect(() => {
      let live = true;
      load().then((component) => {
        if (live && component) setPage(() => component);
      });
      return () => {
        live = false;
      };
    }, []);
    return Page ? React.createElement(Page, props) : null;
  };
}

return {
  inject: ['slots', 'sessions', 'uiSession', 'uiWorkspace', 'locale'],

  apply(ctx) {
    ctx.effect(() => ctx.locale.register('dsh-mobile', 'en', MESSAGES.en));
    ctx.effect(() => ctx.locale.register('dsh-mobile', 'zh', MESSAGES.zh));
    const t = ctx.locale.bind('dsh-mobile');

    // Chunks arrive asynchronously; every registration below checks this flag so
    // a plugin unloaded mid-flight stops installing instead of leaking effects.
    let live = true;
    ctx.effect(() => () => {
      live = false;
    });

    const boot = async () => {
      // Presentation first: the notification pill and the plugin's own pages
      // are the only styles this plugin still owns. Core owns the layout.
      const styles = await loadChunk(require, 'styles');
      if (!live) return;
      if (styles) ctx.effect(styles.installStyles);

      // The compat alias first: a preview restored from a saved tab subscribes
      // as soon as it mounts. Inert on a normal URL parser.
      const compat = await loadChunk(require, 'resourceCompat');
      if (!live) return;
      let compatApi = null;
      if (compat) {
        try {
          compatApi = compat.install(ctx);
          ctx.effect(() => () => compatApi?.dispose?.());
        } catch (error) {
          console.error('[dsh-mobile] resource compat failed to install', error);
          compatApi = null;
        }
      }

      // Before the notification UI: it restores tabs, and a preview that subscribes
      // ahead of the recorder would be missing from the evidence.
      const forensics = await loadChunk(require, 'forensics');
      if (!live) return;
      let forensicsApi = null;
      if (forensics) {
        try {
          forensicsApi = forensics.install(ctx);
          ctx.effect(() => () => forensicsApi?.dispose?.());
        } catch (error) {
          console.error('[dsh-mobile] forensics recorder failed to install', error);
          forensicsApi = null;
        }
      }

      const [notify, deeplink] = await Promise.all([
        loadChunk(require, 'notify'),
        loadChunk(require, 'deeplink'),
      ]);
      if (!live) return;

      const api = notify?.api ?? null;
      if (deeplink) {
        const open = api ? api.openSession : () => {};
        ctx.effect(() => deeplink.installDeepLink(ctx, open));
        ctx.effect(() => deeplink.watchHashDeepLink(ctx, open));
      }

      if (!NOTIFICATIONS_ENABLED || !api) return;

      // What the settings page (and its diagnostics chunk) may read: the live
      // context, the chunk table, the two optional recorders and the lazy
      // loaders. Chunks never reach into the entry themselves.
      const platform = {
        ctx,
        chunkStatus,
        forensics: forensicsApi,
        resourceCompat: compatApi,
        loadSettings: () => loadChunk(require, 'settings'),
        loadDiagnostics: () => loadChunk(require, 'diagnostics'),
      };

      // Host is the single source of truth for the notification settings; the
      // local cache only carries them until this lands (or if it fails).
      api.syncHostSettings();
      ctx.effect(() => api.installServiceWorkerMessages(ctx));
      ctx.effect(() => api.watchNotifications(ctx, t));
      ctx.effect(() => api.watchFeed(ctx, t));
      ctx.effect(() => {
        api.registerServiceWorker();
      });
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'dsh-mobile-notify', label: () => t('sTitle'), order: 91 },
          settingsSection(t, api, platform),
        ),
      );
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-mobile-notify', order: 90 },
          api.makeNotifyHint(t),
        ),
      );
    };

    boot().catch((error) => console.error('[dsh-mobile] client bootstrap failed', error));
  },
};
  },
});
