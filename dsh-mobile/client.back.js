/**
 * dsh-mobile: the global mobile escape hatch.
 *
 * A phone has no browser back button inside a full-screen panel, and some
 * surfaces (the plugin manager, the settings dialog, a right panel) leave the
 * conversation without an obvious way home. This chunk owns one fixed button
 * that goes back exactly one layer:
 *
 *   dialog / menu -> drawer -> right panel -> plugin panel -> conversation
 *
 * It lives at `document.body` level on purpose. The settings dialog is portalled
 * to the body above the shell's overlay layer, so a slot-registered element
 * inside the frame cannot cover it; a body-level node is the only placement that
 * can stay visible on every mobile surface. It adds exactly one node and removes
 * it again on dispose; it never edits DSH's React tree or another plugin's DOM.
 *
 * Every decision is derived from official state where one exists:
 *   - ctx.layout.panelInfo  : which global main panel is open
 *   - ctx.layout.selectPanel: return to the conversation
 *   - ctx.layout.closeRightbar / sidebar.hide(): the other two layers
 *   - the document's modal selector: dialogs and popovers are closed with
 *     Escape, which is the same path their own modal layer listens to.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  chunk: 'client.back.js',

  factory() {
/** The modal/popover surfaces DSH itself treats as a layer (see useModalLayer). */
const LAYER_SELECTOR = '[role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"]';
/** Only a real modal makes the button appear; a transient menu does not. */
const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';

/** Is the button needed at all, and on this viewport? */
function shouldShow(state) {
  if (!state.mobile) return false;
  return Boolean(state.dialog || state.panel || state.drawer || state.rightbar || !state.conversation);
}

/**
 * Which layer a tap should close: exactly one per tap.
 *
 * Menus share the dialog slot because a popover opened from a page must close
 * before the page itself does.
 */
function nextAction(state) {
  if (state.dialog || state.menu) return 'dialog';
  if (state.drawer) return 'drawer';
  if (state.rightbar) return 'rightbar';
  if (state.panel) return 'panel';
  return 'reset';
}

function isVisible(node) {
  if (!node || node.hidden) return false;
  if (typeof node.getClientRects === 'function') return node.getClientRects().length > 0;
  return node.isConnected !== false;
}

/** The topmost visible dialog/menu, in DOM order. */
function topLayer(doc) {
  const nodes = doc.querySelectorAll(LAYER_SELECTOR);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (isVisible(node)) return node;
  }
  return null;
}

/** A visible modal only; a menu alone must not summon the button. */
function topDialog(doc) {
  const nodes = doc.querySelectorAll(DIALOG_SELECTOR);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (isVisible(node)) return node;
  }
  return null;
}

/** Escape is the modal layer's own close path; never click an arbitrary button. */
function escapeEvent() {
  if (typeof KeyboardEvent !== 'function') return null;
  return new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    which: 27,
    bubbles: true,
    cancelable: true,
  });
}

/**
 * Close the top layer.
 *
 * Escape is dispatched first because every DSH modal listens for it. The
 * fallback only clicks a button that explicitly calls itself close/cancel: the
 * settings dialog's close control has no aria-label, but Escape handles it, and
 * guessing from text would risk clicking a "关闭自动回答" setting instead.
 */
function closeTopLayer(doc) {
  const layer = topLayer(doc);
  if (!layer) return false;
  const event = escapeEvent();
  let handled = false;
  try {
    // A modal layer that consumes Escape calls preventDefault(); in that case
    // the fallback must stay out of the way and not close the dialog twice.
    if (event) handled = doc.dispatchEvent(event) === false;
  } catch (error) {
    console.debug('[dsh-mobile] Escape dispatch failed', error);
  }
  if (!handled && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => {
      if (!isVisible(layer)) return;
      const buttons = layer.querySelectorAll('button');
      for (const candidate of buttons) {
        const name = candidate.getAttribute?.('aria-label') ?? '';
        if (/^(close|关闭|cancel|取消)$/i.test(name.trim())) {
          try {
            candidate.click?.();
          } catch (error) {
            console.debug('[dsh-mobile] dialog close fallback failed', error);
          }
          return;
        }
      }
    });
  }
  return true;
}

