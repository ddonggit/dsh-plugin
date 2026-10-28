/**
 * dsh-mobile: compatibility alias for the resource protocol key.
 *
 * On Huawei Browser (ArkWeb) `new URL('dsh-resource://file/<...>')` reports
 * `protocol === 'dsh-resource:'` but an **empty hostname**, where Chromium and
 * Node report `hostname === 'file'`. The official `dsh-client-resources`
 * registry derives a record's protocol key from that hostname
 * (`new URL(address).hostname.toLowerCase()`), so on that browser every
 * `dsh-resource://` file record is keyed `undefined`, `providerOf(undefined)`
 * finds nothing, the record's status stays `none` and the document preview
 * prints 「文件资源服务不可用」. The official `file` provider itself parses its
 * addresses by string prefix (`dsh-resource://file/`), so it never needs the
 * URL parser and the whole chain works once the record is attached to it.
 *
 * Two narrow steps, and only when the probe below says the parser differs:
 *
 *   1. `resources.register(alias)` with `protocol: undefined` — the registry
 *      then `attach()`es every record that was keyed `undefined` (already-open
 *      previews included, since `attach` restarts a held record).
 *   2. A lookup bridge: this build's `providerOf()` returns `undefined` for the
 *      `undefined` key by design (`protocol === void 0 ? void 0 : …`), so the
 *      alias alone would never be found and `attach()` would start nothing.
 *      The bridge answers the `undefined` key with the alias and delegates every
 *      other key to the original method; it is restored on dispose.
 *
 * Nothing is registered for any other protocol, no global `URL` is touched, and
 * on a normal parser the probe is `false`: no alias, no bridge, no polling —
 * this chunk is a no-op there. Once the official package treats the empty host
 * as `file` itself, the probe goes `false` and the whole shim disappears with
 * it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  chunk: 'client.resource-compat.js',

  factory() {
    /** The address whose parse tells the two parsers apart. */
    const PROBE = 'dsh-resource://file/probe';
    /** The prefix the official `file` provider parses without a URL. */
    const FILE_PREFIX = 'dsh-resource://file/';
    /** The official provider may arrive after this chunk: poll, then give up. */
    const POLL_MS = 250;
    const LIMIT_MS = 30_000;

    /** The live instance, so the diagnostics chunk can read the alias state. */
    let current = null;

    /**
     * `true` only on a parser that drops the host of a `dsh-resource://` URL.
     *
     * This is the whole activation condition: Chromium, Firefox and Node parse
     * `dsh-resource://file/probe` with `hostname === 'file'`, so the shim stays
     * inert there.
     */
    function parserBroken() {
      try {
        const parsed = new URL(PROBE);
        return parsed.protocol === 'dsh-resource:' && parsed.hostname === '';
      } catch {
        return false;
      }
    }

    const text = (value) => String(value ?? '');

    /**
     * One failure frame, in the registry's own frame shape.
     *
     * A provider's `open` is an async generator of frames; a throw would surface
     * as an unhandled rejection inside `consume()`, so every dead end is a
     * frame instead.
     */
    const unsupported = (address) => ({
      ok: false,
      error: {
        code: 'workspace-file/unsupported-address',
        message: `the file compatibility alias only forwards ${FILE_PREFIX} addresses, got ${text(address)}`,
      },
    });

    /**
     * The alias provider: `protocol: undefined`, the key this browser's records
     * carry, forwarding the official `file` provider by address prefix.
     */
    function createAlias(official) {
      return {
        protocol: undefined,
        async *open(address, opts) {
          const target = text(address);
          if (target === 'dsh-resource://file' || target.startsWith(FILE_PREFIX)) {
            if (typeof official?.open !== 'function') {
              yield {
                ok: false,
                error: { code: 'workspace-file/unsupported-address', message: 'the file provider has no open()' },
              };
              return;
            }
            yield* official.open(address, opts);
            return;
          }
          yield unsupported(address);
        },
      };
    }

    /**
     * Answer the `undefined` protocol key with the alias, everything else with
     * the registry's own method.
     *
     * The official build writes `providerOf(protocol) { return protocol ===
     * void 0 ? void 0 : this.providers.get(protocol) }`, so a registered
     * `undefined` key is deliberately unreachable. This is the smallest place
     * that can be corrected from the client; it stays scoped to one instance
     * and is removed on dispose. Every other key is delegated unchanged, `this`
     * included.
     */
    function bridgeLookup(resources, alias) {
      const original = resources.providerOf;
      if (typeof original !== 'function') return null;
      const hadOwn = Object.hasOwn(resources, 'providerOf');
      const patched = function providerOf(protocol) {
        if (protocol === undefined) return alias;
        return original.call(this, protocol);
      };
      resources.providerOf = patched;
      return () => {
        if (resources.providerOf !== patched) return;
        if (hadOwn) resources.providerOf = original;
        else delete resources.providerOf;
      };
    }

    /**
     * Install the alias on the live context.
     *
     * `options` exists for the offline harness only (`{ broken, pollMs, limitMs }`);
     * the entry calls this with no arguments and gets the real probe and delays.
     */
    function install(ctx, options) {
      if (current) return current;
      const opts = options ?? {};
      const broken = typeof opts.broken === 'boolean' ? opts.broken : parserBroken();
      const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : POLL_MS;
      const limitMs = Number.isFinite(opts.limitMs) ? opts.limitMs : LIMIT_MS;

      let disposed = false;
      let timer = 0;
      let startedAt = 0;
      let release = null;
      let restoreLookup = null;
      let alias = null;
      /** `normal` (inert) · `waiting` · `active` · `failed` · `timeout` · `disposed` */
      let status = broken ? 'waiting' : 'normal';
      let note = '';

      /** The service is read per attempt: it may be provided after this plugin. */
      function service() {
        try {
          return typeof ctx?.get === 'function' ? ctx.get('resources') : undefined;
        } catch {
          return undefined;
        }
      }

      function stopPolling() {
        if (timer) {
          clearTimeout(timer);
          timer = 0;
        }
      }

      /**
       * Try once: wait for `providerOf('file')`, bridge the lookup, register.
       *
       * Returns `true` when this attempt settled the matter (registered, or gave
       * up for good) and `false` when it should be retried on the next tick.
       */
      function attempt() {
        if (disposed || status === 'active' || status === 'failed') return true;
        const resources = service();
        if (!resources || typeof resources.providerOf !== 'function' || typeof resources.register !== 'function') {
          return false;
        }
        let official;
        try {
          official = resources.providerOf('file');
        } catch {
          official = undefined;
        }
        if (official === undefined || official === null) return false;

        alias = createAlias(official);
        restoreLookup = bridgeLookup(resources, alias);
        if (!restoreLookup) {
          status = 'failed';
          note = 'the resources registry has no providerOf()';
          stopPolling();
          return true;
        }
        try {
          release = resources.register(alias);
          status = 'active';
          note = '';
        } catch (error) {
          // The `undefined` key is already taken by somebody else: leave the
          // registry exactly as it was and do not retry — another owner wins.
          try {
            restoreLookup();
          } catch {
            // Nothing to undo when the instance is already gone.
          }
          restoreLookup = null;
          alias = null;
          status = 'failed';
          note = `register failed: ${text(error?.message ?? error)}`;
          stopPolling();
        }
        return true;
      }

      function tick() {
        timer = 0;
        if (disposed) return;
        if (attempt()) return;
        if (Date.now() - startedAt >= limitMs) {
          status = 'timeout';
          note = 'the file provider never appeared';
          return;
        }
        timer = setTimeout(tick, pollMs);
      }

      if (broken) {
        startedAt = Date.now();
        if (!attempt()) {
          if (Date.now() - startedAt >= limitMs) {
            status = 'timeout';
            note = 'the file provider never appeared';
          } else {
            timer = setTimeout(tick, pollMs);
          }
        }
      }

      /** The one line the diagnostics page prints; `detail` is that line's value. */
      function report() {
        return {
          broken,
          active: status === 'active',
          status,
          note,
          detail:
            status === 'active'
              ? 'yes · via file provider'
              : `no (${status === 'normal' ? 'url parser normal' : note || status})`,
        };
      }

      function dispose() {
        disposed = true;
        stopPolling();
        // Restore the lookup first: the registry's own detach() then reads the
        // original method and parks the records back at `none`, not `loading`.
        if (restoreLookup) {
          try {
            restoreLookup();
          } catch {
            // The service is going away with this plugin.
          }
          restoreLookup = null;
        }
        if (release) {
          try {
            if (typeof release === 'function') release();
            else release?.dispose?.();
          } catch {
            // A registry being torn down does not need its disposer called again.
          }
          release = null;
        }
        alias = null;
        if (status === 'active') status = 'disposed';
        if (current === api) current = null;
      }

      const api = {
        get active() {
          return status === 'active';
        },
        report,
        dispose,
      };
      current = api;
      return api;
    }

    return { install, parserBroken, current: () => current };
  },
});
