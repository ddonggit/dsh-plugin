/**
 * dsh-mobile: the mobile sidebar contract.
 *
 * Everything that knows about Harness DOM structure lives here. Every other file
 * reads the `data-dshm-*` markers this module writes, so a frontend upgrade that
 * rehashes CSS modules only has to update the SEL table below.
 *
 * Two states, both derived from one fact — the official
 * `data-sidebar-collapsed` attribute:
 *
 *   collapsed -> hidden (no layout width; the header menu button is the only
 *                       affordance)
 *   expanded  -> drawer (the whole sidebar over the conversation)
 *
 * Nothing here keeps a state of its own: every transition is
 * `ctx.layout.toggleSidebar`, and the attribute change it causes is what moves
 * us between the two states. The 56px rail state the earlier versions had is
 * gone; there is no marker, no branch and no setting for it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  chunk: 'client.sidebar.js',

  factory(require) {
    const React = require('react');

/**
 * Harness DOM contract — the one place compressed CSS-module names may appear.
 *
 * `frame` is not looked up by name: it is the sidebar column's parent, which is
 * how `data-sidebar-collapsed` finds it too.
 */
const SEL = {
  sidebarCol: '[class*="_sidebarCol"]',
  centerCol: '[class*="_centerCol"]',
  rightbarCol: '[class*="_rightbarCol"]',
  /** The official brand/panel toggle inside the sidebar header. */
  toggle: '[class*="_toggle"]',
  /** Column resize handles (pointer-only affordance). */
  handle: '[class*="_handle"]',
};

/** Markers this module writes; the stylesheet only reads these. */
const MARK = {
  frame: 'data-dshm-frame',
  sidecol: 'data-dshm-sidecol',
  center: 'data-dshm-center',
  rightcol: 'data-dshm-rightcol',
  handle: 'data-dshm-handle',
  surface: 'data-dshm-surface',
};

/** The header menu button, excluded from the sidebar's own tap handling. */
const BUTTON = '[data-dshm-toggle]';

/**
 * Overlays portalled to `document.body` by a sidebar button.
 *
 * They are not inside the sidebar column, but tapping them is not a tap
 * outside the sidebar either — see `onPointerDown`.
 */
const PORTAL_OVERLAY = '[role="menu"], [role="dialog"], [role="listbox"]';

/** Harness switches to its narrow layout below this width (see dsh-client-ui-layout). */
const MOBILE_MEDIA = '(max-width: 1024px)';
const COLLAPSED = 'data-sidebar-collapsed';

/** Elements living inside the sidebar column. */
const inSidebar = (target) => Boolean(target.closest(SEL.sidebarCol));

/** Is this client running as the phone layout (narrow viewport or native shell)? */
function mobileSurface() {
  if (window.matchMedia(MOBILE_MEDIA).matches) return true;
  return typeof window.DshNative === 'object' && window.DshNative !== null;
}

/**
 * Maintain the surface marker the whole skin is scoped by.
 *
 * Desktop (> 1024px) never gets it, which is what keeps every rule below out of
 * the desktop layout.
 */
function syncSurface() {
  if (!document.body) return false;
  const mobile = mobileSurface();
  if (mobile) {
    if (document.body.getAttribute(MARK.surface) !== 'mobile') document.body.setAttribute(MARK.surface, 'mobile');
  } else if (document.body.hasAttribute(MARK.surface)) {
    document.body.removeAttribute(MARK.surface);
  }
  return mobile;
}

/** The pointer-only column handles are mounted with the drawer, not with the frame. */
function markHandles(frame) {
  for (const handle of frame.querySelectorAll(SEL.handle)) handle.setAttribute(MARK.handle, '');
}

/** Mark the frame and its columns with our own attributes. */
function markFrame() {
  const sidecol = document.querySelector(SEL.sidebarCol);
  const frame = sidecol ? sidecol.parentElement : null;
  if (!frame) return null;
  sidecol.setAttribute(MARK.sidecol, '');
  frame.setAttribute(MARK.frame, '');
  const center = frame.querySelector(SEL.centerCol);
  if (center) center.setAttribute(MARK.center, '');
  const rightcol = frame.querySelector(SEL.rightbarCol);
  if (rightcol) rightcol.setAttribute(MARK.rightcol, '');
  markHandles(frame);
  return frame;
}

/**
 * Install the sidebar state machine and return the surface the button drives.
 *
 * The returned object is intentionally small: `getState`, `subscribe`, `toggle`,
 * `hide` for the UI, plus `diagnostics` for the troubleshooting page.
 */
