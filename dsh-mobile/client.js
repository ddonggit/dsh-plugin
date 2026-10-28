/**
 * dsh-mobile client half: entry point and registration.
 *
 * The bundle is split into package-local chunks that the client module loader
 * fetches with `require.async('./client.<name>.js')` (the same mechanism
 * `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` uses):
 *
 *   client.styles.js    presentation only: the mobile skin and settings styles
 *   client.sidebar.js   DOM contract: selectors, sidebar state, gestures
 *   client.deeplink.js  `#session=` / `?session=` routing
 *   client.notify.js    browser notifications, feed catch-up
 *   client.resource-compat.js  the `file` provider under the `undefined` protocol key (Huawei browsers)
 *   client.forensics.js evidence recorder: resource subscriptions, console, preview failures
 *   client.settings.js  the "任务通知" settings section (loaded on demand)
 *
 * A chunk that fails to arrive disables its own feature and leaves the rest of
 * the plugin running; the diagnostics surface reports what failed.
 *
 * Hooks used (all shipped client services):
 *   - ctx.locale      : notification copy, one namespace ("dsh-mobile")
 *   - ctx.slots       : the header menu button (conversation.header.leading) + settings.section
 *   - ctx.layout      : the official sidebar toggle
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
  sidebar: './client.sidebar.js',
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
 * user the mobile layout, and a broken layout must not cost the notifications.
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

/**
 * Critical CSS, injected synchronously before the first await.
 *
 * The full skin is one chunk away, and the client shell does not wait for it, so
 * a cold start on a phone would paint the desktop layout for a frame or three
 * (sidebar visible, then gone). These two rules close that window.
 *
 * The frame is not a child of #root: the renderer wraps the app in a
 * `div[data-slot="root"]` with `display: contents`, so the frame is that
 * element's child (measured in Chromium at 390x844 — the #root-relative form
 * matched nothing at all). Structural on purpose, no compressed class names.
 */
const CRITICAL_CSS = `
@media (max-width: 1024px) {
  div[data-slot="root"] > div[style*="grid-template-columns"][data-sidebar-collapsed] {
    grid-template-columns: 0 minmax(0, 1fr) 0 !important;
  }
  div[data-slot="root"] > div[style*="grid-template-columns"][data-sidebar-collapsed] > div:first-child {
    display: none !important;
  }
}
`;

function installCriticalStyles() {
  const style = document.createElement('style');
  style.setAttribute('data-plugin', 'dsh-mobile-critical');
  style.textContent = CRITICAL_CSS;
  document.head.appendChild(style);
  return () => style.remove();
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
    navHidden: 'Open sidebar',
    navDrawer: 'Close sidebar',
    dTitle: 'Diagnostics',
    dHint: 'Read-only. Copy the whole report when reporting a problem with previews, notifications or the sidebar.',
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
    navHidden: '打开侧栏',
    navDrawer: '收起侧栏',
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
  inject: ['slots', 'layout', 'sessions', 'uiSession', 'uiWorkspace', 'locale'],

  apply(ctx) {
    ctx.effect(() => ctx.locale.register('dsh-mobile', 'en', MESSAGES.en));
    ctx.effect(() => ctx.locale.register('dsh-mobile', 'zh', MESSAGES.zh));
    const t = ctx.locale.bind('dsh-mobile');

    // Synchronous, before any await: see CRITICAL_CSS. Dropped as soon as the
    // real skin owns the layout — or when the sidebar chunk fails, so a broken
    // chunk can never leave the sidebar hidden with no button on a phone.
    let dropCritical = null;
    ctx.effect(() => {
      dropCritical = installCriticalStyles();
      return () => {
        if (dropCritical) dropCritical();
        dropCritical = null;
      };
    });
    const settleCritical = () => {
      if (!dropCritical) return;
      dropCritical();
      dropCritical = null;
    };

    // Chunks arrive asynchronously; every registration below checks this flag so
    // a plugin unloaded mid-flight stops installing instead of leaking effects.
    let live = true;
    ctx.effect(() => () => {
      live = false;
    });

    // The header menu button's registration outcome, reported by the
    // diagnostics page. Kept as a plain object so a slot that appears later (or
    // never) is visible without turning the boot into a failure.
    const menu = { slot: 'conversation.header.leading', registered: false, error: '' };

    const boot = async () => {
      // Styles first: the mobile skin has to be in place before anything paints
      // with the desktop column widths.
      const styles = await loadChunk(require, 'styles');
      if (!live) return;
      if (styles) {
        styles.ensureViewportFit();
        ctx.effect(styles.installStyles);
      }

      // The compat alias first: a preview restored from a saved tab subscribes
      // as soon as the sidebar mounts. Inert on a normal URL parser.
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

      // Before the sidebar: it restores tabs, and a preview that subscribes
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

      const [sidebar, notify, deeplink] = await Promise.all([
        loadChunk(require, 'sidebar'),
        loadChunk(require, 'notify'),
        loadChunk(require, 'deeplink'),
      ]);
      if (!live) return;

      let sidebarInstance = null;
      if (sidebar) {
        // `finally`: if installing the sidebar throws, the critical CSS must not
        // stay behind hiding the sidebar with no button to bring it back.
        try {
          const instance = sidebar.installSidebar(ctx);
          sidebarInstance = instance;
          ctx.effect(() => () => instance.dispose());
          // The entry point into the mobile sidebar: the first item of the
          // conversation header's leading seat. Registered through the official
          // slot, never by injecting into the header DOM; a missing slot only
          // costs this button, never the rest of the plugin.
          const registerMenu = () => {
            try {
              const dispose = ctx.slots.register(
                { name: 'conversation.header.leading', id: 'dsh-mobile-menu' },
                sidebar.makeMenuButton(t, instance),
              );
              menu.registered = true;
              menu.error = '';
              return dispose;
            } catch (error) {
              menu.registered = false;
              menu.error = String(error?.message ?? error);
              console.warn('[dsh-mobile] header menu button could not register', error);
              return () => {};
            }
          };
          try {
            ctx.slots.inject('conversation.header.leading', registerMenu);
          } catch (error) {
            menu.registered = false;
            menu.error = String(error?.message ?? error);
            console.warn('[dsh-mobile] conversation.header.leading is not available', error);
          }
        } finally {
          settleCritical();
        }
      } else {
        settleCritical();
      }

      const api = notify?.api ?? null;
      if (deeplink) {
        const open = api ? api.openSession : () => {};
        ctx.effect(() => deeplink.installDeepLink(ctx, open));
        ctx.effect(() => deeplink.watchHashDeepLink(ctx, open));
      }

      if (!NOTIFICATIONS_ENABLED || !api) return;

      // What the settings page (and its diagnostics chunk) may read: the live
      // context, the chunk table, the sidebar state machine and the two lazy
      // loaders. Chunks never reach into the entry themselves.
      const platform = {
        ctx,
        chunkStatus,
        sidebar: sidebarInstance,
        menu,
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
