// ==UserScript==
// @name         OpenProject – Meeting Time Suggestions
// @namespace    https://community.openproject.org
// @version      0.0.6
// @description  Annotates the time tracking calendar with meetings you attended (read-only).
// @author       thykel
// @match        https://community.openproject.org/my/time-tracking*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────────
  let currentUser = null;
  let cachedMeetings = {};  // keyed by "start/end"
  let renderHandle   = null;
  let isRendering    = false;  // guard against observer re-entrancy

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────
  const esc = s =>
    String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                   .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  async function apiFetch(path) {
    const res = await fetch(path, {
      headers: {
        'Accept': 'application/hal+json',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} at ${path}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  // Duration → minutes. Handles:
  //   number  0.5        (decimal hours, as community.openproject.org returns)
  //   string  "PT1H30M"  (ISO-8601)
  //   object  { hours: 1, minutes: 30 }  (decomposed form)
  function isoToMinutes(val) {
    if (!val && val !== 0) return 0;
    if (typeof val === 'number') return Math.round(val * 60); // decimal hours → minutes
    if (typeof val === 'object') {
      return Math.round((parseFloat(val.hours ?? val.h ?? 0) * 60) +
                         parseFloat(val.minutes ?? val.m ?? 0));
    }
    const str = String(val);
    const m = str.match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?/);
    if (!m) return 0;
    return Math.round((parseFloat(m[1] ?? 0) * 60) + parseFloat(m[2] ?? 0));
  }

  // minutes → "1h 30m"
  function fmtDuration(min) {
    if (!min) return '';
    const h = Math.floor(min / 60), m = min % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  function isoDate(d) {
    return d.toISOString().slice(0, 10);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Week-range detection from FullCalendar DOM
  // ─────────────────────────────────────────────────────────────────────────────
  function getVisibleWeekRange() {
    // FullCalendar renders day-column headers with data-date on each cell
    const cells = [...document.querySelectorAll(
      '.fc-col-header-cell[data-date], .fc-daygrid-day[data-date]'
    )];
    if (cells.length > 0) {
      const dates = cells.map(c => c.dataset.date).filter(Boolean).sort();
      return { start: dates[0], end: dates[dates.length - 1] };
    }
    // Fallback: compute current Mon–Sun
    const now = new Date();
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return { start: isoDate(mon), end: isoDate(sun) };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // API calls
  // ─────────────────────────────────────────────────────────────────────────────
  async function fetchCurrentUser() {
    if (currentUser) return currentUser;
    currentUser = await apiFetch('/api/v3/users/me');
    return currentUser;
  }

  // Extract the start-date from a meeting regardless of which field name the
  // server uses (varies by OpenProject version and meeting type).
  function meetingStartDate(m) {
    const raw = m.startTime ?? m.start_time ?? m.startDate ?? m.start_date ?? null;
    return raw ? String(raw).slice(0, 10) : null;
  }

  async function fetchMeetingsForWeek(start, end, userId) {
    const key = `${start}/${end}/${userId}`;
    if (cachedMeetings[key]) return cachedMeetings[key];

    const filters = encodeURIComponent(JSON.stringify([
      { invited_user_id: { operator: '=', values: [String(userId)] } },
    ]));
    const data = await apiFetch(`/api/v3/meetings?filters=${filters}&pageSize=500`);

    const all = data._embedded?.elements ?? [];
    const result = all.filter(m => {
      const d = meetingStartDate(m);
      return d && d >= start && d <= end;
    });

    cachedMeetings[key] = result;
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Styles
  // ─────────────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('op-ms-styles')) return;
    const el = document.createElement('style');
    el.id = 'op-ms-styles';
    el.textContent = `
      .op-ms-chip {
        position: absolute;
        left: 50%;
        width: calc(50% - 3px);
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        padding: 3px 5px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 500;
        line-height: 1.35;
        cursor: pointer;
        user-select: none;
        overflow: hidden;
        border: 1px solid #93c5fd;
        background: #dbeafe;
        color: #1e40af;
        z-index: 5;
      }
      .op-ms-chip__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 600;
      }
      .op-ms-chip__dur { font-size: 9px; opacity: 0.75; white-space: nowrap; }

      /* Short events (<30 min): title and duration on one row */
      .op-ms-chip--compact {
        flex-direction: row;
        align-items: center;
        gap: 4px;
      }
      .op-ms-chip--compact .op-ms-chip__dur { flex-shrink: 0; }

      /* ── loading indicator ── */
      .op-ms-loading {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: 12px;
        font-size: 13px;
        color: #64748b;
        vertical-align: middle;
      }
      .op-ms-spinner {
        width: 13px;
        height: 13px;
        border: 2px solid #cbd5e1;
        border-top-color: #3b82f6;
        border-radius: 50%;
        animation: op-ms-spin 0.7s linear infinite;
        flex-shrink: 0;
      }
      @keyframes op-ms-spin { to { transform: rotate(360deg); } }

      /* ── click popover ── */
      .op-ms-popover {
        position: fixed;
        z-index: 99999;
        background: #fff;
        border: 1px solid #bfdbfe;
        border-radius: 7px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.13);
        padding: 10px 13px;
        font-size: 12px;
        line-height: 1.6;
        color: #1e293b;
        min-width: 180px;
        max-width: 280px;
        pointer-events: none;
      }
      .op-ms-popover__title {
        font-weight: 700;
        font-size: 13px;
        margin-bottom: 4px;
        color: #1e40af;
      }
      .op-ms-popover__row { color: #475569; }
    `;
    document.head.appendChild(el);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Chip injection
  // ─────────────────────────────────────────────────────────────────────────────
  function clearChips() {
    hidePopover();
    document.querySelectorAll('.op-ms-chip').forEach(el => el.remove());
  }

  // Pixel offsetTop for a 'HH:MM' time string in the FullCalendar timegrid.
  function timeToTopPx(hhmm) {
    const slot = document.querySelector(
      '.fc-timegrid-slot[data-time="' + hhmm + ':00"]'
    );
    return slot ? slot.offsetTop : null;
  }

  // Convert minutes to pixels, deriving the real slot interval from the DOM.
  // Minimum height is clamped to one full slot so short events still show a title.
  function durationToPx(minutes) {
    const lanes = document.querySelectorAll('.fc-timegrid-slot-lane');
    if (lanes.length < 2) return null;
    const t0 = lanes[0].closest('[data-time]')?.dataset.time;
    const t1 = lanes[1].closest('[data-time]')?.dataset.time;
    let slotMins = 30;
    if (t0 && t1) {
      const [h0, m0] = t0.split(':').map(Number);
      const [h1, m1] = t1.split(':').map(Number);
      const diff = (h1 * 60 + m1) - (h0 * 60 + m0);
      if (diff > 0) slotMins = diff;
    }
    const slotPx = lanes[0].offsetHeight;
    return Math.max((minutes / slotMins) * slotPx, slotPx);
  }

  function injectChipsForDay(dateStr, meetings) {
    const col = document.querySelector(
      '.fc-timegrid-col[data-date="' + dateStr + '"]'
    );
    if (!col) return;
    const eventsLayer = col.querySelector('.fc-timegrid-col-events') ?? col;

    for (const meeting of meetings) {
      const title   = meeting.title || meeting.subject || '(untitled)';
      const durMins = isoToMinutes(meeting.duration) || 30;
      const project = meeting._links?.project?.title ?? '';

      if (!meeting.startTime) continue;
      const d       = new Date(meeting.startTime);
      const localHH = String(d.getHours()).padStart(2, '0');
      const localMM = String(d.getMinutes()).padStart(2, '0');
      const topPx   = timeToTopPx(localHH + ':' + localMM);
      if (topPx === null) continue;

      const heightPx = durationToPx(durMins);
      if (!heightPx) continue;

      // End time for tooltip
      const endD  = new Date(d.getTime() + durMins * 60000);
      const endHH = String(endD.getHours()).padStart(2, '0');
      const endMM = String(endD.getMinutes()).padStart(2, '0');

      const tooltipParts = [
        title,
        localHH + ':' + localMM + '–' + endHH + ':' + endMM + ' (' + fmtDuration(durMins) + ')',
      ];
      if (project)          tooltipParts.push('Project: ' + project);
      if (meeting.location) tooltipParts.push('Location: ' + meeting.location);

      // Work package IDs — linked as /api/v3/work_packages/123, extract the number
      const wpLinks = meeting._links?.workPackages ?? meeting._embedded?.workPackages ?? [];
      const wpIds = wpLinks
        .map(wp => { const href = wp.href ?? wp._links?.self?.href ?? ''; const m = href.match(/\/(\d+)$/); return m ? '#' + m[1] : null; })
        .filter(Boolean);
      if (wpIds.length) tooltipParts.push('WP: ' + wpIds.join(', '));

      const chip = document.createElement('div');
      chip.className = 'op-ms-chip' + (durMins < 30 ? ' op-ms-chip--compact' : '');
      chip.title     = tooltipParts.join('\n');
      chip.style.top    = topPx + 'px';
      chip.style.height = (heightPx - 2) + 'px';
      chip.innerHTML =
        '<span class="op-ms-chip__name">' + esc(title) + '</span>' +
        '<span class="op-ms-chip__dur">'  + fmtDuration(durMins) + '</span>';

      chip.dataset.opMsChip = '1';
      chip._opMsTooltip = tooltipParts;

      eventsLayer.appendChild(chip);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Click popover
  // ─────────────────────────────────────────────────────────────────────────────
  function showPopover(chip, tooltipParts) {
    hidePopover();

    const pop = document.createElement('div');
    pop.id        = 'op-ms-popover';
    pop.className = 'op-ms-popover';

    const [title, ...rows] = tooltipParts;
    pop.innerHTML =
      '<div class="op-ms-popover__title">' + esc(title) + '</div>' +
      rows.map(r => '<div class="op-ms-popover__row">' + esc(r) + '</div>').join('');

    document.body.appendChild(pop);

    // Position: prefer below-right of chip, flip if off-screen
    const rect = chip.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let top  = rect.bottom + 4;
    let left = rect.left;
    if (top + ph  > window.innerHeight) top  = rect.top - ph - 4;
    if (left + pw > window.innerWidth)  left = rect.right - pw;
    pop.style.top  = top  + 'px';
    pop.style.left = left + 'px';

    // Dismiss on next click anywhere
    setTimeout(() => document.addEventListener('click', hidePopover, { once: true }), 0);
  }

  function hidePopover() {
    document.getElementById('op-ms-popover')?.remove();
  }

  function showLoading() {
    if (document.getElementById('op-ms-loading')) return;
    const indicator = document.createElement('span');
    indicator.id        = 'op-ms-loading';
    indicator.className = 'op-ms-loading';
    indicator.innerHTML =
      '<span class="op-ms-spinner"></span>' +
      '<span>Loading meeting suggestions…</span>';

    const heading = [...document.querySelectorAll(
      '.op-time-tracking--title, .page-header__title, [data-test-selector="page-title"], h1, h2'
    )].find(el => !el.closest('[hidden]') && !el.classList.contains('sr-only') && el.offsetParent !== null);
    if (heading) {
      heading.appendChild(indicator);
    } else {
      // Fallback: fixed position in top-right corner
      indicator.style.cssText = 'position:fixed;top:12px;right:16px;z-index:99998;background:#fff;padding:4px 10px;border-radius:6px;border:1px solid #e2e8f0;box-shadow:0 2px 8px rgba(0,0,0,0.1)';
      document.body.appendChild(indicator);
    }
  }

  function hideLoading() {
    document.getElementById('op-ms-loading')?.remove();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Main pipeline
  // ─────────────────────────────────────────────────────────────────────────────
  async function runSuggestions() {
    if (isRendering) return;
    isRendering = true;
    clearChips();
    showLoading();

    const { start, end } = getVisibleWeekRange();
    if (!start) { hideLoading(); isRendering = false; return; }

    let user, meetings;
    try {
      user     = await fetchCurrentUser();
      meetings = await fetchMeetingsForWeek(start, end, user.id);
    } catch (err) {
      console.warn('[OP Meeting Suggestions] API error:', err.message);
      hideLoading();
      isRendering = false;
      return;
    }

    // Group by calendar date and inject chips
    const byDate = {};
    for (const m of meetings) {
      const d = meetingStartDate(m);
      if (d) (byDate[d] ??= []).push(m);
    }

    for (const [date, dayMeetings] of Object.entries(byDate)) {
      injectChipsForDay(date, dayMeetings);
    }

    console.log(`[OP Meeting Suggestions] ${meetings.length} meeting(s) shown for ${start}→${end}.`);
    hideLoading();
    isRendering = false;
  }

  // Debounced re-render (avoid rapid re-fires on Turbo frame swaps)
  function scheduleRender(delay = 700) {
    clearTimeout(renderHandle);
    renderHandle = setTimeout(runSuggestions, delay);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle hooks
  // ─────────────────────────────────────────────────────────────────────────────
  function onTimeTrackingPage() {
    return location.pathname.startsWith('/my/time-tracking');
  }

  function init() {
    if (!onTimeTrackingPage()) return;
    injectStyles();
    scheduleRender(900); // give FullCalendar time to render its grid
  }

  // Intercept mousedown (not click) — FullCalendar registers its slot handler
  // on mousedown, so by the time 'click' fires it has already acted.
  document.addEventListener('mousedown', e => {
    const chip = e.target.closest('[data-op-ms-chip]');
    if (!chip) return;
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();
  }, { capture: true });

  // Separate click listener purely to show the popover (safe now that
  // mousedown has already blocked FullCalendar).
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-op-ms-chip]');
    if (!chip) return;
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();
    showPopover(chip, chip._opMsTooltip ?? []);
  }, { capture: true });

  // Turbo Drive navigations (includes week-navigation arrow clicks)
  document.addEventListener('turbo:load',       init);
  document.addEventListener('turbo:frame-load', () => { if (onTimeTrackingPage()) scheduleRender(400); });

  // Initial page load (before any Turbo events fire)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // MutationObserver: only re-render when FullCalendar rebuilds its header row.
  // Guard: ignore mutations that originate from our own chip injection.
  const calendarObserver = new MutationObserver((mutations) => {
    if (isRendering) return;
    if (!onTimeTrackingPage()) return;
    const calendarChanged = mutations.some(mu =>
      [...mu.addedNodes].some(n =>
        n.nodeType === 1 &&
        !n.classList?.contains('op-ms-chip') &&
        (n.matches?.('.fc-col-header-cell') || n.querySelector?.('.fc-col-header-cell[data-date]'))
      )
    );
    if (calendarChanged) scheduleRender(400);
  });
  calendarObserver.observe(document.body, { childList: true, subtree: true });

})();