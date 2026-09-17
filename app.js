/* HourKeep — local-first billable time tracker.
 * All data lives in this browser's localStorage under 'hourkeep.v1'.
 * Nothing is uploaded anywhere. Timestamps are stored as UTC epoch ms.
 * Pure helpers at the top are exported for node tests (see tests/).
 */
(function () {
'use strict';

/* ---------------- analytics-ready stub (no provider configured) ---------------- */
if (typeof window !== 'undefined') {
  window.hkQueue = window.hkQueue || [];
  window.hkTrack = window.hkTrack || function (name, props) {
    window.hkQueue.push({ event: name, props: props || {}, at: new Date().toISOString() });
  };
}

/* ================= pure helpers (no DOM, fully testable) ================= */

function uid() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** Elapsed ms between two timestamps. Interval counters must never be used for billing. */
function timerElapsedMs(startMs, nowMs) {
  return Math.max(0, nowMs - startMs);
}

function formatElapsed(ms) {
  var s = Math.floor(ms / 1000);
  return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor((s % 3600) / 60)) + ':' + pad2(s % 60);
}

/** Duration of an entry in ms. End <= start means the entry crossed midnight (+24h). */
function entryDurationMs(startMs, endMs) {
  var ms = endMs - startMs;
  if (ms <= 0) ms += 24 * 3600 * 1000;
  return Math.max(0, ms);
}

function msToHours(ms) { return ms / 3600000; }

/** Billable amount in minor units (cents), rounded once at the end to avoid float drift. */
function calcCents(hours, ratePerHour) {
  if (!isFinite(hours) || !isFinite(ratePerHour) || hours < 0 || ratePerHour < 0) return 0;
  return Math.round(hours * ratePerHour * 100);
}

function formatMoney(cents, currency, locale) {
  try {
    return new Intl.NumberFormat(locale || undefined, { style: 'currency', currency: currency || 'USD' }).format(cents / 100);
  } catch (e) {
    return ((cents / 100).toFixed(2)) + ' ' + (currency || 'USD');
  }
}

/** 'YYYY-MM-DD' for a timestamp in a given IANA time zone. */
function tzDateKey(ms, timeZone) {
  try {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    return parts; // en-CA yields YYYY-MM-DD
  } catch (e) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
}

/** Monday (YYYY-MM-DD) of the week containing dateKey. Pure calendar math in date space (no DST). */
function weekStartKey(dateKey) {
  var d = new Date(dateKey + 'T12:00:00Z');
  var dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function monthKey(dateKey) { return dateKey.slice(0, 7); }

/** Validate a manual entry. Returns an array of human-readable error strings (empty = valid). */
function validateEntry(input) {
  // input: { date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM', projectId, billable }
  var errs = [];
  if (!input.projectId) errs.push('Choose a project for this entry.');
  if (!input.date) errs.push('Pick a date.');
  if (!input.start) errs.push('Enter a start time.');
  if (!input.end) errs.push('Enter an end time.');
  if (errs.length) return errs;
  var s = new Date(input.date + 'T' + input.start + ':00');
  var e = new Date(input.date + 'T' + input.end + ':00');
  if (isNaN(s.getTime()) || isNaN(e.getTime())) { errs.push('That date or time is not valid.'); return errs; }
  if (input.start === input.end) { errs.push('Start and end times are the same — enter a real duration.'); return errs; }
  var ms = entryDurationMs(s.getTime(), e.getTime());
  if (ms <= 0) errs.push('Duration must be longer than zero minutes.');
  if (ms > 24 * 3600 * 1000) errs.push('A single entry cannot be longer than 24 hours.');
  var now = Date.now();
  if (s.getTime() > now + 60 * 1000) errs.push('Start time is in the future.');
  return errs;
}

/** Combine a date + time input into epoch ms (interpreted in the browser's zone; stored as UTC ms). */
function combineDateTime(dateStr, timeStr) {
  return new Date(dateStr + 'T' + timeStr + ':00').getTime();
}

/** Aggregate entries into totals. projects: {id:{rate,clientId}}, clients:{id:{name}}. */
function summarize(entries, projects) {
  var t = { totalMs: 0, billMs: 0, nonBillMs: 0, billCents: 0, byClient: {}, byProject: {} };
  entries.forEach(function (en) {
    var p = projects[en.projectId] || { rate: 0, clientId: null };
    var ms = entryDurationMs(en.startMs, en.endMs);
    var cents = en.billable ? calcCents(msToHours(ms), p.rate || 0) : 0;
    t.totalMs += ms;
    if (en.billable) { t.billMs += ms; t.billCents += cents; } else { t.nonBillMs += ms; }
    var ck = p.clientId || '__none__';
    t.byClient[ck] = t.byClient[ck] || { ms: 0, cents: 0 };
    t.byClient[ck].ms += ms; t.byClient[ck].cents += cents;
    t.byProject[en.projectId] = t.byProject[en.projectId] || { ms: 0, cents: 0 };
    t.byProject[en.projectId].ms += ms; t.byProject[en.projectId].cents += cents;
  });
  return t;
}

function csvCell(v) {
  var s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Build a client-ready CSV string for entries. */
function entriesToCSV(entries, projects, clients, timeZone) {
  var pmap = {};
  (projects || []).forEach(function (p) { pmap[p.id] = p; });
  var cmap = {};
  (clients || []).forEach(function (c) { cmap[c.id] = c.name; });
  var lines = ['Date,Client,Project,Description,Billable,Start,End,Hours,Rate,Amount (minor units)'];
  entries.forEach(function (en) {
    var p = pmap[en.projectId] || { name: '(deleted project)', rate: 0, clientId: null };
    var ms = entryDurationMs(en.startMs, en.endMs);
    var hours = msToHours(ms);
    var cents = en.billable ? calcCents(hours, p.rate || 0) : 0;
    lines.push([
      csvCell(tzDateKey(en.startMs, timeZone)),
      csvCell(cmap[p.clientId] || ''),
      csvCell(p.name),
      csvCell(en.description || ''),
      csvCell(en.billable ? 'yes' : 'no'),
      csvCell(new Date(en.startMs).toISOString()),
      csvCell(new Date(en.endMs).toISOString()),
      csvCell(hours.toFixed(2)),
      csvCell(p.rate || 0),
      csvCell(cents)
    ].join(','));
  });
  return lines.join('\n');
}

/** Coerce unknown persisted data into a valid state shape. Never throws. */
function sanitizeState(raw) {
  var s = { v: 1, onboarded: false, role: null, clients: [], projects: [], entries: [], activeTimer: null,
            settings: { currency: 'USD', timeZone: 'auto' } };
  if (!raw || typeof raw !== 'object') return s;
  if (Array.isArray(raw.clients)) s.clients = raw.clients.filter(function (c) { return c && typeof c.id === 'string'; });
  if (Array.isArray(raw.projects)) s.projects = raw.projects.filter(function (p) { return p && typeof p.id === 'string'; });
  if (Array.isArray(raw.entries)) s.entries = raw.entries.filter(function (e) { return e && typeof e.id === 'string' && isFinite(e.startMs) && isFinite(e.endMs); });
  if (raw.activeTimer && isFinite(raw.activeTimer.startMs) && typeof raw.activeTimer.projectId === 'string') {
    s.activeTimer = { projectId: raw.activeTimer.projectId, startMs: raw.activeTimer.startMs, description: String(raw.activeTimer.description || '') };
  }
  if (raw.settings && typeof raw.settings === 'object') {
    if (typeof raw.settings.currency === 'string' && raw.settings.currency) s.settings.currency = raw.settings.currency;
    if (typeof raw.settings.timeZone === 'string' && raw.settings.timeZone) s.settings.timeZone = raw.settings.timeZone;
  }
  if (raw.onboarded === true) s.onboarded = true;
  if (typeof raw.role === 'string') s.role = raw.role;
  return s;
}

var APP_VIEWS = ['tracker', 'library', 'reports', 'settings'];

/**
 * Hash routing for GitHub Pages (no server rewrites available).
 * '#/tracker' etc. map to views; unknown '#/…' maps to 'notfound';
 * anything else returns null (no route given). Legacy '#settings' kept working.
 */
function parseAppHash(hash) {
  var h = String(hash || '');
  if (h === '' || h === '#') return null;
  if (h === '#settings') return { view: 'settings' };
  var m = /^#\/([a-z]+)/.exec(h);
  if (!m) return null;
  if (APP_VIEWS.indexOf(m[1]) >= 0) return { view: m[1] };
  return { view: 'notfound' };
}
function hashForView(view) { return '#/' + view; }

/** Escape user text before injecting into HTML. */function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

var Pure = { uid: uid, timerElapsedMs: timerElapsedMs, formatElapsed: formatElapsed, entryDurationMs: entryDurationMs,
  msToHours: msToHours, calcCents: calcCents, formatMoney: formatMoney, tzDateKey: tzDateKey,
  weekStartKey: weekStartKey, monthKey: monthKey, validateEntry: validateEntry, combineDateTime: combineDateTime,
  summarize: summarize, entriesToCSV: entriesToCSV, sanitizeState: sanitizeState, escapeHtml: escapeHtml,
  APP_VIEWS: APP_VIEWS, parseAppHash: parseAppHash, hashForView: hashForView };

if (typeof module !== 'undefined' && module.exports) { module.exports = Pure; }

/* ================= browser app (DOM) ================= */
if (typeof document === 'undefined') return;

var LS_KEY = 'hourkeep.v1';
var CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'SGD', 'SEK', 'NOK', 'DKK', 'MXN', 'ZAR', 'AED'];
var COMMON_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam', 'UTC',
  'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];

function loadState() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    return sanitizeState(raw ? JSON.parse(raw) : null);
  } catch (e) { return sanitizeState(null); }
}
function saveState(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { toast('Storage is full or unavailable — data may not persist.', 'error'); }
}