function installSidebar(ctx) {
  const listeners = new Set();
  let frame = null;
  let state = 'hidden';
  let surface = false;
  let lastSurface = null;

  const mobile = () => surface;
  const collapsed = () => Boolean(frame?.hasAttribute(COLLAPSED));

  /** The two states, computed from the one fact — never stored separately. */
  function computeState() {
    if (!frame) return 'hidden';
    return collapsed() ? 'hidden' : 'drawer';
  }

  function emit(force) {
    const next = computeState();
    if (!force && next === state) return;
    state = next;
    // Resize handles come and go with the drawer; mark them when it opens so the
    // touch skin can hide them without looking up their class name again.
    if (next === 'drawer' && frame) markHandles(frame);
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        console.debug('[dsh-mobile] sidebar listener failed', error);
      }
    }
  }

  /**
   * Recompute everything from the DOM.
   *
   * Called on every attribute change of the frame, on viewport changes, on shell
   * replacement and after our own transitions — it is the only writer, so the two
   * states can never drift.
   */
  function sync() {
    surface = syncSurface();

    if (frame && !frame.isConnected) frame = null;
    if (!frame && surface) frame = markFrame();

    const surfaceChanged = lastSurface !== surface;
    lastSurface = surface;
    emit(surfaceChanged);
  }

  let scheduled = false;
  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      sync();
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
    else window.setTimeout(run, 0);
  }

  /** Both states are the official toggle: it is the only writer of the state. */
  function toggle() {
    if (!surface) return;
    ctx.layout.toggleSidebar();
  }

  /** Only the drawer has something to hide. */
  function hide() {
    if (computeState() !== 'drawer') return;
    ctx.layout.toggleSidebar();
  }

  /**
   * Taps inside the sidebar.
   *
   * Bubble phase (not capture) so the click the user aimed at — a session row, a
   * new-session button — still runs before the drawer closes; the old 140ms
   * delay existed only to let that happen and is gone.
   */
  const onClick = (event) => {
    if (!surface) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest(BUTTON)) return;
    if (computeState() !== 'drawer') return;
    if (!inSidebar(target)) return; // outside taps are handled on pointerdown
    // The official collapse button toggles the layout itself; its attribute
    // change is what puts us back into "hidden".
    if (target.closest(SEL.toggle)) return;
    // A menu trigger (the account "more" button, etc.) opens a portal popover
    // anchored to itself. Closing the drawer here would hide the anchor and the
    // popover would fall back to the top-left corner.
    if (target.closest('[aria-haspopup="menu"]') || target.closest('[role="menu"]')) return;
    // A workspace header only expands/collapses its session list. Treating
    // that tap as "picked something" closed the drawer before the list could
    // be used; row actions are buttons and still close it.
    if (target.closest('[data-row-key^="workspace:"]') && !target.closest('button, [role="button"]')) return;
    hide();
  };

  /**
   * Taps outside the sidebar.
   *
   * Pointerdown, so the drawer is gone before the tap lands on whatever was
   * underneath (a session in the conversation, the mask, the composer).
   */
  const onPointerDown = (event) => {
    if (!surface) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest(BUTTON)) return;
    if (inSidebar(target)) return;
    // Overlays a sidebar button opened (the account menu, the settings dialog)
    // portal to `document.body`, so they are not inside the sidebar column. A
    // real tap is pointerdown … pointerup one frame apart: closing the drawer
    // here would hide the anchor, drop the overlay to the top-left corner and
    // move the click off the item, so the overlay never works. The click-phase
    // rules cannot stand in for this — by then the target is `body`.
    if (target.closest(PORTAL_OVERLAY)) return;
    hide();
  };

  const observer = new MutationObserver((records) => {
    // Collapse-attribute flips are the common case and are cheap to handle;
    // anything else (shell mount, column replacement, resize handles appearing)
    // is throttled to one frame.
    const stable = frame && frame.isConnected;
    if (stable && records.every((record) => record.type === 'attributes')) {
      if (records.some((record) => record.attributeName === COLLAPSED)) sync();
      return;
    }
    scheduleSync();
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: [COLLAPSED],
    childList: true,
    subtree: true,
  });

  const media = window.matchMedia(MOBILE_MEDIA);
  const onMediaChange = () => sync();
  media.addEventListener('change', onMediaChange);

  document.addEventListener('click', onClick);
  document.addEventListener('pointerdown', onPointerDown, true);
  sync();

  return {
    getState: computeState,
    isMobile: () => surface,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle,
    hide,
    /** Read-only facts for the diagnostics page (P3). */
    diagnostics: () => ({
      surface,
      state: computeState(),
      marked: {
        frame: Boolean(frame),
        sidecol: document.querySelectorAll(`[${MARK.sidecol}]`).length,
        center: document.querySelectorAll(`[${MARK.center}]`).length,
        rightcol: document.querySelectorAll(`[${MARK.rightcol}]`).length,
      },
      selectors: Object.fromEntries(
        Object.entries(SEL).map(([name, selector]) => [name, document.querySelectorAll(selector).length]),
      ),
    }),
    dispose() {
      document.removeEventListener('click', onClick);
      document.removeEventListener('pointerdown', onPointerDown, true);
      media.removeEventListener('change', onMediaChange);
      observer.disconnect();
      listeners.clear();
    },
  };
}

/** The one glyph: three lines, stroked in the inherited text colour. */
function menuIcon() {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  return React.createElement('svg', common, [
    React.createElement('line', { key: 'a', x1: 4, y1: 6, x2: 16, y2: 6 }),
    React.createElement('line', { key: 'b', x1: 4, y1: 10, x2: 16, y2: 10 }),
    React.createElement('line', { key: 'c', x1: 4, y1: 14, x2: 16, y2: 14 }),
  ]);
}

/**
 * The sidebar entry point: the first item of the conversation header's leading
 * seat (`conversation.header.leading`), registered by the entry.
 *
 * 40x40 transparent hot zone around a 20x20 glyph, no fill and no border, so it
 * reads as part of the official header in both themes. Rendered only on the
 * mobile surface, which is what keeps a desktop browser untouched.
 */
function makeMenuButton(t, sidebar) {
  return function MenuButton() {
    const [state, setState] = React.useState(sidebar.getState);
    const [visible, setVisible] = React.useState(sidebar.isMobile);

    React.useEffect(
      () =>
        sidebar.subscribe((next) => {
          setState(next);
          setVisible(sidebar.isMobile());
        }),
      [],
    );

    if (!visible) return null;
    const label = state === 'drawer' ? t('navDrawer') : t('navHidden');
    return React.createElement(
      'button',
      {
        type: 'button',
        className: 'dshm-menu',
        'data-dshm-toggle': 'menu',
        'aria-label': label,
        title: label,
        onClick: () => sidebar.toggle(),
      },
      menuIcon(),
    );
  };
}

return { installSidebar, makeMenuButton, SEL, MARK };
  },
});
