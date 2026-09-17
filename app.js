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

/** Live duration preview for the manual-entry form. Returns ms, or 0 when inputs are incomplete/invalid. */
function previewDurationMs(dateStr, startStr, endStr) {
  if (!dateStr || !startStr || !endStr) return 0;
  var s = new Date(dateStr + 'T' + startStr + ':00').getTime();
  var e = new Date(dateStr + 'T' + endStr + ':00').getTime();
  if (!isFinite(s) || !isFinite(e)) return 0;
  if (startStr === endStr) return 0;
  if (e <= s) e += 24 * 3600 * 1000; // crosses midnight
  var ms = e - s;
  if (ms <= 0 || ms > 24 * 3600 * 1000) return 0;
  return ms;
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
    if (typeof raw.activeTimer.billable === 'boolean') s.activeTimer.billable = raw.activeTimer.billable;
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
  previewDurationMs: previewDurationMs,
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
var ui = { view: 'tracker', reportRange: 'week', customFrom: null, customTo: null, editingEntryId: null, tickTimer: null,
  search: '', modal: null, tourStep: 0, wizardClient: '', wizardProject: '', wizardRate: '' };

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
function startTimer(projectId, description, billableOverride) {
  if (state.activeTimer) { toast('A timer is already running. Stop it first.', 'error'); return false; }
  if (!projectById(projectId)) { toast('Choose a project first.', 'error'); return false; }
  state.activeTimer = { projectId: projectId, startMs: Date.now(), description: description || '' };
  if (typeof billableOverride === 'boolean') state.activeTimer.billable = billableOverride;
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
  var billable = (typeof t.billable === 'boolean') ? t.billable : (p ? p.billableDefault !== false : true);
  state.entries.push({ id: uid(), projectId: t.projectId, startMs: t.startMs, endMs: endMs,
    description: t.description || '', billable: billable, createdAt: endMs });
  state.activeTimer = null;
  saveState(state);
  window.hkTrack('timer_stopped', {});
  render();
  toast('Timer stopped and saved.');
  return true;
}
function tick() {
  if (!state.activeTimer) return;
  var ms = timerElapsedMs(state.activeTimer.startMs, Date.now());
  var el = document.getElementById('timer-elapsed');
  if (el) el.textContent = formatElapsed(ms);
  var amt = document.getElementById('timer-amount');
  if (amt) amt.textContent = liveAmountText(state.activeTimer, ms);
}

/** Live earnings line for a running timer. Pure computation, no side effects. */
function liveAmountText(t, ms) {
  var p = projectById(t.projectId);
  var billable = (typeof t.billable === 'boolean') ? t.billable : (p ? p.billableDefault !== false : true);
  if (!p || !billable) return 'Non-billable · time only';
  var rate = p.rate || 0;
  if (!(rate > 0)) return 'Billable · no rate set';
  return '≈ ' + money(calcCents(msToHours(ms), rate)) + ' so far · ' + money(Math.round(rate * 100)) + '/hr';
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

function recentProjectIds(limit) {
  var seen = {}, out = [];
  var sorted = state.entries.slice().sort(function (a, b) { return b.startMs - a.startMs; });
  sorted.forEach(function (en) {
    if (out.length >= (limit || 3)) return;
    if (!seen[en.projectId] && projectById(en.projectId) && !projectById(en.projectId).archived) {
      seen[en.projectId] = true; out.push(en.projectId);
    }
  });
  activeProjects().forEach(function (p) {
    if (out.length >= (limit || 3)) return;
    if (!seen[p.id]) { seen[p.id] = true; out.push(p.id); }
  });
  return out;
}

function renderSetupWizard() {
  return '' +
  '<section class="card timer-card timer-dark" aria-label="Get set up in 30 seconds">' +
    '<div class="timer-top"><h2>Get set up in 30 seconds</h2><span class="pill live"><span class="dot"></span>Step 1 of 1</span></div>' +
    '<p class="timer-sub">HourKeep needs one client and one project before your first timer. Fill this in once — no extra pages.</p>' +
    '<div class="wizard-steps" aria-label="Setup steps">' +
      '<div class="wstep"><span class="wnum">1</span><div><b>Name your client</b><small>Who pays the invoice? e.g. Acme Studio</small></div></div>' +
      '<div class="wstep"><span class="wnum">2</span><div><b>Name the work</b><small>e.g. Website redesign · set an hourly rate</small></div></div>' +
      '<div class="wstep"><span class="wnum">3</span><div><b>Press Start</b><small>Your timer appears here with live earnings</small></div></div>' +
    '</div>' +
    '<div class="form-grid">' +
      '<div><label for="wz-client">Client name</label><input id="wz-client" type="text" maxlength="80" placeholder="e.g. Acme Studio" autocomplete="organization"></div>' +
      '<div><label for="wz-project">Project name</label><input id="wz-project" type="text" maxlength="80" placeholder="e.g. Website redesign"></div>' +
      '<div><label for="wz-rate">Hourly rate (' + escapeHtml(state.settings.currency) + ')</label><input id="wz-rate" type="number" min="0" step="0.01" placeholder="e.g. 85"></div>' +
      '<div><label class="check"><input id="wz-billable" type="checkbox" checked> This work is billable</label></div>' +
    '</div>' +
    '<button class="btn-start" id="btn-wizard-create">Create &amp; show my timer →</button>' +
    '<p class="wizard-alt">Just exploring? <button class="linkbtn light" id="btn-wizard-sample">Add labeled sample data</button></p>' +
  '</section>';
}

function renderTimerCard() {
  var t = state.activeTimer;
  if (!t && activeProjects().length === 0) return renderSetupWizard();
  var desc = t ? t.description : '';
  var proj = t ? t.projectId : (activeProjects()[0] ? activeProjects()[0].id : '');
  var p = t ? projectById(t.projectId) : projectById(proj);
  var pname = p ? (clientName(p.clientId) + ' · ' + p.name) : 'No project yet';
  var billDefault = t
    ? ((typeof t.billable === 'boolean') ? t.billable : (p ? p.billableDefault !== false : true))
    : (p ? p.billableDefault !== false : true);
  var recents = recentProjectIds(3).map(function (id) {
    var rp = projectById(id);
    if (!rp || id === proj) return '';
    return '<button class="recent" data-recent="' + id + '">' + escapeHtml(rp.name) + '</button>';
  }).join('');
  if (t) {
    return '' +
    '<section class="card timer-card timer-dark running" aria-label="Timer running">' +
      '<div class="timer-top"><h2>Timer running</h2><span class="pill live"><span class="dot"></span>Live</span></div>' +
      '<div class="timer-elapsed" id="timer-elapsed" role="timer" aria-live="off">' + formatElapsed(timerElapsedMs(t.startMs, Date.now())) + '</div>' +
      '<p class="timer-sub">Started <strong>' + escapeHtml(fmtDateTime(t.startMs)) + '</strong> · ' + escapeHtml(pname) +
        (desc ? ' · “' + escapeHtml(desc) + '”' : '') + '</p>' +
      '<span class="timer-amount' + ((!p || !billDefault || !(p.rate > 0)) ? ' nonbill' : '') + '" id="timer-amount">' +
        escapeHtml(liveAmountText(t, timerElapsedMs(t.startMs, Date.now()))) + '</span>' +
      '<div class="row-btns timer-actions">' +
        '<button class="btn-stop" id="btn-stop">Stop &amp; save entry</button>' +
        '<button class="btn ghost light-ghost" id="btn-discard">Discard</button>' +
      '</div>' +
      '<p class="timer-hint">Stopping saves an entry to Today below. Safe to refresh — the timer uses timestamps, not counters.</p>' +
    '</section>';
  }
  return '' +
  '<section class="card timer-card timer-dark" aria-label="Start a timer">' +
    '<div class="timer-top"><h2>What are you working on?</h2></div>' +
    '<div class="timer-elapsed idle" aria-hidden="true">00:00:00</div>' +
    '<p class="timer-sub">Pick a project, describe the task, press Start. That is the whole workflow.</p>' +
    (recents ? '<div class="recents" aria-label="Recent projects"><span>Recent:</span> ' + recents + '</div>' : '') +
    '<div class="form-grid">' +
      '<div><label for="timer-project">Project</label>' +
      '<select id="timer-project">' + projectOptions(proj) + '</select>' +
      '<button class="linkbtn light" id="btn-timer-new-project">+ New project</button></div>' +
      '<div><label for="timer-desc">What task? <span class="opt">(optional, helps invoicing)</span></label>' +
      '<input id="timer-desc" type="text" maxlength="140" placeholder="e.g. Homepage wireframes v2"></div>' +
      '<div class="span2"><label class="check"><input id="timer-billable" type="checkbox"' + (billDefault ? ' checked' : '') + '> Billable at ' +
        escapeHtml(money(Math.round(((p && p.rate) || 0) * 100))) + '/hr</label></div>' +
    '</div>' +
    '<button class="btn-start" id="btn-start">▶ Start timer</button>' +
    '<p class="timer-hint">Tip: press <kbd>S</kbd> to start/stop. Timer keeps running if you refresh or close the tab.</p>' +
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
  '<details class="card manual"' + (editing ? ' open' : '') + ' aria-label="' + (editing ? 'Edit time entry' : 'Add time manually') + '">' +
    '<summary class="manual-sum"><span><b>' + (editing ? 'Edit entry' : 'Forgot to start the timer? Add time manually') + '</b>' +
    '<small>For past work — date, start &amp; end, done.</small></span><span class="sum-chev" aria-hidden="true">＋</span></summary>' +
    '<div id="form-errors" class="form-errors" role="alert" hidden></div>' +
    '<div class="form-grid">' +
      '<div><label for="f-date">Date</label><input id="f-date" type="date" value="' + d + '" required></div>' +
      '<div><label for="f-project">Project</label><select id="f-project">' + projectOptions(proj) + '</select></div>' +
      '<div><label for="f-start">Start</label><input id="f-start" type="time" value="' + s + '" required></div>' +
      '<div><label for="f-end">End <span class="opt">(earlier than start = next day)</span></label><input id="f-end" type="time" value="' + e + '" required></div>' +
      '<div class="span2"><label for="f-desc">What did you do? <span class="opt">(shows on the invoice)</span></label>' +
      '<input id="f-desc" type="text" maxlength="140" placeholder="e.g. Client feedback round 2" value="' + escapeHtml(editing ? editing.description : '') + '"></div>' +
      '<div><label class="check"><input id="f-billable" type="checkbox"' + (bill ? ' checked' : '') + '> Billable</label></div>' +
      '<div class="dur-preview" aria-live="polite"><small>Duration</small><b id="dur-preview">—</b></div>' +
    '</div>' +
    '<div class="row-btns">' +
      '<button class="btn solid btn-inline" id="btn-save-entry">' + (editing ? 'Save changes' : 'Add entry') + '</button>' +
      (editing ? '<button class="btn ghost btn-inline" id="btn-cancel-edit">Cancel</button>' : '') +
    '</div>' +
  '</details>';
}

function renderEntryList(list, title) {
  var tz = effectiveTimeZone();
  var q = (ui.search || '').trim().toLowerCase();
  var filtered = q ? list.filter(function (en) {
    var pmap2 = {};
    state.projects.forEach(function (p) { pmap2[p.id] = p; });
    var p = pmap2[en.projectId] || { name: '' };
    return ((en.description || '') + ' ' + p.name + ' ' + clientName(p.clientId)).toLowerCase().indexOf(q) >= 0;
  }) : list;
  var head = '<div class="list-head"><h2>' + title + ' <span class="count">' + list.length + '</span></h2>' +
    (list.length > 2 ? '<input id="entry-search" type="search" placeholder="Filter today…" value="' + escapeHtml(ui.search || '') + '" aria-label="Filter today\'s entries">' : '') + '</div>';
  if (!list.length) {
    return '<section class="card"><h2>' + title + '</h2><div class="empty">' +
      '<p><strong>Nothing here yet — that is normal.</strong></p><p class="muted">Press <b>Start timer</b> above when work begins, <b>Stop &amp; save</b> when it ends. Your entry lands here with hours + amount calculated.</p>' +
      '<p class="muted small">New here? <a href="guide-employee.html">Employee quick-start (60 sec)</a> · <a href="guide-employer.html">Owner quick-start</a></p></div></section>';
  }
  if (!filtered.length) {
    return '<section class="card">' + head + '<div class="empty"><p class="muted">No entries match “' + escapeHtml(ui.search) + '”. <button class="linkbtn" id="btn-clear-search">Clear filter</button></p></div></section>';
  }
  var pmap = {}; state.projects.forEach(function (p) { pmap[p.id] = p; });
  var rows = filtered.map(function (en) {
    var p = pmap[en.projectId] || { name: '(deleted project)', rate: 0, clientId: null };
    var ms = entryDurationMs(en.startMs, en.endMs);
    var cents = en.billable ? calcCents(msToHours(ms), p.rate || 0) : 0;
    return '<li class="entry">' +
      '<div class="entry-main"><strong>' + escapeHtml(p.name) + '</strong>' +
      '<span class="muted">' + escapeHtml(clientName(p.clientId)) + ' · ' +
      escapeHtml(fmtTime(en.startMs)) + '–' + escapeHtml(fmtTime(en.endMs)) +
      '<span class="hchip">' + msToHours(ms).toFixed(2) + 'h</span>' +
      (en.description ? ' · ' + escapeHtml(en.description) : '') + '</span></div>' +
      '<div class="entry-side"><span class="pill ' + (en.billable ? 'bill' : 'nonbill') + '">' + (en.billable ? money(cents) + ' · billable' : 'non-billable') + '</span>' +
      '<button class="linkbtn" data-edit="' + en.id + '">Edit</button>' +
      '<button class="linkbtn danger" data-del="' + en.id + '">Delete</button></div></li>';
  }).join('');
  return '<section class="card">' + head + '<ul class="entries">' + rows + '</ul></section>';
}

function renderHelpStrip() {
  return '<div class="help-strip" aria-label="Help">' +
    '<span><b>New here?</b> Learn the workflow in 60 seconds:</span>' +
    '<span class="help-links"><button class="linkbtn" id="btn-tour">Take the guided tour</button> · ' +
    '<a href="guide-employee.html">If you log hours</a> · <a href="guide-employer.html">If you review / invoice</a></span></div>';
}

function renderWelcome() {
  if (state.onboarded) return '';
  var hasData = state.clients.length || state.projects.length || state.entries.length;
  return '<section class="card welcome" aria-label="Welcome">' +
    '<div class="welcome-main"><h2>Welcome — here is the whole app in 3 steps</h2>' +
    '<ol class="welcome-steps"><li><b>Start</b> the timer when work begins</li><li><b>Stop</b> when it ends — entry saved</li><li><b>Review</b> in Reports, export CSV for invoices</li></ol></div>' +
    '<div class="row-btns"><button class="btn solid btn-inline" id="btn-welcome-got">Got it, hide this</button> ' +
    (hasData ? '' : '<button class="btn ghost btn-inline" id="btn-welcome-sample">Show me with sample data</button>') + '</div></section>';
}

function renderTracker() {
  var tz = effectiveTimeZone();
  var today = tzDateKey(Date.now(), tz);
  var list = state.entries.filter(function (en) { return tzDateKey(en.startMs, tz) === today; })
    .sort(function (a, b) { return b.startMs - a.startMs; });
  var pmap = {};
  state.projects.forEach(function (p) { pmap[p.id] = p; });
  var sum = summarize(list, pmap);
  var strip = '<div class="today-strip" aria-label="Today at a glance">' +
    '<div class="today-cell"><small>Today</small><b>' + msToHours(sum.totalMs).toFixed(2) + '<em>h</em></b></div>' +
    '<div class="today-cell"><small>Billable</small><b>' + money(sum.billCents) + '</b></div>' +
    '<div class="today-cell"><small>Entries</small><b>' + list.length + '</b></div></div>';
  return renderWelcome() + renderHelpStrip() + renderTimerCard() + strip + renderEntryForm() + renderEntryList(list, "Today's entries");
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

function renderOnboarding() { return ''; } // replaced by non-blocking welcome banner (renderWelcome)

function renderModal() {
  var m = ui.modal;
  if (!m) return '';
  var inner = '';
  if (m.type === 'client') {
    inner = '<h2>New client</h2><p class="muted">Who pays the invoice?</p>' +
      '<div class="form-grid"><div class="span2"><label for="m-client-name">Client name</label>' +
      '<input id="m-client-name" type="text" maxlength="80" placeholder="e.g. Acme Studio"></div></div>' +
      '<div class="row-btns"><button class="btn solid btn-inline" id="m-save">Add client</button> ' +
      '<button class="btn ghost btn-inline" id="m-cancel">Cancel</button></div>';
  } else if (m.type === 'project') {
    var copts = state.clients.map(function (c) {
      return '<option value="' + c.id + '"' + (c.id === m.clientId ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>';
    }).join('') || '<option value="">No clients yet</option>';
    inner = '<h2>New project</h2><p class="muted">Projects belong to a client and carry an hourly rate.</p>' +
      '<div class="form-grid"><div><label for="m-proj-client">Client</label><select id="m-proj-client">' + copts + '</select></div>' +
      '<div><label for="m-proj-name">Project name</label><input id="m-proj-name" type="text" maxlength="80" placeholder="e.g. Website redesign"></div>' +
      '<div><label for="m-proj-rate">Hourly rate (' + escapeHtml(state.settings.currency) + ')</label><input id="m-proj-rate" type="number" min="0" step="0.01" placeholder="e.g. 85"></div>' +
      '<div><label class="check"><input id="m-proj-bill" type="checkbox" checked> Billable by default</label></div></div>' +
      '<div class="row-btns"><button class="btn solid btn-inline" id="m-save">Add project</button> ' +
      '<button class="btn ghost btn-inline" id="m-cancel">Cancel</button></div>';
  } else if (m.type === 'rename-client') {
    var c0 = state.clients.filter(function (x) { return x.id === m.id; })[0];
    inner = '<h2>Rename client</h2><div class="form-grid"><div class="span2"><label for="m-rename">Name</label>' +
      '<input id="m-rename" type="text" maxlength="80" value="' + escapeHtml(c0 ? c0.name : '') + '"></div></div>' +
      '<div class="row-btns"><button class="btn solid btn-inline" id="m-save">Save</button> ' +
      '<button class="btn ghost btn-inline" id="m-cancel">Cancel</button></div>';
  } else if (m.type === 'edit-project') {
    var p0 = projectById(m.id);
    inner = '<h2>Edit project</h2><div class="form-grid">' +
      '<div><label for="m-proj-name">Project name</label><input id="m-proj-name" type="text" maxlength="80" value="' + escapeHtml(p0 ? p0.name : '') + '"></div>' +
      '<div><label for="m-proj-rate">Hourly rate (' + escapeHtml(state.settings.currency) + ')</label><input id="m-proj-rate" type="number" min="0" step="0.01" value="' + escapeHtml(String((p0 && p0.rate) || 0)) + '"></div></div>' +
      '<div class="row-btns"><button class="btn solid btn-inline" id="m-save">Save</button> ' +
      '<button class="btn ghost btn-inline" id="m-cancel">Cancel</button></div>';
  } else if (m.type === 'confirm') {
    inner = '<h2>' + escapeHtml(m.title || 'Are you sure?') + '</h2><p class="muted">' + escapeHtml(m.message || '') + '</p>' +
      '<div class="row-btns"><button class="btn solid btn-inline danger-solid" id="m-save">' + escapeHtml(m.confirmLabel || 'Delete') + '</button> ' +
      '<button class="btn ghost btn-inline" id="m-cancel">Keep it</button></div>';
  }
  return '<div class="ob-overlay" id="modal-overlay"><div class="ob-card" role="dialog" aria-modal="true" aria-label="Dialog">' + inner + '</div></div>';
}

var TOUR_STEPS = [
  { t: 'Step 1 — Start the timer', d: 'Pick a project, type what you are doing, press Start. The timer shows elapsed time and live earnings. Refresh-safe: it uses timestamps.' },
  { t: 'Step 2 — Stop, review today', d: 'Press “Stop & save entry”. The entry lands in Today\u2019s entries with hours + amount. Use “Add time manually” only for past work you forgot to time.' },
  { t: 'Step 3 — Report & invoice', d: 'Open Reports → pick This week → check totals by client → Export CSV and attach it to your invoice. Settings holds currency, time zone, backup and delete.' }
];

function renderTour() {
  if (!ui.tourStep) return '';
  var s = TOUR_STEPS[ui.tourStep - 1];
  return '<div class="ob-overlay"><div class="ob-card tour" role="dialog" aria-modal="true" aria-label="Guided tour">' +
    '<p class="tour-count">Guided tour · ' + ui.tourStep + ' of ' + TOUR_STEPS.length + '</p>' +
    '<h2>' + escapeHtml(s.t) + '</h2><p class="muted">' + escapeHtml(s.d) + '</p>' +
    '<div class="row-btns"><button class="btn solid btn-inline" id="btn-tour-next">' + (ui.tourStep >= TOUR_STEPS.length ? 'Finish tour' : 'Next →') + '</button> ' +
    '<button class="linkbtn" id="btn-tour-skip">Skip tour</button></div></div></div>';
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
  var tabs = [['tracker', 'Tracker', 'Today + timer'], ['library', 'Clients & projects', 'Rates + setup'], ['reports', 'Reports', 'Totals + CSV'], ['settings', 'Settings', 'Currency + backup']];
  var html = '<div class="tabs" role="tablist" aria-label="Tracker sections">' +
    tabs.map(function (t) {
      var count = t[0] === 'tracker' ? state.entries.length : (t[0] === 'library' ? state.projects.length : '');
      return '<button role="tab" aria-selected="' + (ui.view === t[0]) + '" class="tab' + (ui.view === t[0] ? ' on' : '') + '" data-view="' + t[0] + '" title="' + t[2] + '">' + t[1] +
        (count !== '' && count ? ' <span class="tab-count">' + count + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  if (ui.view === 'tracker') html += renderTracker();
  else if (ui.view === 'library') html += renderLibrary();
  else if (ui.view === 'reports') html += renderReports();
  else if (ui.view === 'notfound') html += renderNotFound();
  else html += renderSettings();
  html += renderModal() + renderTour();
  app.innerHTML = html;
  bind();
  updateDurPreview();
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
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && (ui.modal || ui.tourStep)) { ui.modal = null; ui.tourStep = 0; render(); }
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if ((e.key === 's' || e.key === 'S') && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA' && ui.view === 'tracker' && !ui.modal && !ui.tourStep) {
        e.preventDefault();
        if (state.activeTimer) stopTimer(); else { var b = document.getElementById('btn-start'); if (b) b.click(); }
      }
    });
  }
}

/** Refresh the live duration preview under the manual-entry form. */
function updateDurPreview() {
  var el = document.getElementById('dur-preview');
  if (!el) return;
  var ms = previewDurationMs(val('f-date'), val('f-start'), val('f-end'));
  if (!ms) { el.textContent = '—'; return; }
  var p = projectById(val('f-project'));
  var rate = (p && p.rate) || 0;
  var bill = document.getElementById('f-billable');
  var isBill = bill ? bill.checked : true;
  el.textContent = msToHours(ms).toFixed(2) + 'h' + (isBill && rate > 0 ? ' · ≈ ' + money(calcCents(msToHours(ms), rate)) : '');
}

function addSampleData() {
  var now = Date.now();
  var cid = uid(), pid = uid();
  state.clients.push({ id: cid, name: 'Sample client (example — delete anytime)', archived: false, createdAt: now });
  state.projects.push({ id: pid, clientId: cid, name: 'Sample project (example)', rate: 85, billableDefault: true, archived: false, createdAt: now });
  state.entries.push({ id: uid(), projectId: pid, startMs: now - 2 * 3600 * 1000, endMs: now - 3600 * 1000, description: 'Sample entry (example)', billable: true, createdAt: now });
  state.onboarded = true; saveState(state);
  window.hkTrack('onboarding_completed', { sample: true });
  ui.view = 'tracker'; render(); toast('Sample data added — clearly labeled, delete anytime.');
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

  // welcome + tour
  var wg = document.getElementById('btn-welcome-got');
  if (wg) wg.onclick = function () { state.onboarded = true; saveState(state); render(); };
  var ws = document.getElementById('btn-welcome-sample');
  if (ws) ws.onclick = addSampleData;
  var bt = document.getElementById('btn-tour');
  if (bt) bt.onclick = function () { ui.tourStep = 1; render(); window.hkTrack('tour_started', {}); };
  var btnNext = document.getElementById('btn-tour-next');
  if (btnNext) btnNext.onclick = function () {
    if (ui.tourStep >= TOUR_STEPS.length) { ui.tourStep = 0; state.onboarded = true; saveState(state); render(); toast('Tour done — start your first timer.'); }
    else { ui.tourStep++; render(); }
  };
  var btnSkip = document.getElementById('btn-tour-skip');
  if (btnSkip) btnSkip.onclick = function () { ui.tourStep = 0; render(); };

  // setup wizard (zero-project state)
  var wz = document.getElementById('btn-wizard-create');
  if (wz) wz.onclick = function () {
    var cn = val('wz-client').trim(), pn = val('wz-project').trim(), rate = parseFloat(val('wz-rate'));
    if (!cn) { toast('Name your client first — e.g. Acme Studio.', 'error'); return; }
    if (!pn) { toast('Name the project — e.g. Website redesign.', 'error'); return; }
    if (val('wz-rate') !== '' && !(rate >= 0)) { toast('Hourly rate must be zero or more.', 'error'); return; }
    var bill = document.getElementById('wz-billable').checked;
    var cid = uid(), pid = uid();
    state.clients.push({ id: cid, name: cn, archived: false, createdAt: Date.now() });
    state.projects.push({ id: pid, clientId: cid, name: pn, rate: isFinite(rate) ? rate : 0, billableDefault: bill, archived: false, createdAt: Date.now() });
    state.onboarded = true; saveState(state);
    window.hkTrack('onboarding_completed', {}); window.hkTrack('first_project_created', {});
    render(); toast('Ready — press Start timer when work begins.');
  };
  var wzs = document.getElementById('btn-wizard-sample');
  if (wzs) wzs.onclick = addSampleData;

  // timer
  document.querySelectorAll('[data-recent]').forEach(function (b) {
    b.onclick = function () {
      var sel = document.getElementById('timer-project');
      if (sel) { sel.value = b.getAttribute('data-recent'); sel.dispatchEvent(new Event('change')); render(); }
    };
  });
  var tp = document.getElementById('timer-project');
  if (tp) tp.onchange = function () {
    var p = projectById(tp.value);
    var cb = document.getElementById('timer-billable');
    if (cb && p) cb.checked = p.billableDefault !== false;
    var lbl = cb ? cb.parentElement : null;
    if (lbl && p) lbl.lastChild.textContent = ' Billable at ' + money(Math.round((p.rate || 0) * 100)) + '/hr';
  };
  var tnp = document.getElementById('btn-timer-new-project');
  if (tnp) tnp.onclick = function () {
    if (!state.clients.length) { ui.modal = { type: 'client', after: 'project' }; render(); }
    else { ui.modal = { type: 'project' }; render(); }
  };
  var bs = document.getElementById('btn-start');
  if (bs) bs.onclick = function () {
    var billEl = document.getElementById('timer-billable');
    var bill = billEl ? billEl.checked : true;
    if (startTimer(val('timer-project'), val('timer-desc').trim(), bill)) { window.hkTrack('first_timer_started', {}); announce('Timer started.'); }
  };
  var bp = document.getElementById('btn-stop');
  if (bp) bp.onclick = function () { stopTimer(); announce('Timer stopped and saved.'); };
  var bd = document.getElementById('btn-discard');
  if (bd) bd.onclick = function () {
    ui.modal = { type: 'confirm', title: 'Discard running timer?', message: 'The elapsed time will be thrown away. This cannot be undone.', confirmLabel: 'Discard timer', action: 'discard-timer' };
    render();
  };

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
  ['f-date', 'f-start', 'f-end', 'f-project', 'f-billable'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) { el.addEventListener('input', updateDurPreview); el.addEventListener('change', updateDurPreview); }
  });
  var ce = document.getElementById('btn-cancel-edit');
  if (ce) ce.onclick = function () { ui.editingEntryId = null; render(); };
  var es = document.getElementById('entry-search');
  if (es) es.oninput = function () { ui.search = es.value; var pos = es.selectionStart; render(); var n = document.getElementById('entry-search'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } };
  var cs = document.getElementById('btn-clear-search');
  if (cs) cs.onclick = function () { ui.search = ''; render(); };

  document.querySelectorAll('[data-edit]').forEach(function (b) {
    b.onclick = function () { ui.editingEntryId = b.getAttribute('data-edit'); ui.view = 'tracker'; ui.search = ''; render(); window.scrollTo(0, 0); };
  });
  document.querySelectorAll('[data-del]').forEach(function (b) {
    b.onclick = function () {
      ui.modal = { type: 'confirm', title: 'Delete this entry?', message: 'Hours and amount will be removed. This cannot be undone.', confirmLabel: 'Delete entry', action: 'del-entry', id: b.getAttribute('data-del') };
      render();
    };
  });

  // modal buttons
  var mc = document.getElementById('m-cancel');
  if (mc) mc.onclick = function () { ui.modal = null; render(); };
  var mo = document.getElementById('modal-overlay');
  if (mo) mo.addEventListener('mousedown', function (e) { if (e.target === mo) { ui.modal = null; render(); } });
  var msv = document.getElementById('m-save');
  if (msv && ui.modal) (function (m) {
    msv.onclick = function () {
      if (m.type === 'client') {
        var name = val('m-client-name').trim();
        if (!name) { toast('Give the client a name.', 'error'); return; }
        state.clients.push({ id: uid(), name: name, archived: false, createdAt: Date.now() });
        saveState(state); window.hkTrack('first_project_created', {});
        ui.modal = (m.after === 'project') ? { type: 'project', clientId: state.clients[state.clients.length - 1].id } : null;
        render(); toast('Client added' + (ui.modal ? ' — now add the project.' : '.'));
      } else if (m.type === 'project') {
        var cid = val('m-proj-client');
        var pname = val('m-proj-name').trim();
        var rate = parseFloat(val('m-proj-rate'));
        var bill = document.getElementById('m-proj-bill').checked;
        if (!cid) { toast('Create a client first.', 'error'); return; }
        if (!pname) { toast('Name the project.', 'error'); return; }
        if (val('m-proj-rate') !== '' && !(rate >= 0)) { toast('Rate must be zero or more.', 'error'); return; }
        state.projects.push({ id: uid(), clientId: cid, name: pname, rate: isFinite(rate) ? rate : 0, billableDefault: bill, archived: false, createdAt: Date.now() });
        saveState(state); ui.modal = null; render(); toast('Project added — pick it and press Start.');
      } else if (m.type === 'rename-client') {
        var nn = val('m-rename').trim();
        if (!nn) { toast('Name cannot be empty.', 'error'); return; }
        var c = state.clients.filter(function (x) { return x.id === m.id; })[0];
        if (c) c.name = nn;
        saveState(state); ui.modal = null; render();
      } else if (m.type === 'edit-project') {
        var pp = projectById(m.id);
        var nm = val('m-proj-name').trim();
        var rt = parseFloat(val('m-proj-rate'));
        if (!nm) { toast('Name cannot be empty.', 'error'); return; }
        if (!(rt >= 0)) { toast('Rate must be zero or more.', 'error'); return; }
        if (pp) { pp.name = nm; pp.rate = rt; }
        saveState(state); ui.modal = null; render(); toast('Project updated.');
      } else if (m.type === 'confirm') {
        if (m.action === 'discard-timer') { state.activeTimer = null; saveState(state); ui.modal = null; render(); toast('Timer discarded.'); }
        else if (m.action === 'del-entry') { state.entries = state.entries.filter(function (x) { return x.id !== m.id; }); saveState(state); ui.modal = null; render(); toast('Entry deleted.'); }
        else if (m.action === 'del-client') {
          state.clients = state.clients.filter(function (x) { return x.id !== m.id; });
          state.projects = state.projects.filter(function (p) { return p.clientId !== m.id; });
          saveState(state); ui.modal = null; render(); toast('Client deleted.');
        }
        else if (m.action === 'del-project') {
          state.projects = state.projects.filter(function (p) { return p.id !== m.id; });
          saveState(state); ui.modal = null; render(); toast('Project deleted.');
        }
        else if (m.action === 'wipe') {
          try { localStorage.removeItem(LS_KEY); } catch (e) {}
          state = sanitizeState(null);
          ui.view = 'tracker'; ui.modal = null; saveState(state); render();
          toast('All data deleted.');
        }
      }
    };
  })(ui.modal);

  var ac = document.getElementById('btn-add-client');
  if (ac) ac.onclick = function () { ui.modal = { type: 'client' }; render(); var f = document.getElementById('m-client-name'); if (f) f.focus(); };
  document.querySelectorAll('[data-cadd-p]').forEach(function (b) {
    b.onclick = function () { ui.modal = { type: 'project', clientId: b.getAttribute('data-cadd-p') }; render(); };
  });
  document.querySelectorAll('[data-cedit]').forEach(function (b) {
    b.onclick = function () { ui.modal = { type: 'rename-client', id: b.getAttribute('data-cedit') }; render(); };
  });
  document.querySelectorAll('[data-cdel]').forEach(function (b) {
    b.onclick = function () {
      var cid = b.getAttribute('data-cdel');
      var n = state.projects.filter(function (p) { return p.clientId === cid; }).length;
      ui.modal = { type: 'confirm', title: 'Delete this client?', message: 'Its ' + n + ' project(s) go too. Past time entries are kept but show “(deleted project)”.', confirmLabel: 'Delete client', action: 'del-client', id: cid };
      render();
    };
  });
  document.querySelectorAll('[data-pedit]').forEach(function (b) {
    b.onclick = function () { ui.modal = { type: 'edit-project', id: b.getAttribute('data-pedit') }; render(); };
  });
  document.querySelectorAll('[data-parch]').forEach(function (b) {
    b.onclick = function () {
      var p = projectById(b.getAttribute('data-parch'));
      if (!p) return;
      p.archived = !p.archived; saveState(state); render();
      toast(p.archived ? 'Project archived — hidden from the timer.' : 'Project restored.');
    };
  });
  document.querySelectorAll('[data-pdel]').forEach(function (b) {
    b.onclick = function () {
      ui.modal = { type: 'confirm', title: 'Delete this project?', message: 'Its time entries are kept but will show “(deleted project)”. This cannot be undone.', confirmLabel: 'Delete project', action: 'del-project', id: b.getAttribute('data-pdel') };
      render();
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
    ui.modal = { type: 'confirm', title: 'Delete ALL data?', message: 'Every client, project and entry in this browser will be gone. Export a JSON backup first if unsure.', confirmLabel: 'Yes, delete everything', action: 'wipe' };
    render();
  };
}

render();
announce(state.activeTimer ? 'A timer is running.' : 'HourKeep tracker loaded.');

}
)();