var state = loadState();
var ui = { view: 'tracker', reportRange: 'week', customFrom: null, customTo: null, editingEntryId: null, tickTimer: null };

function effectiveTimeZone() {
  if (state.settings.timeZone && state.settings.timeZone !== 'auto') return state.settings.timeZone;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
}
function money(cents) { return formatMoney(cents, state.settings.currency); }
function activeProjects() { return state.projects.filter(function (p) { return !p.archived; }); }
function clientName(id) {
  var c = state.clients.filter(function (x) { return x.id === id; })[0];
  return c ? c.name : '(no client)';
}
function projectById(id) { return state.projects.filter(function (p) { return p.id === id; })[0]; }

function toast(msg, kind) {
  var box = document.getElementById('toasts');
  var el = document.createElement('div');
  el.className = 'toast ' + (kind || 'info');
  el.setAttribute('role', 'status');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 300); }, 3600);
}
function announce(msg) {
  var live = document.getElementById('sr-live');
  if (live) { live.textContent = ''; setTimeout(function () { live.textContent = msg; }, 30); }
}

/* ---------- timer engine: timestamp-based, survives refresh/sleep ---------- */
function startTimer(projectId, description) {
  if (state.activeTimer) { toast('A timer is already running. Stop it first.', 'error'); return false; }
  if (!projectById(projectId)) { toast('Choose a project first.', 'error'); return false; }
  state.activeTimer = { projectId: projectId, startMs: Date.now(), description: description || '' };
  saveState(state);
  window.hkTrack('timer_started', { projectId: projectId });
  render();
  return true;
}
function stopTimer() {
  if (!state.activeTimer) return false;
  var t = state.activeTimer;
  var endMs = Date.now();
  var p = projectById(t.projectId);
  state.entries.push({ id: uid(), projectId: t.projectId, startMs: t.startMs, endMs: endMs,
    description: t.description || '', billable: p ? p.billableDefault !== false : true, createdAt: endMs });
  state.activeTimer = null;
  saveState(state);
  window.hkTrack('timer_stopped', {});
  render();
  toast('Timer stopped and saved.');
  return true;
}
function tick() {
  if (!state.activeTimer) return;
  var el = document.getElementById('timer-elapsed');
  if (el) {
    var ms = timerElapsedMs(state.activeTimer.startMs, Date.now());
    el.textContent = formatElapsed(ms);
  }
}
window.addEventListener('beforeunload', function (e) {
  if (state.activeTimer) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- entries ---------- */
function saveManualEntry(input) {
  var errs = validateEntry(input);
  if (errs.length) return errs;
  var s = combineDateTime(input.date, input.start);
  var e = combineDateTime(input.date, input.end);
  if (e <= s) e += 24 * 3600 * 1000; // crossed midnight
  var p = projectById(input.projectId);
  if (ui.editingEntryId) {
    var en = state.entries.filter(function (x) { return x.id === ui.editingEntryId; })[0];
    if (!en) return ['Entry no longer exists.'];
    en.projectId = input.projectId; en.startMs = s; en.endMs = e;
    en.description = input.description; en.billable = input.billable;
    window.hkTrack('manual_entry_edited', {});
  } else {
    state.entries.push({ id: uid(), projectId: input.projectId, startMs: s, endMs: e,
      description: input.description, billable: (typeof input.billable === 'boolean' ? input.billable : (p ? p.billableDefault !== false : true)),
      createdAt: Date.now() });
    window.hkTrack('manual_entry_created', {});
  }
  ui.editingEntryId = null;
  saveState(state);
  render();
  return [];
}

/* ---------- reports ---------- */
function entriesInRange() {
  var tz = effectiveTimeZone();
  var today = tzDateKey(Date.now(), tz);
  var from, to;
  if (ui.reportRange === 'today') { from = today; to = today; }
  else if (ui.reportRange === 'month') { from = today.slice(0, 7) + '-01'; to = today; }
  else if (ui.reportRange === 'custom' && ui.customFrom && ui.customTo) { from = ui.customFrom; to = ui.customTo; }
  else { var ws = weekStartKey(today); from = ws; to = today; } // week to date
  return state.entries.filter(function (en) {
    var k = tzDateKey(en.startMs, tz);
    return k >= from && k <= to;
  }).sort(function (a, b) { return b.startMs - a.startMs; });
}

function download(filename, text, mime) {
  var blob = new Blob([text], { type: mime || 'text/plain' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ================= rendering ================= */
function fmtDateTime(ms) {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: effectiveTimeZone() }).format(new Date(ms)); }
  catch (e) { return new Date(ms).toLocaleString(); }
}
function fmtTime(ms) {
  try { return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: effectiveTimeZone() }).format(new Date(ms)); }
  catch (e) { return new Date(ms).toLocaleTimeString(); }
}

