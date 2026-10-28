/**
 * dsh-mobile: read-only diagnostics.
 *
 * Loaded on demand from the settings page. Its job is to make one class of
 * failure visible without a desktop devtools session: a client module (or one of
 * this plugin's own chunks) that never arrived, a layout contract that moved
 * after a Harness upgrade, a missing resource provider, a browser too old for
 * the CSS the skin relies on.
 *
 * Everything here is measured, not guessed: the module list comes from the live
 * module system (`ctx.modules`), the selector hit counts from the DOM, the host
 * facts from the public `/plugins/dsh-mobile/meta` route, and the resource
 * subscription / console evidence from the forensics recorder the entry installs
 * at boot (`client.forensics.js`). The report is plain text so it can be copied
 * in one tap and pasted into an issue.
 *
 * The two evidence sections report; they do not explain. Which of the possible
 * causes (wrong protocol, a record created before its provider existed, a
 * mis-read failure frame) holds is for the reader to decide.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  chunk: 'client.diagnostics.js',

  factory(require) {
    const React = require('react');

    /** The host half is local; a slow answer is a finding, not something to wait for. */
    const META_TIMEOUT = 1500;

    const message = (error) => String(error?.message ?? error ?? '');
    const yesNo = (value) => (value ? 'yes' : 'no');
    const pad = (label) => `${label.padEnd(14)}`;

    function safe(fn, fallback) {
      try {
        return fn();
      } catch (error) {
        return `${fallback} (threw: ${message(error)})`;
      }
    }

    /** `{ value, error }` — for reads that must stay distinguishable from a string. */
    function attempt(fn, fallback = null) {
      try {
        return { value: fn() ?? fallback, error: '' };
      } catch (error) {
        return { value: fallback, error: message(error) };
      }
    }

    /** `Promise.withResolvers`, `dvh`, `:has()` — the three the skin needs. */
    function features() {
      return {
        withResolvers: typeof Promise.withResolvers === 'function',
        dvh: safe(() => CSS.supports?.('height', '100dvh') === true, false),
        has: safe(() => CSS.supports?.('selector(:has(*))') === true, false),
      };
    }

    /**
     * Every boot-graph row that failed to import, with the loader's own message.
     *
     * The service is read through `ctx.get('modules')`, never `ctx.modules`: a
     * cordis ctx is a proxy that throws "cannot get property ... without inject"
     * for anything missing from the plugin's inject list, and this plugin does
     * not inject the module system (it would then wait for it at boot).
     */
    function moduleFailures(modules) {
      const rows = modules?.manifest?.modules ?? [];
      const failures = [];
      for (const row of rows) {
        let error;
        try {
          error = modules.importError?.(row.id);
        } catch (caught) {
          failures.push({ id: row.id, detail: `importError threw: ${message(caught)}` });
          continue;
        }
        if (error) failures.push({ id: row.id, detail: message(error) });
      }
      return {
        total: rows.length,
        plugins: (modules?.manifest?.plugins ?? []).length,
        failures,
      };
    }

    /** Chunk load status recorded by the entry (its own, plus the lazy ones). */
    function chunkFailures(chunkStatus) {
      // Duck-typed on purpose: the table is a Map from the entry's realm, which
      // would fail an `instanceof` check across realms.
      const entries = typeof chunkStatus?.entries === 'function' ? [...chunkStatus.entries()] : [];
      const loaded = entries.filter(([, state]) => state?.ok).map(([name]) => name);
      const failed = entries.filter(([, state]) => state && !state.ok).map(([name, state]) => ({
        name,
        detail: state.error || 'unknown',
      }));
      return { loaded, failed };
    }

    /** The host half, through its one public route. */
    async function hostFacts() {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), META_TIMEOUT) : null;
      try {
        const init = { cache: 'no-store' };
        if (controller) init.signal = controller.signal;
        const response = await fetch('/plugins/dsh-mobile/meta', init);
        if (!response.ok) return { reachable: false, detail: `HTTP ${response.status}` };
        const meta = await response.json();
        return {
          reachable: true,
          enabled: meta?.enabled === true,
          httpsPort: meta?.httpsPort,
          baseUrl: meta?.baseUrl || '(unset)',
          channels: Array.isArray(meta?.channels) ? meta.channels : [],
        };
      } catch (error) {
        return { reachable: false, detail: message(error) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    /**
     * Collect every fact into one plain-text report plus the derived problems.
     *
     * `deps`: `{ ctx, chunkStatus, sidebar, menu, api, t }` — the entry hands over
     * the module context, its chunk table, the sidebar state machine and the menu
     * button's registration outcome; the settings page adds the notification API.
     */
    async function collect(deps) {
      const { ctx, chunkStatus, sidebar, api } = deps ?? {};
      const problems = [];
      const layoutRead = attempt(() => sidebar?.diagnostics?.());
      const layout = layoutRead.value;
      const moduleRead = attempt(() => (typeof ctx?.get === 'function' ? ctx.get('modules') : undefined));
      const moduleService = moduleRead.value;
      const modules = moduleFailures(moduleService);
      const chunks = chunkFailures(chunkStatus);
      const host = await hostFacts();
      const caps = features();

      // The header menu button: whether its slot registration went through (the
      // entry records that) and whether the button it renders is in the DOM.
      const registered = deps?.menu?.registered === true;
      const mounted = attempt(() => document.querySelector('.dshm-menu') !== null, false);
      const menu = {
        slot: deps?.menu?.slot || 'conversation.header.leading',
        registered,
        mounted: mounted.value,
        error: deps?.menu?.error || (mounted.error ? `query threw: ${mounted.error}` : ''),
      };

      const resourcesRead = attempt(() => (typeof ctx?.get === 'function' ? ctx.get('resources') : undefined));
      const resources = resourcesRead.value;
      const fileProvider = resources && typeof resources.providerOf === 'function'
        ? attempt(() => Boolean(resources.providerOf('file')), false).value
        : null;

      // The Huawei-browser shim (`client.resource-compat.js`). It is inert on a
      // normal URL parser, so this row is the only trace it leaves in the report.
      const compat = deps?.resourceCompat ?? null;
      const compatRead = compat && typeof compat.report === 'function'
        ? attempt(() => compat.report())
        : { value: null, error: '' };
      const alias = compatRead.value;
      const aliasLine = alias?.detail ?? `not installed${compatRead.error ? ` (report threw: ${compatRead.error})` : ''}`;

      // The forensics recorder is installed by the entry at boot; a diagnostics
      // page opened without it (older entry, failed chunk) still collects the
      // rest instead of failing.
      const forensics = deps?.forensics ?? null;
      const evidenceRead = forensics && typeof forensics.report === 'function'
        ? attempt(() => forensics.report())
        : { value: null, error: '' };
      const evidence = evidenceRead.value;
      const evidenceNote = `not installed${evidenceRead.error ? ` (report threw: ${evidenceRead.error})` : ''}`;

      const lines = [];
      lines.push('=== dsh-mobile diagnostics ===');
      lines.push(`${pad('time')}${new Date().toISOString()}`);
      lines.push(`${pad('ua')}${safe(() => navigator.userAgent, 'unknown')}`);
      lines.push(`${pad('platform')}${safe(() => navigator.platform || '(empty)', 'unknown')}`);
      lines.push(`${pad('origin')}${safe(() => window.location.origin, 'unknown')}`);
      lines.push(
        `${pad('viewport')}${safe(() => `${window.innerWidth}x${window.innerHeight}`, 'unknown')} @${safe(
          () => String(window.devicePixelRatio ?? 1),
          '?',
        )}x`,
      );
      lines.push(`${pad('narrow')}${yesNo(safe(() => window.matchMedia('(max-width: 1024px)').matches, false))} (max-width: 1024px)`);
      lines.push(`${pad('secure')}${yesNo(safe(() => window.isSecureContext, false))}`);

      let shell = 'none';
      if (safe(() => typeof window.DshNative === 'object' && window.DshNative !== null, false)) {
        shell = safe(
          () => (typeof window.DshNative.version === 'function' ? String(window.DshNative.version() ?? 'unknown') : 'present (no version())'),
          'present (version threw)',
        );
      }
      lines.push(`${pad('shell')}${shell}`);

      lines.push('');
      lines.push('-- features --');
      lines.push(`${pad('withResolvers')}${yesNo(caps.withResolvers)}`);
      lines.push(`${pad('css dvh')}${yesNo(caps.dvh)}`);
      lines.push(`${pad('css :has()')}${yesNo(caps.has)}`);

      lines.push('');
      lines.push('-- layout --');
      if (layout) {
        lines.push(`${pad('surface')}${layout.surface === true ? 'mobile' : 'desktop'} (marker ${yesNo(layout.surface === true)})`);
        lines.push(`${pad('state')}${layout.state}`);
        lines.push(`${pad('marked')}${Object.entries(layout.marked ?? {}).map(([key, value]) => `${key}=${value}`).join(' ')}`);
        lines.push(`${pad('menu')}slot ${menu.slot} · registered ${yesNo(menu.registered)} · mounted ${yesNo(menu.mounted)}${menu.error ? ` · ${menu.error}` : ''}`);
        lines.push(`${pad('selectors')}${Object.entries(layout.selectors ?? {}).map(([key, value]) => `${key}=${value}`).join(' ')}`);
      } else {
        lines.push(`${pad('layout')}sidebar module not loaded${layoutRead.error ? ` (${layoutRead.error})` : ''}`);
      }

      lines.push('');
      lines.push(
        moduleService
          ? `-- client modules (${modules.total} rows, ${modules.plugins} plugins) --`
          : `-- client modules -- ctx.get("modules") returned nothing${moduleRead.error ? ` (${moduleRead.error})` : ''}`,
      );
      if (modules.failures.length === 0) lines.push('import errors: none');
      else for (const failure of modules.failures) lines.push(`FAILED ${failure.id}\n       ${failure.detail}`);

      lines.push('');
      lines.push('-- plugin chunks --');
      lines.push(`loaded: ${chunks.loaded.join(', ') || 'none'}`);
      if (chunks.failed.length === 0) lines.push('load errors: none');
      else for (const failure of chunks.failed) lines.push(`FAILED ${failure.name}\n       ${failure.detail}`);

      lines.push('');
      lines.push('-- resources --');
      lines.push(`${pad('service')}${resources ? 'present' : `missing${resourcesRead.error ? ` (${resourcesRead.error})` : ''}`}`);
      if (fileProvider !== null) lines.push(`${pad('file provider')}${yesNo(fileProvider)}`);
      lines.push(`${pad('unparsed alias')} ${aliasLine}`);

      lines.push('');
      lines.push('-- resource subscriptions --');
      if (evidence) lines.push(...evidence.subscriptions);
      else lines.push(evidenceNote);

      lines.push('');
      lines.push('-- console --');
      if (evidence) lines.push(...(evidence.console ?? []));
      else lines.push(evidenceNote);

      lines.push('');
      lines.push('-- host --');
      if (host.reachable) {
        lines.push(`${pad('meta')}ok · enabled ${yesNo(host.enabled)} · httpsPort ${host.httpsPort ?? '?'} · baseUrl ${host.baseUrl}`);
        lines.push(`${pad('channels')}${host.channels.length ? host.channels.join(', ') : 'none configured'}`);
      } else {
        lines.push(`${pad('meta')}unreachable: ${host.detail}`);
      }
      let notification = 'unknown';
      try {
        notification = api?.notificationState?.() ?? 'unknown';
      } catch (error) {
        notification = `threw: ${message(error)}`;
      }
      lines.push(`${pad('notification')}${notification}`);

      // ---- conclusion: facts -> sentences ----------------------------------
      if (modules.failures.length > 0) {
        problems.push(`${modules.failures.length} client module(s) failed to import: ${modules.failures.map((item) => item.id).join(', ')}`);
      }
      if (chunks.failed.length > 0) {
        problems.push(`${chunks.failed.length} plugin chunk(s) failed to load: ${chunks.failed.map((item) => item.name).join(', ')}`);
      }
      if (!caps.dvh) problems.push('CSS dvh is unsupported: viewport height may be wrong when the address bar moves');
      if (!caps.has) problems.push('CSS :has() is unsupported: parts of the mobile skin will not apply');
      if (!caps.withResolvers) problems.push('Promise.withResolvers is missing: this browser is older than the plugin expects');
      if (!safe(() => window.isSecureContext, false)) {
        problems.push('not a secure context: browser notifications cannot be shown (the host push path still works)');
      }
      if (layout && layout.surface === true) {
        const hits = layout.selectors ?? {};
        if (!hits.sidebarCol) problems.push('the sidebar column was not found: the layout contract changed');
        else if (!layout.marked?.frame) problems.push('the sidebar frame was found but not marked: the skin cannot apply');
        if (!menu.mounted) problems.push(`the header menu button is not rendered on the mobile surface (slot ${menu.slot}${menu.registered ? '' : ' not registered'})`);
      }
      if (!resources) problems.push('the resources service is missing: attachments and previews may not load');
      else if (fileProvider === false) problems.push('no provider for the file resource protocol: file previews and uploads will not render');
      if (!host.reachable) problems.push(`the host half did not answer /plugins/dsh-mobile/meta: ${host.detail}`);
      if (host.reachable && !host.enabled) problems.push('host-side notifications are disabled in settings');
      // This browser needs the alias (empty URL host) but the alias did not make
      // it into the registry: file previews stay unavailable and that is the
      // finding, not something the reader has to infer.
      if (alias?.broken && (alias.status === 'failed' || alias.status === 'timeout')) {
        problems.push(`the unparsed-protocol compatibility alias is not active: ${alias.note || alias.status}`);
      }
      // Facts the recorder saw: a subscription that never left `none`, a `failed`
      // frame, or the preview's own "unavailable" string on the page. Each is one
      // line of evidence, not a diagnosis.
      if (evidence?.problems?.length) problems.push(...evidence.problems);

      lines.push('');
      lines.push('-- conclusion --');
      if (problems.length === 0) lines.push('no problems detected');
      else for (const problem of problems) lines.push(`- ${problem}`);
      // A working alias is not a problem; it is the fact that explains why file
      // subscriptions keyed `no-protocol` still reach a provider.
      const aliasRows = alias?.active
        ? attempt(() => (typeof deps?.forensics?.rows === 'function' ? deps.forensics.rows() : []), []).value ?? []
        : [];
      const healed = aliasRows.filter((row) => row?.protocol === 'no-protocol');
      if (healed.length > 0) {
        lines.push(`note: the compatibility alias took over ${healed.length} subscription(s) whose dsh-resource address parsed without a host`);
      }

      return { text: lines.join('\n'), problems };
    }

    /** Clipboard first, `execCommand` for insecure contexts. */
    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        // Fall through to the legacy path.
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand?.('copy') === true;
        area.remove();
        return copied;
      } catch {
        return false;
      }
    }

    /**
     * The panel itself: collects once on mount, then stays read-only with a
     * copy and a refresh.
     */
    function createPanel(deps) {
      return function DiagnosticsPanel() {
        const t = deps.t;
        const [report, setReport] = React.useState({ status: 'loading', text: '', problems: [] });
        const [notice, setNotice] = React.useState('');

        React.useEffect(() => {
          let live = true;
          collect(deps)
            .then((result) => {
              if (live) setReport({ status: 'ready', ...result });
            })
            .catch((error) => {
              if (live) setReport({ status: 'failed', text: `collect failed: ${message(error)}`, problems: [] });
            });
          return () => {
            live = false;
          };
        }, []);

        const refresh = () => {
          setNotice('');
          setReport({ status: 'loading', text: '', problems: [] });
          collect(deps)
            .then((result) => setReport({ status: 'ready', ...result }))
            .catch((error) => setReport({ status: 'failed', text: `collect failed: ${message(error)}`, problems: [] }));
        };

        const copy = async () => {
          const copied = await copyText(report.text);
          setNotice(copied ? t('dCopied') : t('dCopyFail'));
        };

        if (report.status === 'loading') {
          return React.createElement('div', { className: 'dshm-diag' }, React.createElement('div', { className: 'dshm-rowHint' }, t('dLoading')));
        }

        return React.createElement(
          'div',
          { className: 'dshm-diag' },
          report.problems.length > 0
            ? React.createElement(
                'ul',
                { className: 'dshm-problems' },
                report.problems.map((problem) => React.createElement('li', { key: problem }, problem)),
              )
            : null,
          React.createElement('pre', { className: 'dshm-report' }, report.text),
          React.createElement(
            'div',
            { className: 'dshm-row' },
            React.createElement('button', { type: 'button', className: 'dshm-btn dshm-btnPrimary', onClick: copy }, t('dCopy')),
            React.createElement('button', { type: 'button', className: 'dshm-btn', onClick: refresh }, t('dRefresh')),
            notice ? React.createElement('span', { className: 'dshm-note' }, notice) : null,
          ),
        );
      };
    }

    return { createPanel, collect };
  },
});
