/**
 * dsh-mobile: presentation only.
 *
 * One stylesheet for the whole plugin: the mobile skin (sidebar states, right
 * panel, safes, dialogs, question card), the notification pill, and the settings
 * page. Kept in its own chunk because it is the largest part of the client code
 * and changes for purely cosmetic reasons.
 *
 * Scoped rules are the only ones that touch Harness layout; see the comments in
 * the sheet for which state each block owns.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  chunk: 'client.styles.js',

  factory() {
const CSS = `
@media (max-width: 640px) {
  html, body {
    overscroll-behavior-y: none;
    -webkit-tap-highlight-color: transparent;
  }
  html, body, #root {
    height: 100vh;
    height: 100dvh;
  }

  /* Bottom seat keeps clear of the home indicator. */
  [data-shell-bottom] {
    padding-bottom: env(safe-area-inset-bottom);
  }

  /* Right panel overlays the whole viewport when open. */
  [data-dshm-frame]:not([data-rightbar-collapsed]) [data-dshm-rightcol] {
    position: fixed;
    inset: 0;
    z-index: 60;
    width: 100vw !important;
    background: var(--dsw-alias-bg-base);
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
  [data-dshm-rightcol] > * {
    width: 100%;
    max-width: 100%;
  }


  /* Full-bleed dialogs and 16px inputs (avoids the mobile zoom on focus). */
  [role="dialog"] {
    max-width: 100vw !important;
    max-height: 100dvh !important;
  }

  /* Settings: the desktop side nav becomes a horizontal, scrollable strip so
     the settings rows keep their full usable width. */
  [role="dialog"]:has(> nav) {
    flex-direction: column;
  }
  [role="dialog"] > nav {
    width: 100% !important;
    height: auto !important;
    flex: none;
    border-right: 0 !important;
    border-bottom: 1px solid var(--dsw-alias-border-1);
  }
  [role="dialog"] > nav > div:first-child { display: none; }
  [role="dialog"] > nav > div:last-child {
    flex-direction: row !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    gap: 4px;
    padding: 2px 8px 6px;
    -webkit-overflow-scrolling: touch;
  }
  [role="dialog"] > nav button {
    flex: 0 0 auto;
    width: auto !important;
  }
  [role="dialog"] > nav button > span { white-space: nowrap; }
  [role="dialog"] > nav + div {
    width: 100% !important;
    min-width: 0;
    flex: 1 1 auto;
    min-height: 0;
  }
  input, textarea, select, [contenteditable="true"], [role="textbox"] { font-size: 16px; }

  button, [role="button"], a { touch-action: manipulation; }

  /* User-question card: the desktop header puts the heading and the action
     cluster side by side. On a phone the actions win that fight and the heading
     collapses to one character per line, so stack them and let the footer
     controls wrap instead of being clipped. Scoped by the card's own
     data-question-key attribute, not by the hashed class of a single copy. */
  [data-question-key] { padding: 6px 8px 10px !important; }
  /* The composer keeps a 60vh cap meant for desktop; on a phone the seat is
     pinned to the bottom, so lift the cap enough for the footer to stay
     reachable while the body still scrolls. Minimized cards keep their own
     uncapped height. */
  [data-question-key] [class*="_card"]:not([class*="Minimized"]) {
    max-height: min(72dvh, 620px);
    /* Flex items keep a min-content floor by default; the card would then
       refuse to shrink and spill past the viewport edge. */
    min-width: 0;
  }
  [data-question-key] [class*="_header"]:not([class*="_headerActions"]) {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 14px 12px 0;
  }
  [data-question-key] [class*="_headingBlock"] {
    width: 100%;
    min-width: 0;
  }
  [data-question-key] [class*="_title"] {
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
    overflow-wrap: anywhere;
  }
  [data-question-key] [class*="_headerActions"] {
    width: 100%;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 6px;
  }
  [data-question-key] [class*="_waitStatus"] { white-space: normal; }
  [data-question-key] [class*="_footer"]:not([class*="_footerActions"]) {
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 8px calc(10px + env(safe-area-inset-bottom));
  }
  [data-question-key] [class*="_footerActions"] {
    margin-left: auto;
    flex-wrap: wrap;
  }
  [data-question-key] [class*="_feedback"] {
    flex-basis: 100%;
    text-align: left;
  }
  [data-question-key] [class*="_options"] { padding: 4px 8px; }
}

