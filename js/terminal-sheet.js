// Terminal confirmation — the confirm sheet (R1; plan §2.2, §3.2).
//
// ONE component, host-driven. It renders a VIEW the host derives from its
// own state and reports the passenger's acts back: a row tap, Confirm, Skip,
// a dismissal (slide, ✕, backdrop, Escape). It decides nothing about
// selection, navigation or quotes — those live in indexMVP's per-selection
// lifecycle record. Create mode ships in R1; the edit mode of the same sheet
// (pending-edit staging, plan §2.6) is a later release.
//
// House bottom-sheet pattern (js/passenger-modal.js values): dimmed backdrop
// rgba(0,0,0,0.7), #2C2C2E panel, max-width 576px, 20px top radius.
// A softened entrance and settle; direct finger tracking on the grip or the
// title row; release past DISMISS_DISTANCE_PX or a fast flick closes,
// otherwise it snaps back (`dragOutcome` is the pure rule). Accessibility as
// the traveler dialog in js/pending-edit-card.js: role="dialog", aria-modal,
// labelled title, Tab/Shift+Tab cycle inside the enabled controls, Escape
// closes, the page behind is inert while the sheet is open.
//
// Nothing here is a quote surface: no price, no network. The only network
// call a row tap causes is the coordinates lookup every selection already
// makes, and it is made by the autocomplete, not by this file.
//
// Loaded as a classic script (global TerminalSheet) and required by tests.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TerminalSheet = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The passenger-facing words. The When reminder (indexMVP) reads the same
  // table, so the sheet and the reminder can never disagree.
  const COPY = Object.freeze({
    title: Object.freeze({ pickup: 'Confirm pickup terminal', dropoff: 'Confirm drop-off terminal' }),
    role: Object.freeze({ pickup: 'Pickup', dropoff: 'Drop-off' }),
    reminder: Object.freeze({
      pickup: 'Check this is the terminal your ship docks at.',
      dropoff: 'Check this matches your latest cruise instructions.'
    }),
    superseded: 'Google resolved this address to a different place. Pick a terminal, or close to keep the address.',
    confirm: 'Confirm terminal',
    skip: 'Skip',
    close: 'Close',
    selected: 'Selected',
    checking: 'Checking…'
  });

  const DISMISS_DISTANCE_PX = 80;      // release this far down: close
  const FLICK_VELOCITY = 0.6;          // px per ms (~600 px/s): a flick closes…
  const FLICK_MIN_DISTANCE_PX = 24;    // …once it has travelled somewhere
  const CLOSE_ANIMATION_MS = 300;     // fallback: CSS exits in 240ms; transitionend normally removes it first

  // Pure: what releasing a drag does. `dy` is the downward travel in px,
  // `velocity` the recent release speed in px/ms.
  function dragOutcome(dy, velocity) {
    if (!(dy > 0)) return 'snap';
    if (dy >= DISMISS_DISTANCE_PX) return 'close';
    if (velocity >= FLICK_VELOCITY && dy >= FLICK_MIN_DISTANCE_PX) return 'close';
    return 'snap';
  }

  function sideOf(view) {
    return view && view.side === 'dropoff' ? 'dropoff' : 'pickup';
  }

  // "PortMiami Terminal V" -> "Terminal V" under the port's own subtitle.
  function shortName(registry, terminal) {
    const port = registry && registry.port && typeof registry.port.name === 'string' ? registry.port.name : '';
    return port && terminal.name.startsWith(port + ' ') ? terminal.name.slice(port.length + 1) : terminal.name;
  }

  function companiesLine(registry, terminal) {
    const byKey = registry && registry.companyByKey ? registry.companyByKey : {};
    return (terminal.companies || [])
      .map((key) => (Object.prototype.hasOwnProperty.call(byKey, key) ? byKey[key].name : null))
      .filter(Boolean)
      .join(' · ');
  }

  // What the sheet lists: every verified terminal, in registry order.
  function terminalRows(registry) {
    if (!registry || !Array.isArray(registry.verified)) return [];
    return registry.verified.map((terminal) => ({
      terminalId: terminal.id,
      placeId: terminal.placeId,
      name: shortName(registry, terminal),
      fullName: terminal.name,
      companies: companiesLine(registry, terminal)
    }));
  }

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function on(node, type, handler) {
    if (node && typeof node.addEventListener === 'function') node.addEventListener(type, handler);
  }

  // host: { onRowTap(terminalId), onConfirm(), onSkip(), onDismiss() }
  // options.now: injectable clock for the drag rule (tests).
  function create({ document: doc, host, now } = {}) {
    if (!doc || !host) throw new Error('TerminalSheet.create needs a document and a host');
    const clock = typeof now === 'function' ? now : () => Date.now();
    const win = doc.defaultView;
    const reducedMotion = () => !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let sheet = null;      // the open sheet's nodes and view
    let closing = null;    // an overlay still animating out

    function isOpen() { return sheet !== null; }

    function focusables() {
      if (!sheet) return [];
      const ring = [sheet.close];
      sheet.rows.forEach((row) => ring.push(row.button));
      ring.push(sheet.confirm, sheet.skip);
      return ring.filter((control) => control && !control.disabled && typeof control.focus === 'function');
    }

    function keyHandler(e) {
      if (!e || !sheet) return;
      if (e.key === 'Escape') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        host.onDismiss();
        return;
      }
      if (e.key === 'Tab') {
        const ring = focusables();
        if (!ring.length) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        const i = ring.indexOf(doc.activeElement);
        const next = i === -1
          ? (e.shiftKey ? ring[ring.length - 1] : ring[0])
          : ring[(i + (e.shiftKey ? -1 : 1) + ring.length) % ring.length];
        next.focus();
      }
    }

    // ---- drag-to-dismiss (grip and title row; the ✕ is a tap) ----
    function panelOffset(panel) {
      if (!win || !win.getComputedStyle) return 0;
      const transform = win.getComputedStyle(panel).transform;
      const match = /^matrix(3d)?\(([^)]+)\)$/.exec(transform);
      if (!match) return 0;
      return Number(match[2].split(',')[match[1] ? 13 : 5]) || 0;
    }
    function startDrag(e) {
      if (!sheet || sheet.drag || !e || e.target === sheet.close || e.isPrimary === false || (e.button != null && e.button !== 0)) return;
      const y = e.clientY;
      if (typeof y !== 'number') return;
      // Catch an entrance/snap where it actually is, never jump to zero.
      const offset = panelOffset(sheet.panel);
      sheet.drag = { pointerId: e.pointerId, target: e.currentTarget, startY: y, offset, dy: 0,
        samples: [{ y, at: clock() }] };
      sheet.overlay.classList.add('active', 'dragging');
      sheet.panel.classList.add('dragging');
      sheet.panel.classList.remove('settling');
      sheet.panel.style.transform = 'translateY(' + offset + 'px)';
      const target = e.currentTarget;
      if (target && typeof target.setPointerCapture === 'function' && e.pointerId != null) {
        try { target.setPointerCapture(e.pointerId); } catch (_) { /* capture is a courtesy */ }
      }
    }
    function ownsDrag(e) {
      return sheet && sheet.drag && e && e.currentTarget === sheet.drag.target &&
        (e.pointerId == null || e.pointerId === sheet.drag.pointerId);
    }
    function moveDrag(e) {
      if (!ownsDrag(e) || typeof e.clientY !== 'number') return;
      const drag = sheet.drag;
      drag.dy = Math.max(0, e.clientY - drag.startY);
      const offset = Math.max(0, drag.offset + e.clientY - drag.startY);
      const at = clock();
      drag.samples.push({ y: e.clientY, at });
      // Keep only the recent window, including after sparse pointer events.
      // A lone fresh sample means zero measured velocity, not a guessed flick.
      while (drag.samples.length > 1 && drag.samples[0].at < at - 100) drag.samples.shift();
      sheet.panel.style.transform = 'translateY(' + offset + 'px)';
      const height = sheet.panel.offsetHeight || 600;
      sheet.overlay.style.setProperty('--terminal-dim', String(0.7 * (1 - Math.min(1, offset / height) * 0.6)));
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    function endDrag(e, cancelled = false) {
      if (!ownsDrag(e)) return;
      if (!cancelled && typeof e.clientY === 'number') moveDrag(e);
      const drag = sheet.drag;
      sheet.drag = null;
      sheet.overlay.classList.remove('dragging');
      sheet.panel.classList.remove('dragging');
      sheet.overlay.style.removeProperty('--terminal-dim');
      if (drag.target && typeof drag.target.releasePointerCapture === 'function' && drag.pointerId != null) {
        try { drag.target.releasePointerCapture(drag.pointerId); } catch (_) { /* already released */ }
      }
      const first = drag.samples[0];
      const last = drag.samples[drag.samples.length - 1];
      const velocity = (last.y - first.y) / Math.max(1, last.at - first.at);
      if (!cancelled && dragOutcome(drag.dy, velocity) === 'close') {
        host.onDismiss();
      } else {
        sheet.panel.classList.add('settling');
        sheet.panel.style.transform = '';
      }
    }
    function bindDrag(node) {
      on(node, 'pointerdown', startDrag);
      on(node, 'pointermove', moveDrag);
      on(node, 'pointerup', endDrag);
      on(node, 'pointercancel', (e) => endDrag(e, true));
      on(node, 'lostpointercapture', (e) => endDrag(e, true));
    }

    function removeClosing(expected = closing) {
      if (!closing || closing !== expected) return;
      const node = closing.overlay;
      if (typeof clearTimeout === 'function') clearTimeout(closing.timer);
      if (typeof closing.panel.removeEventListener === 'function') closing.panel.removeEventListener('transitionend', closing.onEnd);
      closing = null;
      if (typeof node.remove === 'function') node.remove();
      else if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node);
    }

    // view: { side, registry, selectedPlaceId, settlingPlaceId, superseded }
    // options.inert: the element behind the sheet (aria-hidden + inert while open)
    function open(view, options = {}) {
      if (sheet) { render(view); return; }
      removeClosing();
      const overlay = el(doc, 'div', 'terminal-sheet-overlay');
      const panel = el(doc, 'div', 'terminal-sheet-panel');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-labelledby', 'terminalSheetTitle');

      const grip = el(doc, 'div', 'terminal-sheet-grip');
      grip.appendChild(el(doc, 'div', 'terminal-sheet-handle'));
      const header = el(doc, 'div', 'terminal-sheet-header');
      const title = el(doc, 'h2', 'terminal-sheet-title');
      title.id = 'terminalSheetTitle';
      const close = el(doc, 'button', 'terminal-sheet-close', '✕');
      close.type = 'button';
      close.setAttribute('aria-label', COPY.close);
      on(close, 'click', () => host.onDismiss());
      header.appendChild(title);
      header.appendChild(close);
      const port = el(doc, 'div', 'terminal-sheet-port');

      const list = el(doc, 'div', 'terminal-sheet-list');
      const rows = new Map();
      terminalRows(view.registry).forEach((row) => {
        const button = el(doc, 'button', 'terminal-sheet-row');
        button.type = 'button';
        if (button.dataset) button.dataset.terminal = row.terminalId;
        button.setAttribute('data-terminal', row.terminalId);
        button.setAttribute('aria-pressed', 'false');
        const name = el(doc, 'span', 'terminal-sheet-row-name', row.name);
        const companies = el(doc, 'span', 'terminal-sheet-row-company', row.companies);
        const mark = el(doc, 'span', 'terminal-sheet-row-mark', '');
        button.appendChild(name);
        button.appendChild(companies);
        button.appendChild(mark);
        on(button, 'click', () => host.onRowTap(row.terminalId));
        list.appendChild(button);
        rows.set(row.terminalId, { button, mark, placeId: row.placeId, terminalId: row.terminalId });
      });

      const note = el(doc, 'p', 'terminal-sheet-note');
      const confirm = el(doc, 'button', 'terminal-sheet-confirm', COPY.confirm);
      confirm.type = 'button';
      on(confirm, 'click', () => { if (!confirm.disabled) host.onConfirm(); });
      const skip = el(doc, 'button', 'terminal-sheet-skip', COPY.skip);
      skip.type = 'button';
      on(skip, 'click', () => { if (!skip.disabled) host.onSkip(); });

      panel.appendChild(grip);
      panel.appendChild(header);
      panel.appendChild(port);
      panel.appendChild(list);
      panel.appendChild(note);
      panel.appendChild(confirm);
      panel.appendChild(skip);
      overlay.appendChild(panel);
      // The backdrop itself closes; a tap inside the panel never bubbles
      // out as a dismissal.
      on(overlay, 'click', (e) => { if (e && e.target === overlay) host.onDismiss(); });
      on(panel, 'click', (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); });
      bindDrag(grip);
      bindDrag(header);

      const inert = options.inert || null;
      if (inert) {
        if (typeof inert.setAttribute === 'function') inert.setAttribute('aria-hidden', 'true');
        inert.inert = true;
      }
      if (typeof doc.addEventListener === 'function') doc.addEventListener('keydown', keyHandler);
      doc.body.appendChild(overlay);

      sheet = { overlay, panel, grip, header, title, port, list, rows, note, confirm, skip, close, view: null, inert, drag: null };
      render(view);

      // Enter at the row the passenger just picked, even while checking,
      // so the entrance never presents the top of the list as their choice.
      const focusId = view.settlingPlaceId || (!view.superseded && view.selectedPlaceId);
      const marked = focusId ? [...rows.values()].find((row) => row.placeId === focusId) : null;
      const first = marked ? marked.button : (rows.size ? rows.values().next().value.button : close);
      if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
      // Only the list scrolls to reveal the initial choice. The page and
      // action dock stay still; later renders never fight manual scrolling.
      if (first && first.getBoundingClientRect && list.getBoundingClientRect) {
        const rowRect = first.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom;
        else if (rowRect.top < listRect.top) list.scrollTop -= listRect.top - rowRect.top;
      }

      // .active a frame later so the slide/fade transitions actually run.
      const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn) => (typeof setTimeout === 'function' ? setTimeout(fn, 10) : fn());
      // Flush the initial off-screen transform before activating it. One
      // rAF alone can be coalesced with insertion and lose the entrance.
      if (panel.getBoundingClientRect) panel.getBoundingClientRect();
      if (reducedMotion()) overlay.classList.add('active');
      else raf(() => { if (sheet && sheet.overlay === overlay) overlay.classList.add('active'); });
    }

    // Everything visible derives from the view: the marked row, the row
    // that is checking, the note, and whether Confirm/Skip are usable.
    function render(view) {
      if (!sheet || !view) return;
      sheet.view = view;
      const side = sideOf(view);
      sheet.title.textContent = COPY.title[side];
      sheet.port.textContent = view.registry && view.registry.port ? view.registry.port.name : '';
      const selectedPlaceId = view.superseded ? null : (view.selectedPlaceId || null);
      const settlingPlaceId = view.settlingPlaceId || null;
      let marked = false;
      sheet.rows.forEach((row) => {
        const selected = selectedPlaceId !== null && row.placeId === selectedPlaceId;
        const checking = settlingPlaceId !== null && row.placeId === settlingPlaceId;
        if (selected) marked = true;
        row.button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        row.button.classList.toggle('is-selected', selected);
        row.button.classList.toggle('is-checking', checking);
        row.mark.textContent = checking ? COPY.checking : (selected ? COPY.selected : '');
      });
      sheet.note.textContent = view.superseded ? COPY.superseded : COPY.reminder[side];
      // Disabled from the instant a row is tapped until that selection
      // settles; Confirm also needs a marked row to confirm.
      const settling = settlingPlaceId !== null;
      sheet.confirm.disabled = settling || !marked;
      sheet.skip.disabled = settling;
    }

    function close() {
      if (!sheet) return;
      const closed = sheet;
      sheet = null;
      if (typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', keyHandler);
      if (closed.inert) {
        if (typeof closed.inert.removeAttribute === 'function') closed.inert.removeAttribute('aria-hidden');
        closed.inert.inert = false;
      }
      closed.panel.classList.remove('dragging', 'settling');
      closed.overlay.classList.remove('dragging');
      closed.overlay.inert = true;
      closed.panel.removeAttribute('aria-modal');
      closed.panel.style.transform = 'translateY(100%)';
      closed.overlay.classList.remove('active');
      closed.overlay.classList.add('closing');
      removeClosing();
      const exit = { overlay: closed.overlay, panel: closed.panel, timer: null,
        onEnd: (e) => { if (e.target === closed.panel && e.propertyName === 'transform') removeClosing(exit); } };
      closing = exit;
      on(closed.panel, 'transitionend', exit.onEnd);
      if (reducedMotion()) removeClosing(exit);
      else if (typeof setTimeout === 'function') exit.timer = setTimeout(() => removeClosing(exit), CLOSE_ANIMATION_MS);
      else removeClosing(exit);
    }

    // For the host's focus management and for tests.
    function elements() {
      return sheet ? { overlay: sheet.overlay, panel: sheet.panel, grip: sheet.grip, header: sheet.header,
        title: sheet.title, note: sheet.note, confirm: sheet.confirm, skip: sheet.skip, close: sheet.close,
        rows: sheet.rows, view: sheet.view } : null;
    }

    return { open, render, close, isOpen, elements };
  }

  return {
    COPY,
    DISMISS_DISTANCE_PX,
    FLICK_VELOCITY,
    FLICK_MIN_DISTANCE_PX,
    dragOutcome,
    terminalRows,
    create
  };
}));
