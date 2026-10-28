/**
 * dsh-mobile: document-preview forensics.
 *
 * Loaded at boot, before any other chunk installs, because it has to be holding
 * the recording when the first preview subscribes. Its whole job is to leave
 * evidence for one class of failure: a right-sidebar preview that renders
 * "文件资源服务不可用" / "The file resource service is unavailable." even though the
 * diagnostics page is otherwise green.
 *
 * Three recorders, nothing else — no behaviour is changed:
 *
 *   - resources   `resources.source(address)` is kept as-is and its `subscribe`
 *                 is wrapped in place, so the returned observable is the very
 *                 same object the official hook already caches by identity. We
 *                 record the address, the protocol the official `protocolOf`
 *                 would derive, the provider state at subscribe time, and every
 *                 status the store reports afterwards (`none/loading/live/failed`).
 *                 The registry itself is the authority on the preview's `meta.status`:
 *                 a record created before its protocol had a provider stays `none`
 *                 for good, so the status sequence is the evidence.
 *   - console     `error` and `unhandledrejection`, message plus first stack line.
 *   - failure     a MutationObserver on the page text; the first moment either
 *                 of the two strings appears is stamped, together with a frozen
 *                 copy of every resource subscription at that same moment.
 *
 * Nothing here reads file content, and nothing here decides anything: the
 * diagnostics chunk renders these rows as text and the reader draws the
 * conclusion. Ring buffers (20 subscriptions, 12 states each, 20 console rows)
 * keep the cost flat on a long-lived page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  chunk: 'client.forensics.js',

  factory() {
    const MAX_SUBSCRIPTIONS = 20;
    const MAX_STATES = 12;
    const MAX_CONSOLE = 20;
    /** Full-document rescan delay; targeted mutation hits are stamped inline. */
    const FULL_SCAN_DELAY = 300;

    /** Both official strings, from the document-preview locale dictionaries. */
    const FAILURE_TEXT = ['文件资源服务不可用', 'The file resource service is unavailable'];

    /**
     * The live recorder, so the lazily loaded diagnostics chunk can read it
     * without reaching into the entry. `null` when the plugin is unloaded.
     */
    let current = null;

    const text = (value) => String(value ?? '');
    const clip = (value, max) => {
      const plain = text(value).replace(/\s+/g, ' ').trim();
      return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
    };
    const iso = (at) => new Date(at).toISOString();
    /** UTC like the report's own `time` row, so a phone's timezone cannot confuse the reader. */
    const clock = (at) => iso(at).slice(11, 23);

    /**
     * The protocol key the resources registry derives, in one string.
     *
     * Same logic as the official `protocolOf` — `new URL(address)`, then the
     * host — with the two non-protocol outcomes named so the report shows why
     * `providerOf` had nothing to find: an unparsable address, an address in
     * another scheme (e.g. a `workspace`-shaped one), or a resource address
     * without a host.
     */
    function protocolOf(address) {
      let parsed;
      try {
        parsed = new URL(text(address));
      } catch {
        return 'unparsed';
      }
      if (parsed.protocol !== 'dsh-resource:') return `not-a-resource (${parsed.protocol})`;
      return parsed.hostname === '' ? 'no-protocol' : parsed.hostname.toLowerCase();
    }

    const isProtocolKey = (protocol) =>
      protocol !== 'unparsed' && protocol !== 'no-protocol' && !protocol.startsWith('not-a-resource');

    /** `providerOf` as the registry would answer it at this instant. */
    function providerToken(resources, protocol) {
      if (!isProtocolKey(protocol)) return 'n/a';
      if (typeof resources?.providerOf !== 'function') return 'unknown';
      try {
        return resources.providerOf(protocol) === undefined ? 'no' : 'yes';
      } catch (error) {
        return `unknown (threw: ${clip(error?.message ?? error, 60)})`;
      }
    }

    /** The registry's own snapshot, reduced to the four statuses plus a failure code. */
    function readState(source) {
      try {
        const snapshot = source.getSnapshot?.();
        const status = text(snapshot?.status) || 'unknown';
        const failure = snapshot?.failure;
        return {
          status,
          failure: failure
            ? clip(
                failure.code ??
                  failure.message ??
                  (typeof failure === 'string' ? failure : JSON.stringify(failure)),
                60,
              )
            : '',
        };
      } catch (error) {
        return { status: 'unknown', failure: clip(`getSnapshot threw: ${error?.message ?? error}`, 60) };
      }
    }

    /**
     * Install the three recorders on the live context.
     *
     * `ctx` is only used for `ctx.get('resources')`, and every read is guarded:
     * a missing service is a fact the report states, never a throw.
     */
    function install(ctx) {
      if (current) return current;

      let resources;
      try {
        resources = typeof ctx?.get === 'function' ? ctx.get('resources') : undefined;
      } catch {
        resources = undefined;
      }

      // ---- resources: address + protocol + provider + status sequence -------
      const entries = new Map();
      const consoleRows = [];
      let failure = null;

      const statesOf = (entry) => entry.states.map((state) => ({ ...state }));

      /** Deep copy: a frozen snapshot must not move when the live rows do. */
      const copyEntry = (entry) => ({
        address: entry.address,
        protocol: entry.protocol,
        providerAtSource: entry.providerAtSource,
        providerAtSubscribe: entry.providerAtSubscribe,
        subscribes: entry.subscribes,
        since: entry.since,
        states: statesOf(entry),
      });

      function entryFor(address) {
        const key = text(address);
        let entry = entries.get(key);
        if (entry !== undefined) return entry;
        const protocol = protocolOf(key);
        entry = {
          address: key,
          protocol,
          providerAtSource: providerToken(resources, protocol),
          providerAtSubscribe: null,
          subscribes: 0,
          since: Date.now(),
          states: [],
        };
        entries.set(key, entry);
        while (entries.size > MAX_SUBSCRIPTIONS) entries.delete(entries.keys().next().value);
        return entry;
      }

      /**
       * Record one status reading, collapsing a run of identical readings into
       * a count — the store notifies on every frame, and the shape of the run
       * (none×3 → loading → live) is what matters, not each repeat.
       */
      function noteState(entry, reading, cause) {
        const at = Date.now();
        const last = entry.states[entry.states.length - 1];
        if (last !== undefined && last.status === reading.status && last.failure === reading.failure) {
          last.count += 1;
          last.lastAt = at;
          return;
        }
        entry.states.push({ ...reading, at, count: 1, cause });
        if (entry.states.length > MAX_STATES) entry.states.shift();
      }

      const instrumented = new WeakSet();
      let restoreSource = null;

      /**
       * Wrap one record's `subscribe` in place.
       *
       * In place, and returning the same object, is deliberate: the official
       * resource hook caches its `useSyncExternalStore` bindings by the source
       * object's identity, so a proxy per call would resubscribe on every
       * render — a behaviour change, which this chunk must not cause.
       */
      function observe(source, address) {
        if (typeof source?.subscribe !== 'function' || instrumented.has(source)) return;
        const subscribe = source.subscribe;
        instrumented.add(source);
        const entry = entryFor(address);
        source.subscribe = function subscribeWithForensics(listener) {
          const notify = typeof listener === 'function' ? listener : () => {};
          entry.subscribes += 1;
          // Read before subscribing: this is the status the preview will paint
          // on its first frame, i.e. the `meta.status` the UI branches on.
          entry.providerAtSubscribe = providerToken(resources, entry.protocol);
          noteState(entry, readState(source), 'subscribe');
          const unsubscribe = subscribe.call(source, function relay(...args) {
            noteState(entry, readState(source), 'change');
            return notify.apply(this, args);
          });
          return typeof unsubscribe === 'function' ? unsubscribe : () => {};
        };
      }

      if (resources && typeof resources.source === 'function') {
        const source = resources.source;
        const patched = function patchedSource(address) {
          const observable = source.call(resources, address);
          try {
            observe(observable, address);
          } catch {
            // Recording must never cost the caller its observable.
          }
          return observable;
        };
        resources.source = patched;
        restoreSource = () => {
          if (resources.source === patched) resources.source = source;
        };
      }

      // ---- console ---------------------------------------------------------
      function pushConsole(kind, message, where) {
        consoleRows.push({
          at: Date.now(),
          kind,
          message: clip(message, 240) || '(empty)',
          where: clip(where, 200),
        });
        while (consoleRows.length > MAX_CONSOLE) consoleRows.shift();
      }

      function firstStack(error) {
        const stack = text(error?.stack);
        if (!stack) return '';
        const lines = stack.split('\n').map((line) => line.trim()).filter(Boolean);
        return lines.length > 1 ? lines[1] : lines[0];
      }

      const onError = (event) => {
        const error = event?.error;
        pushConsole(
          'error',
          event?.message || error?.message || error,
          firstStack(error) || [event?.filename, event?.lineno].filter((part) => part !== undefined).join(':'),
        );
      };
      const onRejection = (event) => {
        const reason = event?.reason;
        pushConsole('unhandledrejection', reason?.message || reason, firstStack(reason));
      };

      const unlisten = [];
      const listen = (type, handler) => {
        try {
          window.addEventListener(type, handler);
          unlisten.push(() => window.removeEventListener(type, handler));
        } catch {
          // A realm without window.addEventListener simply records nothing.
        }
      };
      listen('error', onError);
      listen('unhandledrejection', onRejection);

      // ---- failure moment --------------------------------------------------
      let observer = null;
      let scanTimer = 0;

      function bodyText() {
        try {
          return text(document.body?.textContent);
        } catch {
          return '';
        }
      }

      function matchedIn(value) {
        const haystack = text(value);
        return FAILURE_TEXT.find((needle) => haystack.includes(needle)) ?? '';
      }

      /** The first sighting keeps its snapshot; later ones only bump the count. */
      function mark(needle) {
        const at = Date.now();
        if (failure) {
          failure.count += 1;
          failure.lastAt = at;
          return;
        }
        failure = { at, lastAt: at, count: 1, needle, snapshot: [...entries.values()].map(copyEntry) };
      }

      function onMutations(mutations) {
        for (const mutation of mutations ?? []) {
          const hit = matchedIn(mutation?.target?.textContent ?? mutation?.target?.nodeValue);
          if (hit) {
            mark(hit);
            return;
          }
          for (const node of mutation?.addedNodes ?? []) {
            const inner = matchedIn(node?.textContent ?? node?.nodeValue);
            if (inner) {
              mark(inner);
              return;
            }
          }
        }
        // Text can arrive in pieces (a streamed frame, a re-render); rescan the
        // document on a timer rather than on every mutation.
        if (scanTimer) return;
        scanTimer = setTimeout(() => {
          scanTimer = 0;
          const hit = matchedIn(bodyText());
          if (hit) mark(hit);
        }, FULL_SCAN_DELAY);
      }

      if (typeof MutationObserver === 'function') {
        try {
          observer = new MutationObserver(onMutations);
          observer.observe(document.body ?? document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
          });
          const already = matchedIn(bodyText());
          if (already) mark(already);
        } catch {
          observer = null;
        }
      }

      // ---- report ----------------------------------------------------------
      const stateText = (state) => {
        const count = state.count > 1 ? `x${state.count}` : '';
        const why = state.failure ? `(${state.failure})` : '';
        return `${state.status}${why}@${clock(state.at)}${count}`;
      };

      function subscriptionLines(rows, indent = '') {
        if (rows.length === 0) return [`${indent}none recorded`];
        const out = [];
        rows.forEach((row, index) => {
          out.push(`${indent}${index + 1}. ${row.address}`);
          const provider = row.providerAtSubscribe ?? 'never subscribed';
          const atSource =
            row.providerAtSubscribe !== null && row.providerAtSource !== row.providerAtSubscribe
              ? ` · provider-at-source-call ${row.providerAtSource}`
              : '';
          out.push(`${indent}   protocol ${row.protocol} · provider-at-subscribe ${provider}${atSource} · subscribes ${row.subscribes}`);
          out.push(`${indent}   ${row.states.length ? row.states.map(stateText).join(' → ') : 'no state recorded'}`);
        });
        return out;
      }

      function report() {
        const rows = [...entries.values()].map(copyEntry);
        const subscriptions = subscriptionLines(rows);
        if (failure) {
          const repeats = failure.count > 1 ? ` (x${failure.count}, last ${iso(failure.lastAt)})` : '';
          subscriptions.push('');
          subscriptions.push(`failure-moment ${iso(failure.at)} · 「${failure.needle}」${repeats}`);
          subscriptions.push('snapshot at that moment:');
          subscriptions.push(...subscriptionLines(failure.snapshot, '  '));
        } else {
          subscriptions.push('failure-moment none observed');
        }

        const logs = consoleRows.map((row) => {
          const where = row.where ? `\n       ${row.where}` : '';
          return `[${clock(row.at)}] ${row.kind}: ${row.message}${where}`;
        });

        const problems = [];
        for (const row of rows) {
          if (row.states.length > 0 && row.states.every((state) => state.status === 'none')) {
            problems.push(`a resource subscription never left status none: ${row.address}`);
          } else if (row.states.some((state) => state.status === 'failed')) {
            problems.push(`a resource subscription reported failed: ${row.address}`);
          }
        }
        if (failure) {
          problems.push(`the page showed 「${failure.needle}」 at ${iso(failure.at)}: see the resource subscriptions snapshot`);
        }

        return {
          subscriptions,
          console: logs.length > 0 ? logs : ['errors: none'],
          problems,
        };
      }

      const api = {
        rows: () => [...entries.values()].map(copyEntry),
        console: () => consoleRows.map((row) => ({ ...row })),
        failure: () =>
          failure
            ? {
                at: failure.at,
                lastAt: failure.lastAt,
                count: failure.count,
                needle: failure.needle,
                snapshot: failure.snapshot.map((entry) => ({ ...entry, states: statesOf(entry) })),
              }
            : null,
        report,
        watching: { resources: restoreSource !== null, mutations: observer !== null },
        dispose,
      };

      function dispose() {
        if (scanTimer) {
          clearTimeout(scanTimer);
          scanTimer = 0;
        }
        if (observer) {
          try {
            observer.disconnect();
          } catch {
            // A disconnected observer is already disconnected.
          }
          observer = null;
        }
        for (const off of unlisten.splice(0)) {
          try {
            off();
          } catch {
            // Removing a listener that is gone is not an error worth reporting.
          }
        }
        if (restoreSource) {
          try {
            restoreSource();
          } catch {
            // The service is going away with the plugin.
          }
          restoreSource = null;
        }
        if (current === api) current = null;
      }

      current = api;
      return api;
    }

    return { install, current: () => current };
  },
});