/* Notification / HTTPS pill. Shown on every viewport: on a desktop browser the
   most common blocker is a plain-HTTP origin, and hiding the hint on wide
   screens is exactly what made "no notifications" look like a broken plugin. */
.dshm-notify {
  position: fixed;
  right: 12px;
  top: calc(env(safe-area-inset-top) + 92px);
  z-index: 90;
  display: inline-flex;
  white-space: nowrap;
  max-width: calc(100vw - 24px);
  align-items: center;
  gap: 6px;
  padding: 9px 13px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-1);
  background: var(--dsw-alias-bg-elevated, rgba(32, 32, 32, 0.86));
  color: var(--dsw-alias-text-1, #fff);
  font-size: 13px;
  line-height: 1;
  box-shadow: 0 6px 20px rgb(0 0 0 / 24%);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  pointer-events: auto;
  cursor: pointer;
}
.dshm-notify:active { transform: scale(0.97); }
@media (prefers-color-scheme: light) {
  .dshm-notify { background: var(--dsw-alias-bg-elevated, #fff); color: var(--dsw-alias-text-1, #1a1a1a); }
}

/* Settings page: one narrow column, DSH-native tokens, no hard-coded palette. */
.dshm-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  max-width: 760px;
  min-width: 0;
  margin: 0 auto;
  padding: 4px 24px 32px;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary, #0f1115);
}
.dshm-head { display: flex; flex-direction: column; gap: 2px; padding: 12px 0 2px; }
.dshm-title { font-size: 14px; line-height: 22px; }
.dshm-desc { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-secondary, #61666b); }
.dshm-card {
  border: 1px solid var(--dsw-alias-border-1, rgba(127, 127, 127, 0.16));
  border-radius: 12px;
  background: var(--dsw-alias-bg-elevated, transparent);
  padding: 12px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dshm-cardHead { font-size: 13px; line-height: 20px; font-weight: 500; }
.dshm-row { display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; }
.dshm-rowLabel { flex: 1 1 200px; min-width: 0; font-size: 13px; line-height: 20px; }
.dshm-rowHint { flex-basis: 100%; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-secondary, #61666b); }
.dshm-check { display: flex; align-items: center; gap: 8px; font-size: 13px; line-height: 22px; cursor: pointer; }
.dshm-input, .dshm-select {
  font: inherit;
  font-size: 13px;
  height: 30px;
  padding: 0 10px;
  min-width: 0;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-1, rgba(127, 127, 127, 0.24));
  background: var(--dsw-alias-bg-input, transparent);
  color: inherit;
}
.dshm-input { flex: 1 1 220px; }
.dshm-inputSmall { flex: 0 0 96px; }
.dshm-btn {
  appearance: none;
  height: 30px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-1, rgba(127, 127, 127, 0.24));
  background: var(--dsw-alias-bg-elevated, transparent);
  color: inherit;
  white-space: nowrap;
}
.dshm-btn:disabled { opacity: 0.45; cursor: default; }
.dshm-btnPrimary {
  background: var(--dsw-alias-label-primary, #0f1115);
  /* The inverted twin of label-primary; using bg-elevated here made a
     white-on-white button in the light theme. */
  color: var(--dsw-alias-label-primary-inverted, #fff);
  border-color: transparent;
}
.dshm-note { font-size: 11px; line-height: 17px; }
.dshm-ok { color: var(--dsw-alias-state-success-primary, #0a6b3d); }
.dshm-bad { color: var(--dsw-alias-state-error-primary, #a12a2a); }
@media (max-width: 640px) {
  .dshm-page { padding: 4px 12px 24px; }
  .dshm-input { flex-basis: 100%; }
}

/* Diagnostics: a read-only report, monospaced and scrollable so a phone can
   still copy it in one tap. */
.dshm-diag { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dshm-report {
  margin: 0;
  padding: 10px 12px;
  max-height: 46dvh;
  overflow: auto;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-1, rgba(127, 127, 127, 0.16));
  background: var(--dsw-alias-bg-input, rgba(127, 127, 127, 0.06));
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 17px;
  white-space: pre;
  -webkit-overflow-scrolling: touch;
  user-select: text;
  min-width: 0;
}
.dshm-problems {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 19px;
  color: var(--dsw-alias-state-error-primary, #a12a2a);
}

/* Entry point for the settings page from the notification pill. */
.dshm-gear {
  pointer-events: auto;
  margin-left: 6px;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-1, rgba(127, 127, 127, 0.24));
  background: transparent;
  color: inherit;
  font-size: 11px;
  line-height: 22px;
  cursor: pointer;
}

/* ---- mobile sidebar surface ------------------------------------------------
   Scoped by the marker client.sidebar.js writes, so a desktop browser
   (> 1024px, no shell) sees none of this. The two states are derived from the
   official data-sidebar-collapsed attribute: collapsed is hidden, expanded is
   the drawer. */
body[data-dshm-surface="mobile"] [data-dshm-frame] [data-dshm-center] { grid-column: 2; }
body[data-dshm-surface="mobile"] [data-dshm-frame] [data-dshm-rightcol] { grid-column: 3; }

/* The sidebar column never takes layout width — it is either hidden or fixed
   above the conversation. The conversation header keeps its own natural
   position: the menu button lives in the header's leading seat, which the
   header already sizes by content. */
body[data-dshm-surface="mobile"] [data-dshm-frame] {
  grid-template-columns: 0 minmax(0, 1fr) 0 !important;
}
body[data-dshm-surface="mobile"]
  [data-dshm-frame][data-sidebar-collapsed] [data-dshm-sidecol] {
  display: none !important;
}

/* Drawer: the sidebar covers the conversation and the frame paints the mask. */
body[data-dshm-surface="mobile"]
  [data-dshm-frame]:not([data-sidebar-collapsed]) [data-dshm-sidecol] {
  position: fixed;
  inset: 0;
  z-index: 45;
  width: 100vw !important;
  max-width: 100vw;
  height: 100dvh;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base);
  border-right: 0;
  box-shadow: none;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
}
body[data-dshm-surface="mobile"]
  [data-dshm-frame]:not([data-sidebar-collapsed]) [data-dshm-sidecol] > * {
  width: 100% !important;
  max-width: none;
  box-sizing: border-box;
}
body[data-dshm-surface="mobile"] [data-dshm-frame]:not([data-sidebar-collapsed])::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 44;
  background: rgb(0 0 0 / 32%);
}

/* Resize handles are pointer-only; the marker is set by client.sidebar.js as
   soon as the drawer mounts its columns. */
body[data-dshm-surface="mobile"] [data-dshm-handle] { display: none !important; }

/* The shell's overlay layer is painted under the drawer by default; it still
   carries the notification pill (the shell.overlay registration, fixed and
   self-positioned), which should stay readable while the drawer is open. */
body[data-dshm-surface="mobile"] [data-shell-overlay] { z-index: 46; }

/* Header menu button: the leading seat of the conversation header. A 40x40
   transparent hot zone around a 20x20 glyph — no fill, no border, no shadow, so
   it reads as part of the official header. The colour is inherited from the
   header's own label token, which is what makes light and dark mode free. */
body[data-dshm-surface="mobile"] .dshm-menu {
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
body[data-dshm-surface="mobile"] .dshm-menu:active {
  background: var(--dsw-alias-interactive-bg-hover);
}
body[data-dshm-surface="mobile"] .dshm-menu svg { width: 20px; height: 20px; }

/* Wide markdown tables. The shell tags 4+ column tables with md-table-wide and
   keeps their horizontal overflow hidden until :hover / :focus-visible reveals
   it. A touch screen produces neither before the table is used, so the table is
   clipped mid-column and reads as broken. Restore swiping on the mobile surface
   only; the desktop hover behaviour is left untouched. */
body[data-dshm-surface="mobile"] .md-table-wide {
  overflow-x: auto !important;
  padding-bottom: 0;
  -webkit-overflow-scrolling: touch;
}
`;

function installStyles() {
  const style = document.createElement('style');
  style.setAttribute('data-plugin', 'dsh-mobile');
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}

function ensureViewportFit() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  if (!/viewport-fit/.test(meta.content)) meta.content = `${meta.content}, viewport-fit=cover`;
}

return { installStyles, ensureViewportFit };
  },
});