function projectOptions(selectedId) {
  return activeProjects().map(function (p) {
    return '<option value="' + p.id + '"' + (p.id === selectedId ? ' selected' : '') + '>' +
      escapeHtml(clientName(p.clientId) + ' · ' + p.name) + '</option>';
  }).join('') || '<option value="">No active projects — create one below</option>';
}

function renderTimerCard() {
  var t = state.activeTimer;
  var desc = t ? t.description : '';
  var proj = t ? t.projectId : (activeProjects()[0] ? activeProjects()[0].id : '');
  return '' +
  '<section class="card timer-card" aria-label="Time tracker">' +
    '<div class="timer-top"><h2>' + (t ? 'Timer running' : 'Start a timer') + '</h2>' +
    (t ? '<span class="pill live"><span class="dot"></span>Live</span>' : '') + '</div>' +
    '<div class="timer-elapsed" id="timer-elapsed" role="timer" aria-live="off">' +
      (t ? formatElapsed(timerElapsedMs(t.startMs, Date.now())) : '00:00:00') + '</div>' +
    (t ? '<p class="muted">Started ' + escapeHtml(fmtDateTime(t.startMs)) + ' · ' + escapeHtml(clientName((projectById(t.projectId) || {}).clientId) + ' · ' + ((projectById(t.projectId) || {}).name || '')) + '</p>' : '') +
    '<div class="form-grid">' +
      '<div><label for="timer-project">Project</label>' +
      '<select id="timer-project"' + (t ? ' disabled' : '') + '>' + projectOptions(proj) + '</select></div>' +
      '<div><label for="timer-desc">Task note <span class="opt">(optional)</span></label>' +
      '<input id="timer-desc" type="text" maxlength="140" placeholder="e.g. Homepage wireframes"' + (t ? ' disabled value="' + escapeHtml(desc) + '"' : '') + '></div>' +
    '</div>' +
    (t
      ? '<button class="btn-stop" id="btn-stop">Stop timer</button>'
      : '<button class="btn-start" id="btn-start">Start timer</button>') +
  '</section>';
}