/** Install the button and return its lifecycle handle. */
function installBack(ctx, options) {
  const { sidebar, sel, t } = options;
  const doc = document;
  if (!doc?.body) return { dispose() {}, sync() {}, button: null };

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'dshm-back';
  button.setAttribute('data-dshm-back', '');
  button.hidden = true;
  button.textContent = `← ${t('back')}`;
  button.setAttribute('aria-label', t('backHint'));
  doc.body.appendChild(button);

  let disposed = false;
  let scheduled = false;
  // Cold start paints the app before the conversation marker exists. Without
  // this flag the button would flash on the first conversation frame; the grace
  // timer still makes it fail open if the app really opens on an unknown page.
  let conversationSeen = false;
  const grace = setTimeout(() => {
    conversationSeen = true;
    scheduleSync();
  }, 1200);
  grace?.unref?.();

  function readState() {
    const panelInfo = ctx.layout?.panelInfo;
    const activePanelId = panelInfo?.getSnapshot?.().activePanelId ?? null;
    const frame = doc.querySelector(sel.frame);
    return {
      mobile: Boolean(sidebar?.isMobile?.()),
      panel: activePanelId !== null && activePanelId !== undefined,
      dialog: Boolean(topDialog(doc)),
      menu: Boolean(topLayer(doc)),
      drawer: sidebar?.getState?.() === 'drawer',
      rightbar: Boolean(frame && !frame.hasAttribute('data-rightbar-collapsed')),
      conversation: Boolean(doc.querySelector(sel.conversation)),
    };
  }

  function sync() {
    scheduled = false;
    if (disposed) return;
    const state = readState();
    if (state.conversation) conversationSeen = true;
    const unknownPage =
      !state.conversation && !state.dialog && !state.panel && !state.drawer && !state.rightbar;
    button.hidden = !(shouldShow(state) && (conversationSeen || !unknownPage));
    button.textContent = `← ${t('back')}`;
    button.setAttribute('aria-label', t('backHint'));
  }

  function scheduleSync() {
    if (disposed || scheduled) return;
    scheduled = true;
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(sync);
    else window.setTimeout(sync, 0);
  }

  function resetToConversation() {
    ctx.layout?.selectPanel?.(null);
    sidebar?.hide?.();
    ctx.layout?.closeRightbar?.();
  }

  function back() {
    const state = readState();
    switch (nextAction(state)) {
      case 'dialog':
        closeTopLayer(doc);
        break;
      case 'panel':
        ctx.layout?.selectPanel?.(null);
        break;
      case 'drawer':
        sidebar?.hide?.();
        break;
      case 'rightbar':
        ctx.layout?.closeRightbar?.();
        break;
      default:
        resetToConversation();
        break;
    }
    scheduleSync();
  }

  const onClick = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    back();
  };
  button.addEventListener('click', onClick);

  const disposers = [];
  const add = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose);
  };
  add(ctx.layout?.panelInfo?.subscribe?.(scheduleSync));
  add(sidebar?.subscribe?.(scheduleSync));
  add(ctx.locale?.subscribe?.(scheduleSync));

  const media = window.matchMedia?.('(max-width: 1024px)');
  const onMediaChange = () => scheduleSync();
  media?.addEventListener?.('change', onMediaChange);

  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver((records) => {
          // Our own label update is not a navigation event.
          if (records.length > 0 && records.every((record) => record.target === button)) return;
          scheduleSync();
        })
      : null;
  observer?.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'role',
      'aria-modal',
      'hidden',
      'data-sidebar-collapsed',
      'data-rightbar-collapsed',
      'data-conversation-content',
      'data-composer-seat',
    ],
  });

  sync();

  return {
    button,
    sync,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(grace);
      observer?.disconnect();
      media?.removeEventListener?.('change', onMediaChange);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (error) {
          console.debug('[dsh-mobile] back button listener failed to dispose', error);
        }
      }
      button.removeEventListener('click', onClick);
      button.remove();
    },
  };
}

return { installBack, shouldShow, nextAction };
  },
});
