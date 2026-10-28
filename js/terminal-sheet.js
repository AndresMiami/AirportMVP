// Terminal confirmation — the terminal STAGE in Where (plan v1.10 §2.2,
// §3.2; R1 shipped the modal sheet, this release turns it into the stage:
// the map on top, the terminal panel docked below it).
//
// ONE component, host-driven. It renders a VIEW the host derives from its
// own state and reports the passenger's acts back: a row tap, Confirm, Skip,
// a dismissal (✕, Escape), a map-layer choice, a panel position change. It
// decides nothing about selection, navigation, quotes or Google: the host
// attaches the Google map into `elements().mapHost`, draws the markers and
// owns the camera; this file only renders the map AREA's state (loading /
// ready / unavailable), the Standard | Satellite switch and the credits the
// host hands it with the view.
//
// Layout (the approved Where-map journey, relays 0288–0290): a stage with
// the header (✕ on the left, the title centred, a Skip pill on the right)
// floating over the map; the map fills the top; the panel is DOCKED at the
// bottom in one of two POSITIONS — collapsed (the handle, the selected row,
// the reminder line, Confirm; the default on open) or expanded (every
// verified terminal, scrolling, with Confirm fixed at the bottom). The
// handle IS a real button, "Show terminals" / "Collapse list" (named by
// state, aria-expanded, aria-controls the list), so a keyboard or
// screen-reader passenger can reach every terminal; dragging the handle up
// expands and down collapses (`dragOutcome` is the pure rule), and a drag
// NEVER dismisses — only ✕ and Escape do. Rows hidden by the collapsed
// position leave the focus order, and focus is moved to the handle before
// a collapse hides the row that holds it. House values (passenger-modal):
// dimmed backdrop rgba(0,0,0,0.7), #2C2C2E panel, max-width 576px on
// desktop, 20px top radius, 0.3s slide. Accessibility as the traveler
// dialog: role="dialog", aria-modal, labelled title, Tab/Shift+Tab cycle
// inside the enabled VISIBLE controls, Escape closes, the page behind is
// inert while open.
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
    expand: 'Show terminals',
    collapse: 'Collapse list',
    // The markers are Google's Place Details locations for the terminals,
    // never a verified pickup/drop-off curb (plan §2.5).
    caption: 'Terminal locations',
    map: Object.freeze({
      loading: 'Loading map…',
      unavailable: 'Map unavailable right now — the list still works.',
      standard: 'Standard',
      satellite: 'Satellite'
    })
  });

  const MAP_TYPES = Object.freeze(['roadmap', 'satellite']);
  const POSITIONS = Object.freeze(['collapsed', 'expanded']);
  const TOGGLE_DISTANCE_PX = 48;       // drag this far: the panel changes position…
  const FLICK_VELOCITY = 0.6;          // …or a flick (px per ms, ~600 px/s)…
  const FLICK_MIN_DISTANCE_PX = 24;    // …once it has travelled somewhere
  const DRAG_CLICK_SLOP_PX = 8;        // a drag this long is not also a click
  const CLOSE_ANIMATION_MS = 300;

  // Pure: what releasing a drag on the handle does. `dy` is the DOWNWARD
  // travel in px (negative = upward), `velocity` the average speed in
  // px/ms, `position` the panel's position when the drag began. A drag
  // never dismisses: from collapsed, dragging further down snaps back.
  function dragOutcome(dy, velocity, position) {
    if (typeof dy !== 'number' || !Number.isFinite(dy)) return 'snap';
    const speed = typeof velocity === 'number' && Number.isFinite(velocity) ? velocity : 0;
    const up = -dy;
    if (position === 'collapsed') {
      if (up >= TOGGLE_DISTANCE_PX) return 'expand';
      if (speed >= FLICK_VELOCITY && up >= FLICK_MIN_DISTANCE_PX) return 'expand';
      return 'snap';
    }
    if (position === 'expanded') {
      if (dy >= TOGGLE_DISTANCE_PX) return 'collapse';
      if (speed >= FLICK_VELOCITY && dy >= FLICK_MIN_DISTANCE_PX) return 'collapse';
      return 'snap';
    }
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

  // What the panel lists: every verified terminal, in registry order.
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

  // Third-party credits for the markers shown (the host validates them with
  // the autocomplete's own boundary before they reach the view): text nodes
  // and https links only — provider strings are never interpreted as HTML.
  function renderCredits(doc, holder, entries) {
    holder.textContent = '';
    if (typeof holder.replaceChildren === 'function') holder.replaceChildren();
    else if (Array.isArray(holder.children)) holder.children.length = 0;
    const list = Array.isArray(entries) ? entries : [];
    holder.hidden = list.length === 0;
    for (const entry of list) {
      if (!entry || !Array.isArray(entry.segments)) continue;
      holder.appendChild(doc.createTextNode(' · '));
      for (const segment of entry.segments) {
        const text = typeof (segment && segment.text) === 'string' ? segment.text : '';
        if (!text) continue;
        const href = typeof (segment && segment.href) === 'string' && /^https:\/\//i.test(segment.href) ? segment.href : null;
        if (href) {
          const link = el(doc, 'a', 'terminal-sheet-credit-link', text);
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          holder.appendChild(link);
        } else {
          holder.appendChild(doc.createTextNode(text));
        }
      }
    }
  }

  // host: { onRowTap(terminalId), onConfirm(), onSkip(), onDismiss(),
  //         onMapType(type), onPanelPosition(position) }
  // options.now: injectable clock for the drag rule (tests).
  function create({ document: doc, host, now } = {}) {
    if (!doc || !host) throw new Error('TerminalSheet.create needs a document and a host');
    const clock = typeof now === 'function' ? now : () => Date.now();
    let sheet = null;      // the open stage's nodes, view and position
    let closing = null;    // an overlay still animating out

    function isOpen() { return sheet !== null; }
    function position() { return sheet ? sheet.position : null; }

    function visibleRows() {
      if (!sheet) return [];
      return [...sheet.rows.values()].filter((row) => !row.button.hidden);
    }

    // The focus ring: the enabled, VISIBLE controls in reading order — the
    // header, the layer switch once the map exists, the handle button, the
    // rows the position shows, Confirm. Hidden rows are never reachable.
    function focusables() {
      if (!sheet) return [];
      const ring = [sheet.close, sheet.skip];
      if (mapStatusOf(sheet.view) === 'ready') ring.push(sheet.mapTypeButtons.roadmap, sheet.mapTypeButtons.satellite);
      ring.push(sheet.handle);
      visibleRows().forEach((row) => ring.push(row.button));
      ring.push(sheet.confirm);
      return ring.filter((control) => control && !control.disabled && !control.hidden && typeof control.focus === 'function');
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

    // ---- panel positions ----
    function setPosition(next) {
      if (!sheet || !POSITIONS.includes(next) || sheet.position === next) return false;
      // A row about to be hidden must not keep focus: the handle takes it.
      if (next === 'collapsed') {
        const active = doc.activeElement;
        const focusedRow = active ? visibleRows().find((row) => row.button === active) : null;
        if (focusedRow && typeof sheet.handle.focus === 'function') sheet.handle.focus();
      }
      sheet.position = next;
      render(sheet.view);
      if (typeof host.onPanelPosition === 'function') host.onPanelPosition(next);
      return true;
    }

    function toggle() {
      if (!sheet) return false;
      return setPosition(sheet.position === 'expanded' ? 'collapsed' : 'expanded');
    }

    // ---- the handle drag: up expands, down collapses, never dismisses ----
    function startDrag(e) {
      if (!sheet || !e) return;
      const y = e.clientY;
      if (typeof y !== 'number') return;
      sheet.drag = { startY: y, startAt: clock(), dy: 0, moved: false, position: sheet.position };
      sheet.panel.classList.add('dragging');
      const target = e.currentTarget;
      if (target && typeof target.setPointerCapture === 'function' && e.pointerId != null) {
        try { target.setPointerCapture(e.pointerId); } catch (_) { /* capture is a courtesy */ }
      }
    }
    function moveDrag(e) {
      if (!sheet || !sheet.drag || !e || typeof e.clientY !== 'number') return;
      const dy = e.clientY - sheet.drag.startY;
      sheet.drag.dy = dy;
      if (Math.abs(dy) >= DRAG_CLICK_SLOP_PX) sheet.drag.moved = true;
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    function endDrag() {
      if (!sheet || !sheet.drag) return;
      const drag = sheet.drag;
      sheet.drag = null;
      sheet.panel.classList.remove('dragging');
      // The click the browser fires after a real drag must not toggle the
      // position a second time; a tap (no travel) stays a click.
      sheet.suppressClick = drag.moved;
      const elapsed = Math.max(1, clock() - drag.startAt);
      const outcome = dragOutcome(drag.dy, Math.abs(drag.dy) / elapsed, drag.position);
      if (outcome === 'expand') setPosition('expanded');
      else if (outcome === 'collapse') setPosition('collapsed');
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
    //         map: { status: 'loading'|'ready'|'unavailable'|'off', type: 'roadmap'|'satellite' },
    //         credits: [validated attribution entries for the markers shown] }
    // options.inert: the element behind the stage (aria-hidden + inert while open)
    function open(view, options = {}) {
      if (sheet) { render(view); return; }
      removeClosing();
      const overlay = el(doc, 'div', 'terminal-sheet-overlay');
      const stage = el(doc, 'div', 'terminal-sheet-stage');
      stage.setAttribute('role', 'dialog');
      stage.setAttribute('aria-modal', 'true');
      stage.setAttribute('aria-labelledby', 'terminalSheetTitle');

      // Header over the map: ✕ on the left, the title centred, Skip as a
      // pill on the right.
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

      // The docked panel: the handle BUTTON, the caption strip (port,
      // "Terminal locations", credits), the rows, the reminder, Confirm.
      const panel = el(doc, 'div', 'terminal-sheet-panel');
      const handle = el(doc, 'button', 'terminal-sheet-handle-btn');
      handle.type = 'button';
      handle.setAttribute('aria-controls', 'terminalSheetList');
      handle.setAttribute('aria-expanded', 'false');
      const grip = el(doc, 'span', 'terminal-sheet-handle');
      grip.setAttribute('aria-hidden', 'true');
      const handleLabel = el(doc, 'span', 'terminal-sheet-handle-label', COPY.expand);
      handle.appendChild(grip);
      handle.appendChild(handleLabel);
      on(handle, 'click', () => {
        if (!sheet) return;
        if (sheet.suppressClick) { sheet.suppressClick = false; return; }
        toggle();
      });

      const captionStrip = el(doc, 'div', 'terminal-sheet-caption');
      const port = el(doc, 'span', 'terminal-sheet-port');
      const caption = el(doc, 'span', 'terminal-sheet-caption-text', COPY.caption);
      const credits = el(doc, 'span', 'terminal-sheet-credits');
      credits.hidden = true;
      captionStrip.appendChild(port);
      captionStrip.appendChild(caption);
      captionStrip.appendChild(credits);

      const list = el(doc, 'div', 'terminal-sheet-list');
      list.id = 'terminalSheetList';
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

      panel.appendChild(handle);
      panel.appendChild(captionStrip);
      panel.appendChild(list);
      panel.appendChild(note);
      panel.appendChild(footer);
      stage.appendChild(header);
      stage.appendChild(mapArea);
      stage.appendChild(panel);
      overlay.appendChild(stage);
      // Dismissal is ✕ or Escape only: a tap on the map or on the backdrop
      // is exploration, never a close; the handle owns the drag.
      bindDrag(handle);

      const inert = options.inert || null;
      if (inert) {
        if (typeof inert.setAttribute === 'function') inert.setAttribute('aria-hidden', 'true');
        inert.inert = true;
      }
      if (typeof doc.addEventListener === 'function') doc.addEventListener('keydown', keyHandler);
      doc.body.appendChild(overlay);

      sheet = { overlay, stage, panel, header, title, skip, close, mapArea, mapHost, mapNote, mapTypes, mapTypeButtons,
        handle, handleLabel, captionStrip, port, caption, credits, list, rows, note, confirm,
        view: null, inert, drag: null, suppressClick: false, position: 'collapsed' };
      render(view);

      // Focus enters the marked row when one is marked; otherwise — the
      // lookup still pending, or the selection superseded — the handle
      // button, which exists and is visible in every state.
      const marked = sheet.view && sheet.view.selectedPlaceId && !sheet.view.superseded
        ? visibleRows().find((row) => row.placeId === sheet.view.selectedPlaceId) : null;
      const first = marked ? marked.button : handle;
      if (first && typeof first.focus === 'function') first.focus();

      // .active a frame later so the slide/fade transitions actually run.
      const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn) => (typeof setTimeout === 'function' ? setTimeout(fn, 10) : fn());
      raf(() => { if (sheet && sheet.overlay === overlay) overlay.classList.add('active'); });
    }

    // Everything visible derives from the view and the position: the
    // marked row, the row that is checking, which rows the position shows,
    // the note, the map area's state, the credits, and whether
    // Confirm/Skip are usable. The map canvas itself belongs to the host.
    function render(view) {
      if (!sheet || !view) return;
      sheet.view = view;
      const side = sideOf(view);
      const expanded = sheet.position === 'expanded';
      sheet.title.textContent = COPY.title[side];
      sheet.confirm.textContent = COPY.confirm[side];
      sheet.port.textContent = view.registry && view.registry.port ? view.registry.port.name : '';
      sheet.panel.setAttribute('data-position', sheet.position);
      sheet.overlay.setAttribute('data-position', sheet.position);
      sheet.handle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      sheet.handleLabel.textContent = expanded ? COPY.collapse : COPY.expand;
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
        // Collapsed: only the selected row and the row being checked show;
        // the others are hidden (out of the focus order) until expanded.
        row.button.hidden = !(expanded || selected || checking);
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
      sheet.caption.hidden = status === 'off';
      renderCredits(doc, sheet.credits, status === 'off' ? [] : view.credits);
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
      closed.stage.style.transform = 'translateY(100%)';
      closed.overlay.classList.remove('active');
      closed.overlay.classList.add('closing');
      removeClosing();
      closing = closed.overlay;
      if (typeof setTimeout === 'function') setTimeout(removeClosing, CLOSE_ANIMATION_MS);
      else removeClosing();
    }

    // For the host (the map canvas, focus management) and for tests.
    function elements() {
      return sheet ? { overlay: sheet.overlay, stage: sheet.stage, panel: sheet.panel, header: sheet.header,
        title: sheet.title, note: sheet.note, confirm: sheet.confirm, skip: sheet.skip, close: sheet.close,
        mapArea: sheet.mapArea, mapHost: sheet.mapHost, mapNote: sheet.mapNote, mapTypes: sheet.mapTypes,
        mapTypeButtons: sheet.mapTypeButtons, handle: sheet.handle, handleLabel: sheet.handleLabel,
        caption: sheet.caption, credits: sheet.credits, port: sheet.port, list: sheet.list, rows: sheet.rows,
        view: sheet.view, position: sheet.position } : null;
    }

    return { open, render, close, isOpen, elements, position, setPosition, toggle };
  }

  return {
    COPY,
    MAP_TYPES,
    POSITIONS,
    TOGGLE_DISTANCE_PX,
    FLICK_VELOCITY,
    FLICK_MIN_DISTANCE_PX,
    DRAG_CLICK_SLOP_PX,
    dragOutcome,
    terminalRows,
    create
  };
}));
