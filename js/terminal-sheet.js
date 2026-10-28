// Terminal confirmation — the confirm sheet (R1; plan §2.2, §3.2; map and
// Uber-style layout added in the follow-up PR, 2026-10-28).
//
// ONE component, host-driven. It renders a VIEW the host derives from its
// own state and reports the passenger's acts back: a row tap, Confirm, Skip,
// a dismissal (slide, ✕, backdrop, Escape), a map-layer choice. It decides
// nothing about selection, navigation, quotes or Google: the host attaches
// the Google map into `elements().mapHost` and draws the pins; this file
// only renders the map AREA's state (loading / ready / unavailable) and the
// Standard | Satellite switch. Create mode ships in R1; the edit mode of the
// same sheet (pending-edit staging, plan §2.6) is a later release.
//
// Layout (after the Uber reference, 2026-10-28): drag grip; header with the
// close control on the left, the title centred and a Skip pill on the
// right; the map area with the layer switch; "PortMiami"; the terminal
// rows; the reminder line; the primary button "Confirm pickup" /
// "Confirm drop-off" fixed at the bottom. House bottom-sheet pattern
// (js/passenger-modal.js values): dimmed backdrop rgba(0,0,0,0.7), #2C2C2E
// panel, max-width 576px, 20px top radius, 0.3s slide. Drag-to-dismiss on
// the grip or the title row only (never the map); release past
// DISMISS_DISTANCE_PX or a fast flick closes, otherwise it snaps back
// (`dragOutcome` is the pure rule). Accessibility as the traveler dialog:
// role="dialog", aria-modal, labelled title, Tab/Shift+Tab cycle inside the
// enabled controls, Escape closes, the page behind is inert while open.
//
// Nothing here is a quote surface: no price, no network of its own.
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
    confirm: Object.freeze({ pickup: 'Confirm pickup', dropoff: 'Confirm drop-off' }),
    skip: 'Skip',
    close: 'Close',
    selected: 'Selected',
    checking: 'Checking…',
    map: Object.freeze({
      loading: 'Loading map…',
      unavailable: 'Map unavailable right now — the list still works.',
      standard: 'Standard',
      satellite: 'Satellite'
    })
  });

  const MAP_TYPES = Object.freeze(['roadmap', 'satellite']);
  const DISMISS_DISTANCE_PX = 80;      // release this far down: close
  const FLICK_VELOCITY = 0.6;          // px per ms (~600 px/s): a flick closes…
  const FLICK_MIN_DISTANCE_PX = 24;    // …once it has travelled somewhere
  const CLOSE_ANIMATION_MS = 300;

  // Pure: what releasing a drag does. `dy` is the downward travel in px,
  // `velocity` the average speed in px/ms.
  function dragOutcome(dy, velocity) {
    if (!(dy > 0)) return 'snap';
    if (dy >= DISMISS_DISTANCE_PX) return 'close';
    if (velocity >= FLICK_VELOCITY && dy >= FLICK_MIN_DISTANCE_PX) return 'close';
    return 'snap';
  }

  function sideOf(view) {
    return view && view.side === 'dropoff' ? 'dropoff' : 'pickup';
  }

  function mapStatusOf(view) {
    const status = view && view.map && view.map.status;
    return status === 'loading' || status === 'ready' || status === 'unavailable' ? status : 'off';
  }

  function mapTypeOf(view) {
    const type = view && view.map && view.map.type;
    return MAP_TYPES.includes(type) ? type : 'roadmap';
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

  // host: { onRowTap(terminalId), onConfirm(), onSkip(), onDismiss(), onMapType(type) }
  // options.now: injectable clock for the drag rule (tests).
  function create({ document: doc, host, now } = {}) {
    if (!doc || !host) throw new Error('TerminalSheet.create needs a document and a host');
    const clock = typeof now === 'function' ? now : () => Date.now();
    let sheet = null;      // the open sheet's nodes and view
    let closing = null;    // an overlay still animating out

    function isOpen() { return sheet !== null; }

    function focusables() {
      if (!sheet) return [];
      const ring = [sheet.close, sheet.skip];
      if (mapStatusOf(sheet.view) === 'ready') ring.push(sheet.mapTypeButtons.roadmap, sheet.mapTypeButtons.satellite);
      sheet.rows.forEach((row) => ring.push(row.button));
      ring.push(sheet.confirm);
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

    // ---- drag-to-dismiss (grip and title row; the controls are taps) ----
    function startDrag(e) {
      if (!sheet || !e || e.target === sheet.close || e.target === sheet.skip) return;
      const y = e.clientY;
      if (typeof y !== 'number') return;
      sheet.drag = { startY: y, startAt: clock(), dy: 0 };
      sheet.panel.classList.add('dragging');
      const target = e.currentTarget;
      if (target && typeof target.setPointerCapture === 'function' && e.pointerId != null) {
        try { target.setPointerCapture(e.pointerId); } catch (_) { /* capture is a courtesy */ }
      }
    }
    function moveDrag(e) {
      if (!sheet || !sheet.drag || !e || typeof e.clientY !== 'number') return;
      const dy = Math.max(0, e.clientY - sheet.drag.startY);
      sheet.drag.dy = dy;
      sheet.panel.style.transform = 'translateY(' + dy + 'px)';
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    function endDrag() {
      if (!sheet || !sheet.drag) return;
      const drag = sheet.drag;
      sheet.drag = null;
      sheet.panel.classList.remove('dragging');
      const elapsed = Math.max(1, clock() - drag.startAt);
      if (dragOutcome(drag.dy, drag.dy / elapsed) === 'close') {
        host.onDismiss();
      } else {
        sheet.panel.style.transform = '';
      }
    }
    function bindDrag(node) {
      on(node, 'pointerdown', startDrag);
      on(node, 'pointermove', moveDrag);
      on(node, 'pointerup', endDrag);
      on(node, 'pointercancel', endDrag);
    }

    function removeClosing() {
      if (!closing) return;
      const node = closing;
      closing = null;
      if (typeof node.remove === 'function') node.remove();
      else if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node);
    }

    // view: { side, registry, selectedPlaceId, settlingPlaceId, superseded,
    //         map: { status: 'loading'|'ready'|'unavailable'|'off', type: 'roadmap'|'satellite' } }
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

      // Header: ✕ on the left, the title centred, Skip as a pill on the right.
      const header = el(doc, 'div', 'terminal-sheet-header');
      const close = el(doc, 'button', 'terminal-sheet-close', '✕');
      close.type = 'button';
      close.setAttribute('aria-label', COPY.close);
      on(close, 'click', () => host.onDismiss());
      const title = el(doc, 'h2', 'terminal-sheet-title');
      title.id = 'terminalSheetTitle';
      const skip = el(doc, 'button', 'terminal-sheet-skip', COPY.skip);
      skip.type = 'button';
      on(skip, 'click', () => { if (!skip.disabled) host.onSkip(); });
      header.appendChild(close);
      header.appendChild(title);
      header.appendChild(skip);

      // Map area: the host attaches the Google map to mapHost; the note
      // carries the loading / unavailable state; the switch picks the layer.
      const mapArea = el(doc, 'div', 'terminal-sheet-map');
      const mapHost = el(doc, 'div', 'terminal-sheet-map-canvas');
      mapHost.setAttribute('aria-hidden', 'true');
      const mapNote = el(doc, 'div', 'terminal-sheet-map-note');
      mapNote.setAttribute('role', 'status');
      const mapTypes = el(doc, 'div', 'terminal-sheet-map-types');
      mapTypes.setAttribute('role', 'group');
      mapTypes.setAttribute('aria-label', 'Map layer');
      const mapTypeButtons = {};
      MAP_TYPES.forEach((type) => {
        const button = el(doc, 'button', 'terminal-sheet-maptype', type === 'roadmap' ? COPY.map.standard : COPY.map.satellite);
        button.type = 'button';
        button.setAttribute('data-map-type', type);
        button.setAttribute('aria-pressed', 'false');
        on(button, 'click', () => { if (typeof host.onMapType === 'function') host.onMapType(type); });
        mapTypes.appendChild(button);
        mapTypeButtons[type] = button;
      });
      mapArea.appendChild(mapHost);
      mapArea.appendChild(mapNote);
      mapArea.appendChild(mapTypes);

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
      const footer = el(doc, 'div', 'terminal-sheet-footer');
      const confirm = el(doc, 'button', 'terminal-sheet-confirm', COPY.confirm.pickup);
      confirm.type = 'button';
      on(confirm, 'click', () => { if (!confirm.disabled) host.onConfirm(); });
      footer.appendChild(confirm);

      panel.appendChild(grip);
      panel.appendChild(header);
      panel.appendChild(mapArea);
      panel.appendChild(port);
      panel.appendChild(list);
      panel.appendChild(note);
      panel.appendChild(footer);
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

      sheet = { overlay, panel, grip, header, title, skip, mapArea, mapHost, mapNote, mapTypes, mapTypeButtons,
        port, list, rows, note, confirm, close, view: null, inert, drag: null };
      render(view);

      // Focus enters the marked row (what the passenger is checking), else
      // the first row, else the close control.
      const marked = view && view.selectedPlaceId ? [...rows.values()].find((row) => row.placeId === view.selectedPlaceId) : null;
      const first = marked ? marked.button : (rows.size ? rows.values().next().value.button : close);
      if (first && typeof first.focus === 'function') first.focus();

      // .active a frame later so the slide/fade transitions actually run.
      const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn) => (typeof setTimeout === 'function' ? setTimeout(fn, 10) : fn());
      raf(() => { if (sheet && sheet.overlay === overlay) overlay.classList.add('active'); });
    }

    // Everything visible derives from the view: the marked row, the row
    // that is checking, the note, the map area's state, and whether
    // Confirm/Skip are usable. The map canvas itself belongs to the host.
    function render(view) {
      if (!sheet || !view) return;
      sheet.view = view;
      const side = sideOf(view);
      sheet.title.textContent = COPY.title[side];
      sheet.confirm.textContent = COPY.confirm[side];
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
      // The map area: 'off' hides it entirely (no loader on this page),
      // 'loading' and 'unavailable' show the note over an empty canvas,
      // 'ready' shows the canvas and the layer switch.
      const status = mapStatusOf(view);
      const type = mapTypeOf(view);
      sheet.mapArea.hidden = status === 'off';
      sheet.mapArea.setAttribute('data-map-status', status);
      sheet.mapNote.textContent = status === 'loading' ? COPY.map.loading : (status === 'unavailable' ? COPY.map.unavailable : '');
      sheet.mapNote.hidden = status === 'ready' || status === 'off';
      sheet.mapTypes.hidden = status !== 'ready';
      MAP_TYPES.forEach((candidate) => {
        const button = sheet.mapTypeButtons[candidate];
        button.setAttribute('aria-pressed', candidate === type ? 'true' : 'false');
        button.classList.toggle('is-active', candidate === type);
      });
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
      closed.panel.classList.remove('dragging');
      closed.panel.style.transform = 'translateY(100%)';
      closed.overlay.classList.remove('active');
      closed.overlay.classList.add('closing');
      removeClosing();
      closing = closed.overlay;
      if (typeof setTimeout === 'function') setTimeout(removeClosing, CLOSE_ANIMATION_MS);
      else removeClosing();
    }

    // For the host (the map canvas, focus management) and for tests.
    function elements() {
      return sheet ? { overlay: sheet.overlay, panel: sheet.panel, grip: sheet.grip, header: sheet.header,
        title: sheet.title, note: sheet.note, confirm: sheet.confirm, skip: sheet.skip, close: sheet.close,
        mapArea: sheet.mapArea, mapHost: sheet.mapHost, mapNote: sheet.mapNote, mapTypes: sheet.mapTypes,
        mapTypeButtons: sheet.mapTypeButtons, rows: sheet.rows, view: sheet.view } : null;
    }

    return { open, render, close, isOpen, elements };
  }

  return {
    COPY,
    MAP_TYPES,
    DISMISS_DISTANCE_PX,
    FLICK_VELOCITY,
    FLICK_MIN_DISTANCE_PX,
    dragOutcome,
    terminalRows,
    create
  };
}));
