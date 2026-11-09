/**
 * dsh-mobile: presentation only.
 *
 * Core (dsh 0.2.2+) owns the page layout: the mobile drawer, the 768–1024 rail,
 * the fullscreen right panel, the settings nav and the question card. This
 * stylesheet only dresses what this plugin still owns: the notification pill,
 * its settings page, the diagnostics report, and two small input fixes that are
 * genuinely absent from core.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  chunk: 'client.styles.js',

  factory() {
const CSS = `
/* Input/UX fixes that core does not apply globally. Kept deliberately small:
   the plugin must not own layout breakpoints or viewport geometry again. */
@media (pointer: coarse) {
  input, textarea, select,
  .dshm-input, .dshm-select { font-size: 16px; }
  button, [role="button"], a { touch-action: manipulation; }
}

/* Notification / HTTPS pill. Shown on every viewport: on a desktop browser the
   most common blocker is a plain-HTTP origin, and hiding the hint on wide
   screens is exactly what made "no notifications" look like a broken plugin. */
.dshm-notify {
  position: fixed;
  right: 12px;
  top: 92px;
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
`;

function installStyles() {
  const style = document.createElement('style');
  style.setAttribute('data-plugin', 'dsh-mobile');
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}

return { installStyles };
  },
});