function renderEntryForm() {
  var editing = ui.editingEntryId ? state.entries.filter(function (x) { return x.id === ui.editingEntryId; })[0] : null;
  var tz = effectiveTimeZone();
  var d = editing ? tzDateKey(editing.startMs, tz) : tzDateKey(Date.now(), tz);
  function hm(ms) {
    try {
      var p = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(ms));
      return p;
    } catch (e) { return ''; }
  }
  var s = editing ? hm(editing.startMs) : '';
  var e = editing ? hm(editing.endMs > editing.startMs ? editing.endMs : editing.endMs) : '';
  var proj = editing ? editing.projectId : (activeProjects()[0] ? activeProjects()[0].id : '');
  var bill = editing ? editing.billable : true;
  return '' +
  '<section class="card" aria-label="' + (editing ? 'Edit time entry' : 'Add time manually') + '">' +
    '<h2>' + (editing ? 'Edit entry' : 'Add time manually') + '</h2>' +
    '<div id="form-errors" class="form-errors" role="alert" hidden></div>' +
    '<div class="form-grid">' +
      '<div><label for="f-date">Date</label><input id="f-date" type="date" value="' + d + '" required></div>' +
      '<div><label for="f-project">Project</label><select id="f-project">' + projectOptions(proj) + '</select></div>' +
      '<div><label for="f-start">Start</label><input id="f-start" type="time" value="' + s + '" required></div>' +
      '<div><label for="f-end">End <span class="opt">(next day if earlier than start)</span></label><input id="f-end" type="time" value="' + e + '" required></div>' +
      '<div class="span2"><label for="f-desc">Description <span class="opt">(optional)</span></label>' +
      '<input id="f-desc" type="text" maxlength="140" placeholder="e.g. Client feedback round 2" value="' + escapeHtml(editing ? editing.description : '') + '"></div>' +
      '<div><label class="check"><input id="f-billable" type="checkbox"' + (bill ? ' checked' : '') + '> Billable</label></div>' +
    '</div>' +
    '<div class="row-btns">' +
      '<button class="btn solid btn-inline" id="btn-save-entry">' + (editing ? 'Save changes' : 'Add entry') + '</button>' +
      (editing ? '<button class="btn ghost btn-inline" id="btn-cancel-edit">Cancel</button>' : '') +
    '</div>' +
  '</section>';
}

function renderEntryList(list, title) {
  var tz = effectiveTimeZone();
  if (!list.length) {
    return '<section class="card"><h2>' + title + '</h2><div class="empty">' +
      '<p><strong>No time entries yet.</strong></p><p class="muted">Start the timer above or add your first manual entry — it will show up here.</p></div></section>';
  }
  var pmap = {}; state.projects.forEach(function (p) { pmap[p.id] = p; });
  var rows = list.map(function (en) {
    var p = pmap[en.projectId] || { name: '(deleted project)', rate: 0, clientId: null };
    var ms = entryDurationMs(en.startMs, en.endMs);
    var cents = en.billable ? calcCents(msToHours(ms), p.rate || 0) : 0;
    return '<li class="entry">' +
      '<div class="entry-main"><strong>' + escapeHtml(p.name) + '</strong>' +
      '<span class="muted">' + escapeHtml(clientName(p.clientId)) + ' · ' + escapeHtml(tzDateKey(en.startMs, tz)) + ' · ' +
      escapeHtml(fmtTime(en.startMs)) + '–' + escapeHtml(fmtTime(en.endMs)) + ' · ' + msToHours(ms).toFixed(2) + 'h' +
      (en.description ? ' · ' + escapeHtml(en.description) : '') + '</span></div>' +
      '<div class="entry-side"><span class="pill ' + (en.billable ? 'bill' : 'nonbill') + '">' + (en.billable ? money(cents) + ' · billable' : 'non-billable') + '</span>' +
      '<button class="linkbtn" data-edit="' + en.id + '">Edit</button>' +
      '<button class="linkbtn danger" data-del="' + en.id + '">Delete</button></div></li>';
  }).join('');
  return '<section class="card"><h2>' + title + ' <span class="count">' + list.length + '</span></h2><ul class="entries">' + rows + '</ul></section>';
}

function renderTracker() {
  var today = tzDateKey(Date.now(), effectiveTimeZone());
  var list = state.entries.filter(function (en) { return tzDateKey(en.startMs, effectiveTimeZone()) === today; })
    .sort(function (a, b) { return b.startMs - a.startMs; });
  return renderTimerCard() + renderEntryForm() + renderEntryList(list, "Today's entries");
}

function renderLibrary() {
  function clientBlock(c) {
    var projs = state.projects.filter(function (p) { return p.clientId === c.id; });
    var plist = projs.map(function (p) {
      return '<li class="entry"><div class="entry-main"><strong>' + escapeHtml(p.name) + '</strong>' +
        '<span class="muted">' + money(Math.round((p.rate || 0) * 100)) + '/hr · ' +
        (p.billableDefault === false ? 'non-billable by default' : 'billable by default') +
        (p.archived ? ' · archived' : '') + '</span></div>' +
        '<div class="entry-side">' +
        '<button class="linkbtn" data-pedit="' + p.id + '">Edit</button>' +
        '<button class="linkbtn" data-parch="' + p.id + '">' + (p.archived ? 'Unarchive' : 'Archive') + '</button>' +
        '<button class="linkbtn danger" data-pdel="' + p.id + '">Delete</button></div></li>';
    }).join('');
    return '<div class="card"><div class="lib-head"><h3>' + escapeHtml(c.name) + (c.archived ? ' <span class="pill nonbill">archived</span>' : '') + '</h3>' +
      '<div><button class="linkbtn" data-cadd-p="' + c.id + '">+ Project</button> ' +
      '<button class="linkbtn" data-cedit="' + c.id + '">Rename</button> ' +
      '<button class="linkbtn danger" data-cdel="' + c.id + '">Delete</button></div></div>' +
      (plist ? '<ul class="entries">' + plist + '</ul>' : '<p class="muted">No projects yet.</p>') + '</div>';
  }
  var body = state.clients.length ? state.clients.map(clientBlock).join('')
    : '<div class="card"><div class="empty"><p><strong>No clients yet.</strong></p><p class="muted">Add your first client to get started — projects belong to clients.</p></div></div>';
  return '<section class="card"><h2>Clients &amp; projects</h2>' +
    '<div class="row-btns"><button class="btn solid btn-inline" id="btn-add-client">+ New client</button></div></section>' + body;
}

function renderReports() {
  var list = entriesInRange();
  var pmap = {}; state.projects.forEach(function (p) { pmap[p.id] = p; });
  var cmap = {}; state.clients.forEach(function (c) { cmap[c.id] = c.name; });
  var sum = summarize(list, pmap);
  function rangeBtns() {
    function b(key, label) { return '<button class="chip' + (ui.reportRange === key ? ' on' : '') + '" data-range="' + key + '">' + label + '</button>'; }
    return '<div class="chips" role="group" aria-label="Report range">' + b('today', 'Today') + b('week', 'This week') + b('month', 'This month') + b('custom', 'Custom') + '</div>';
  }
  var custom = ui.reportRange === 'custom'
    ? '<div class="form-grid"><div><label for="r-from">From</label><input id="r-from" type="date" value="' + (ui.customFrom || '') + '"></div>' +
      '<div><label for="r-to">To</label><input id="r-to" type="date" value="' + (ui.customTo || '') + '"></div>' +
      '<div><label>&nbsp;</label><button class="btn solid btn-inline" id="btn-apply-range">Apply</button></div></div>' : '';
  var clientRows = Object.keys(sum.byClient).map(function (k) {
    return '<tr><td>' + escapeHtml(k === '__none__' ? '(no client)' : (cmap[k] || '(deleted client)')) + '</td><td class="num">' +
      msToHours(sum.byClient[k].ms).toFixed(2) + 'h</td><td class="num">' + money(sum.byClient[k].cents) + '</td></tr>';
  }).join('') || '<tr><td colspan="3" class="muted">No data in this range.</td></tr>';
  var projRows = Object.keys(sum.byProject).map(function (k) {
    var p = pmap[k] || { name: '(deleted project)' };
    return '<tr><td>' + escapeHtml(p.name) + '</td><td class="num">' + msToHours(sum.byProject[k].ms).toFixed(2) +
      'h</td><td class="num">' + money(sum.byProject[k].cents) + '</td></tr>';
  }).join('') || '<tr><td colspan="3" class="muted">No data in this range.</td></tr>';
  return '<section class="card"><h2>Reports</h2>' + rangeBtns() + custom +
    '<div class="stat4">' +
    '<div class="stat"><small>Total hours</small><b>' + msToHours(sum.totalMs).toFixed(2) + 'h</b></div>' +
    '<div class="stat"><small>Billable</small><b>' + msToHours(sum.billMs).toFixed(2) + 'h</b></div>' +
    '<div class="stat"><small>Non-billable</small><b>' + msToHours(sum.nonBillMs).toFixed(2) + 'h</b></div>' +
    '<div class="stat"><small>Billable amount</small><b>' + money(sum.billCents) + '</b></div></div>' +
    '<div class="row-btns"><button class="btn solid btn-inline" id="btn-csv">Export CSV (' + list.length + ' entries)</button></div></section>' +
    '<section class="card"><h3>By client</h3><div class="table-wrap"><table><thead><tr><th>Client</th><th class="num">Hours</th><th class="num">Amount</th></tr></thead><tbody>' +
    clientRows + '</tbody></table></div></section>' +
    '<section class="card"><h3>By project</h3><div class="table-wrap"><table><thead><tr><th>Project</th><th class="num">Hours</th><th class="num">Amount</th></tr></thead><tbody>' +
    projRows + '</tbody></table></div></section>';
}

function zoneOptions() {
  var zones = [];
  try {
    if (Intl.supportedValuesOf) zones = Intl.supportedValuesOf('timeZone');
  } catch (e) { zones = []; }
  if (!zones.length) zones = COMMON_ZONES;
  else {
    // Put the most common zones first, then the rest.
    var rest = zones.filter(function (z) { return COMMON_ZONES.indexOf(z) < 0; });
    zones = COMMON_ZONES.concat(rest);
  }
  return zones;
}

function renderSettings() {
  var cur = CURRENCIES.map(function (c) {
    return '<option value="' + c + '"' + (state.settings.currency === c ? ' selected' : '') + '>' + c + '</option>';
  }).join('');
  var zones = ['<option value="auto"' + (state.settings.timeZone === 'auto' ? ' selected' : '') + '>Auto-detect (' + escapeHtml(effectiveTimeZone()) + ')</option>']
    .concat(zoneOptions().map(function (z) {
      return '<option value="' + z + '"' + (state.settings.timeZone === z ? ' selected' : '') + '>' + z + '</option>';
    })).join('');
  return '<section class="card" id="settings"><h2>Settings</h2>' +
    '<div class="form-grid">' +
    '<div><label for="s-currency">Currency (default USD)</label><select id="s-currency">' + cur + '</select></div>' +
    '<div><label for="s-tz">Time zone</label><select id="s-tz">' + zones + '</select></div></div>' +
    '<p class="muted">Timestamps are stored in UTC and displayed in your selected time zone. Amounts are formatted for your locale.</p>' +
    '<div class="row-btns"><button class="btn solid btn-inline" id="btn-export-json">Export all data (JSON)</button> ' +
    '<button class="btn ghost btn-inline danger-btn" id="btn-wipe">Delete all my data…</button></div></section>' +
    '<section class="card"><h2>About &amp; support</h2>' +
    '<p class="muted">HourKeep stores everything in this browser only — nothing is uploaded. Questions? <a href="mailto:hello@hourkeep.app">hello@hourkeep.app</a></p>' +
    '<p><a href="privacy.html">Privacy Policy</a> · <a href="terms.html">Terms of Service</a> · <a href="./">Back to homepage</a></p></section>';
}

function renderOnboarding() {
  if (state.onboarded) return '';
  var step = state.role ? 2 : 1;
  var inner;
  if (step === 1) {
    inner = '<h2>What do you do?</h2><p class="muted">This tailors nothing but the example text — skip anytime.</p>' +
      '<div class="role-grid">' +
      ['freelancer', 'consultant', 'agency', 'other'].map(function (r) {
        return '<button class="role" data-role="' + r + '">' + r.charAt(0).toUpperCase() + r.slice(1) + '</button>';
      }).join('') + '</div>' +
      '<button class="linkbtn" id="btn-skip-ob">Skip onboarding →</button>';
  } else {
    inner = '<h2>Create your first client &amp; project</h2><p class="muted">Real records — or add the sample set to explore (clearly labeled, deletable).</p>' +
      '<div class="form-grid"><div><label for="ob-client">Client name</label><input id="ob-client" type="text" maxlength="80" placeholder="e.g. Acme Studio"></div>' +
      '<div><label for="ob-project">Project name</label><input id="ob-project" type="text" maxlength="80" placeholder="e.g. Website redesign"></div>' +
      '<div><label for="ob-rate">Hourly rate (' + escapeHtml(state.settings.currency) + ')</label><input id="ob-rate" type="number" min="0" step="0.01" placeholder="e.g. 85"></div></div>' +
      '<div class="row-btns"><button class="btn solid btn-inline" id="btn-ob-create">Create &amp; start tracking</button> ' +
      '<button class="btn ghost btn-inline" id="btn-ob-sample">Use sample data</button> ' +
      '<button class="linkbtn" id="btn-skip-ob">Skip →</button></div>';
  }
  return '<div class="ob-overlay"><div class="ob-card" role="dialog" aria-modal="true" aria-label="Getting started">' + inner + '</div></div>';
}

function renderNotFound() {
  return '<section class="card"><h2>Section not found</h2>' +
    '<div class="empty"><p><strong>That section doesn\'t exist.</strong></p>' +
    '<p class="muted">The link may be mistyped — your tracker is one click away, nothing was lost.</p></div>' +
    '<div class="row-btns"><button class="btn solid btn-inline" data-view="tracker">Back to tracker</button></div></section>';
}

/** Navigate by hash so Back/Forward/refresh keep working. Same-hash clicks render directly. */
function setRoute(view) {
  try {
    if (window.location.hash === hashForView(view)) render();
    else window.location.hash = hashForView(view);
  } catch (e) { ui.view = view; render(); }
}
var hashBound = false;

function render() {
  try { var r0 = parseAppHash(window.location.hash); if (r0) ui.view = r0.view; } catch (e) {}
  var app = document.getElementById('app');
  var html = renderOnboarding();
  html += '<div class="tabs" role="tablist" aria-label="Tracker sections">' +
    [['tracker', 'Tracker'], ['library', 'Clients & projects'], ['reports', 'Reports'], ['settings', 'Settings']].map(function (t) {
      return '<button role="tab" aria-selected="' + (ui.view === t[0]) + '" class="tab' + (ui.view === t[0] ? ' on' : '') + '" data-view="' + t[0] + '">' + t[1] + '</button>';
    }).join('') + '</div>';
  if (ui.view === 'tracker') html += renderTracker();
  else if (ui.view === 'library') html += renderLibrary();
  else if (ui.view === 'reports') html += renderReports();
  else if (ui.view === 'notfound') html += renderNotFound();
  else html += renderSettings();
  app.innerHTML = html;
  bind();
  clearInterval(ui.tickTimer);
  if (state.activeTimer) ui.tickTimer = setInterval(tick, 1000);
  if (!hashBound) {
    hashBound = true;
    window.addEventListener('hashchange', function () {
      try {
        var r = parseAppHash(window.location.hash);
        if (r && r.view !== ui.view) { ui.view = r.view; render(); }
      } catch (e) {}
    });
  }
}

/* ---------- events (delegated) ---------- */
function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }

function bind() {
  document.querySelectorAll('[data-view]').forEach(function (b) {
    b.onclick = function () { setRoute(b.getAttribute('data-view')); };
  });
  document.querySelectorAll('[data-go]').forEach(function (b) {
    b.onclick = function () { setRoute(b.getAttribute('data-go')); };
  });
  document.querySelectorAll('[data-role]').forEach(function (b) {
    b.onclick = function () { state.role = b.getAttribute('data-role'); saveState(state); window.hkTrack('onboarding_role', { role: state.role }); render(); };
  });
  var skip = document.getElementById('btn-skip-ob');
  if (skip) skip.onclick = function () { state.onboarded = true; saveState(state); window.hkTrack('onboarding_skipped', {}); render(); };
  var obCreate = document.getElementById('btn-ob-create');
  if (obCreate) obCreate.onclick = function () {
    var cn = val('ob-client').trim(), pn = val('ob-project').trim(), rate = parseFloat(val('ob-rate'));
    if (!cn) { toast('Give your client a name.', 'error'); return; }
    if (!pn) { toast('Give your project a name.', 'error'); return; }
    if (val('ob-rate') && !(rate >= 0)) { toast('Hourly rate must be zero or more.', 'error'); return; }
    var cid = uid(), pid = uid();
    state.clients.push({ id: cid, name: cn, archived: false, createdAt: Date.now() });
    state.projects.push({ id: pid, clientId: cid, name: pn, rate: isFinite(rate) ? rate : 0, billableDefault: true, archived: false, createdAt: Date.now() });
    state.onboarded = true; saveState(state);
    window.hkTrack('onboarding_completed', {}); window.hkTrack('first_project_created', {});
    ui.view = 'tracker'; render(); toast('Client and project created — start your first timer.');
  };
  var obSample = document.getElementById('btn-ob-sample');
  if (obSample) obSample.onclick = function () {
    var cid = uid(), pid = uid(), now = Date.now();
    state.clients.push({ id: cid, name: 'Sample client (example — delete anytime)', archived: false, createdAt: now });
    state.projects.push({ id: pid, clientId: cid, name: 'Sample project (example)', rate: 85, billableDefault: true, archived: false, createdAt: now });
    state.entries.push({ id: uid(), projectId: pid, startMs: now - 2 * 3600 * 1000, endMs: now - 3600 * 1000, description: 'Sample entry (example)', billable: true, createdAt: now });
    state.onboarded = true; saveState(state);
    window.hkTrack('onboarding_completed', { sample: true });
    ui.view = 'tracker'; render(); toast('Sample data added — clearly labeled, delete anytime.');
  };

  var bs = document.getElementById('btn-start');
  if (bs) bs.onclick = function () {
    if (startTimer(val('timer-project'), val('timer-desc').trim())) { window.hkTrack('first_timer_started', {}); announce('Timer started.'); }
  };
  var bp = document.getElementById('btn-stop');
  if (bp) bp.onclick = function () { stopTimer(); announce('Timer stopped and saved.'); };

  var se = document.getElementById('btn-save-entry');
  if (se) se.onclick = function () {
    var input = { date: val('f-date'), start: val('f-start'), end: val('f-end'), projectId: val('f-project'),
      description: val('f-desc').trim(), billable: document.getElementById('f-billable').checked };
    var errs = saveManualEntry(input);
    var box = document.getElementById('form-errors');
    if (errs.length) {
      box.hidden = false;
      box.innerHTML = '<strong>Please fix the following:</strong><ul>' + errs.map(function (e) { return '<li>' + escapeHtml(e) + '</li>'; }).join('') + '</ul>';
      announce('Entry has errors: ' + errs.join(' '));
    } else { toast(ui.editingEntryId ? 'Entry updated.' : 'Entry added.'); }
  };
  var ce = document.getElementById('btn-cancel-edit');
  if (ce) ce.onclick = function () { ui.editingEntryId = null; render(); };

  document.querySelectorAll('[data-edit]').forEach(function (b) {
    b.onclick = function () { ui.editingEntryId = b.getAttribute('data-edit'); ui.view = 'tracker'; render(); window.scrollTo(0, 0); };
  });
  document.querySelectorAll('[data-del]').forEach(function (b) {
    b.onclick = function () {
      if (!window.confirm('Delete this entry? This cannot be undone.')) return;
      state.entries = state.entries.filter(function (x) { return x.id !== b.getAttribute('data-del'); });
      saveState(state); render(); toast('Entry deleted.');
    };
  });

  var ac = document.getElementById('btn-add-client');
  if (ac) ac.onclick = function () {
    var name = (window.prompt('Client name:') || '').trim();
    if (!name) return;
    state.clients.push({ id: uid(), name: name, archived: false, createdAt: Date.now() });
    saveState(state); window.hkTrack('first_project_created', {}); render(); toast('Client added.');
  };
  document.querySelectorAll('[data-cadd-p]').forEach(function (b) {
    b.onclick = function () {
      var cid = b.getAttribute('data-cadd-p');
      var name = (window.prompt('Project name:') || '').trim();
      if (!name) return;
      var rate = parseFloat(window.prompt('Hourly rate (' + state.settings.currency + '), numbers only:', '0') || '0');
      if (!(rate >= 0)) { toast('Rate must be zero or more.', 'error'); return; }
      state.projects.push({ id: uid(), clientId: cid, name: name, rate: rate, billableDefault: true, archived: false, createdAt: Date.now() });
      saveState(state); render(); toast('Project added.');
    };
  });
  document.querySelectorAll('[data-cedit]').forEach(function (b) {
    b.onclick = function () {
      var c = state.clients.filter(function (x) { return x.id === b.getAttribute('data-cedit'); })[0];
      if (!c) return;
      var name = (window.prompt('Rename client:', c.name) || '').trim();
      if (!name) return;
      c.name = name; saveState(state); render();
    };
  });
  document.querySelectorAll('[data-cdel]').forEach(function (b) {
    b.onclick = function () {
      var cid = b.getAttribute('data-cdel');
      var n = state.projects.filter(function (p) { return p.clientId === cid; }).length;
      if (!window.confirm('Delete this client and its ' + n + ' project(s)? Time entries are kept but will show “(deleted project)”. This cannot be undone.')) return;
      state.clients = state.clients.filter(function (x) { return x.id !== cid; });
      state.projects = state.projects.filter(function (p) { return p.clientId !== cid; });
      saveState(state); render(); toast('Client deleted.');
    };
  });
  document.querySelectorAll('[data-pedit]').forEach(function (b) {
    b.onclick = function () {
      var p = projectById(b.getAttribute('data-pedit'));
      if (!p) return;
      var name = (window.prompt('Project name:', p.name) || '').trim();
      if (!name) return;
      var rate = parseFloat(window.prompt('Hourly rate (' + state.settings.currency + '):', String(p.rate || 0)) || '0');
      if (!(rate >= 0)) { toast('Rate must be zero or more.', 'error'); return; }
      p.name = name; p.rate = rate; saveState(state); render(); toast('Project updated.');
    };
  });
  document.querySelectorAll('[data-parch]').forEach(function (b) {
    b.onclick = function () {
      var p = projectById(b.getAttribute('data-parch'));
      if (!p) return;
      p.archived = !p.archived; saveState(state); render();
    };
  });
  document.querySelectorAll('[data-pdel]').forEach(function (b) {
    b.onclick = function () {
      if (!window.confirm('Delete this project? Its time entries are kept but will show “(deleted project)”. This cannot be undone.')) return;
      var pid = b.getAttribute('data-pdel');
      state.projects = state.projects.filter(function (p) { return p.id !== pid; });
      saveState(state); render(); toast('Project deleted.');
    };
  });

  document.querySelectorAll('[data-range]').forEach(function (b) {
    b.onclick = function () { ui.reportRange = b.getAttribute('data-range'); render(); };
  });
  var ar = document.getElementById('btn-apply-range');
  if (ar) ar.onclick = function () {
    ui.customFrom = val('r-from'); ui.customTo = val('r-to');
    if (!ui.customFrom || !ui.customTo) { toast('Pick both dates.', 'error'); return; }
    if (ui.customFrom > ui.customTo) { toast('Start date must be before end date.', 'error'); return; }
    render();
  };
  var csv = document.getElementById('btn-csv');
  if (csv) csv.onclick = function () {
    var list = entriesInRange();
    if (!list.length) { toast('Nothing to export in this range.', 'error'); return; }
    download('hourkeep-report.csv', entriesToCSV(list, state.projects, state.clients, effectiveTimeZone()), 'text/csv');
    window.hkTrack('report_exported', { format: 'csv', count: list.length });
    toast('CSV downloaded.');
  };

  var sc = document.getElementById('s-currency');
  if (sc) sc.onchange = function () { state.settings.currency = sc.value; saveState(state); render(); toast('Currency set to ' + sc.value + '.'); };
  var st = document.getElementById('s-tz');
  if (st) st.onchange = function () { state.settings.timeZone = st.value; saveState(state); render(); toast('Time zone updated.'); };
  var ej = document.getElementById('btn-export-json');
  if (ej) ej.onclick = function () {
    download('hourkeep-backup.json', JSON.stringify(state, null, 2), 'application/json');
    window.hkTrack('data_exported', { format: 'json' });
    toast('Full backup downloaded.');
  };
  var wipe = document.getElementById('btn-wipe');
  if (wipe) wipe.onclick = function () {
    if (!window.confirm('Permanently delete ALL HourKeep data in this browser? This cannot be undone.')) return;
    if (!window.confirm('Last chance — every client, project and entry will be gone. Delete everything?')) return;
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    state = sanitizeState(null);
    ui.view = 'tracker'; saveState(state); render();
    toast('All data deleted.');
  };
}

render();
announce(state.activeTimer ? 'A timer is running.' : 'HourKeep tracker loaded.');

}
)();
