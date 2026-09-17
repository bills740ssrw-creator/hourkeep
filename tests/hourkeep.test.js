/* HourKeep unit tests — pure logic from app.js (no DOM required).
 * Run: node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const hk = require('../app.js');

// 1–3. Timer math: elapsed from timestamps, incl. sleep/wake-sized gaps.
test('timerElapsedMs measures from timestamps, not counters', () => {
  const start = 1_700_000_000_000;
  assert.equal(hk.timerElapsedMs(start, start + 5_000), 5_000);
  // 8-hour laptop sleep: still exact, no interval drift.
  assert.equal(hk.timerElapsedMs(start, start + 8 * 3600 * 1000), 28_800_000);
  assert.equal(hk.timerElapsedMs(start, start - 1_000), 0); // clock skew never negative
});

test('formatElapsed renders HH:MM:SS', () => {
  assert.equal(hk.formatElapsed(0), '00:00:00');
  assert.equal(hk.formatElapsed(8_076_000), '02:14:36');
  assert.equal(hk.formatElapsed(90_061_000), '25:01:01');
});

// 4. Duration validation: negative, zero, impossible.
test('validateEntry rejects missing fields', () => {
  const errs = hk.validateEntry({ date: '', start: '', end: '', projectId: '' });
  assert.ok(errs.length >= 3);
});

test('validateEntry rejects identical start/end (not a silent 24h)', () => {
  const errs = hk.validateEntry({ date: '2026-09-17', start: '09:00', end: '09:00', projectId: 'p1' });
  assert.ok(errs.some((e) => /same/i.test(e)));
});

test('validateEntry rejects future start', () => {
  const tomorrow = new Date(Date.now() + 48 * 3600 * 1000).toISOString().slice(0, 10);
  const errs = hk.validateEntry({ date: tomorrow, start: '09:00', end: '10:00', projectId: 'p1' });
  assert.ok(errs.some((e) => /future/i.test(e)));
});

test('validateEntry accepts a normal entry', () => {
  assert.deepEqual(hk.validateEntry({ date: '2026-09-17', start: '09:00', end: '10:30', projectId: 'p1' }), []);
});

// Midnight crossing.
test('entryDurationMs handles midnight crossing', () => {
  const s = Date.UTC(2026, 8, 17, 22, 0, 0);
  const e = Date.UTC(2026, 8, 17, 1, 0, 0); // same calendar day, earlier clock time
  assert.equal(hk.entryDurationMs(s, e), 3 * 3600 * 1000);
});

// 5. Manual entry math path: combine + duration + summarize.
test('manual entry produces correct hours through summarize', () => {
  const s = hk.combineDateTime('2026-09-17', '09:00');
  const e = hk.combineDateTime('2026-09-17', '11:30');
  const sum = hk.summarize(
    [{ id: 'e1', projectId: 'p1', startMs: s, endMs: e, billable: true }],
    { p1: { rate: 100, clientId: 'c1' } }
  );
  assert.equal(hk.msToHours(sum.totalMs), 2.5);
  assert.equal(sum.billCents, 25000);
});

// 6. Billable math avoids float drift.
test('calcCents rounds once, no float drift', () => {
  assert.equal(hk.calcCents(2.5, 85), 21250); // $212.50
  assert.equal(hk.calcCents(0.1 + 0.2, 100), 3000); // 0.30000000000000004h × $100 = $30.00
  assert.equal(hk.calcCents(1.1, 19.99), 2199);
  assert.equal(hk.calcCents(-1, 50), 0);
  assert.equal(hk.calcCents(1, -5), 0);
});

// 7. Currency formatting, locale-aware, USD default path.
test('formatMoney formats per currency and locale', () => {
  assert.equal(hk.formatMoney(21250, 'USD', 'en-US'), '$212.50');
  const eur = hk.formatMoney(21250, 'EUR', 'de-DE');
  assert.ok(eur.includes('212,50') && eur.includes('€'), 'got: ' + eur);
  assert.equal(hk.formatMoney(100000, 'JPY', 'en-US'), '¥1,000');
});

// 8. Time-zone day keys differ across zones for the same instant.
test('tzDateKey respects time zones', () => {
  const ms = Date.UTC(2026, 0, 1, 2, 0, 0); // 02:00 UTC Jan 1
  assert.equal(hk.tzDateKey(ms, 'UTC'), '2026-01-01');
  assert.equal(hk.tzDateKey(ms, 'America/New_York'), '2025-12-31');
  assert.equal(hk.tzDateKey(ms, 'Pacific/Auckland'), '2026-01-01');
});

test('weekStartKey returns Monday', () => {
  assert.equal(hk.weekStartKey('2026-09-17'), '2026-09-14'); // Thursday → Monday
  assert.equal(hk.weekStartKey('2026-09-14'), '2026-09-14'); // Monday → itself
  assert.equal(hk.monthKey('2026-09-17'), '2026-09');
});

// 9. Report totals: billable vs non-billable, grouped.
test('summarize splits billable/non-billable and groups', () => {
  const H = 3600 * 1000;
  const entries = [
    { id: 'a', projectId: 'p1', startMs: 0, endMs: 2 * H, billable: true },
    { id: 'b', projectId: 'p1', startMs: 0, endMs: 1 * H, billable: false },
    { id: 'c', projectId: 'p2', startMs: 0, endMs: 3 * H, billable: true },
  ];
  const projects = { p1: { rate: 100, clientId: 'c1' }, p2: { rate: 50, clientId: 'c2' } };
  const t = hk.summarize(entries, projects);
  assert.equal(hk.msToHours(t.totalMs), 6);
  assert.equal(hk.msToHours(t.billMs), 5);
  assert.equal(hk.msToHours(t.nonBillMs), 1);
  assert.equal(t.billCents, 20000 + 15000);
  assert.equal(hk.msToHours(t.byClient.c1.ms), 3);
  assert.equal(hk.msToHours(t.byProject.p2.ms), 3);
});

// 10. CSV export quotes commas and quotes.
test('entriesToCSV escapes correctly', () => {
  const s = Date.UTC(2026, 8, 17, 9, 0, 0);
  const csv = hk.entriesToCSV(
    [{ id: 'e1', projectId: 'p1', startMs: s, endMs: s + 3600 * 1000, description: 'Acme, "phase 2" work', billable: true }],
    [{ id: 'p1', name: 'Site', rate: 80, clientId: 'c1' }],
    [{ id: 'c1', name: 'Acme' }],
    'UTC'
  );
  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('"Acme, ""phase 2"" work"'));
  assert.ok(lines[1].includes('8000')); // 1h × $80
});

// 2. Persistence shape: corrupt storage degrades to clean defaults.
test('sanitizeState never throws and isolates bad data', () => {
  assert.deepEqual(hk.sanitizeState(null).entries, []);
  assert.deepEqual(hk.sanitizeState('garbage').clients, []);
  assert.deepEqual(hk.sanitizeState({ entries: 'nope', settings: null }).entries, []);
  const bad = hk.sanitizeState({ activeTimer: { projectId: 42, startMs: 'soon' } });
  assert.equal(bad.activeTimer, null); // malformed timer discarded, never resumed
  const good = hk.sanitizeState({ activeTimer: { projectId: 'p1', startMs: 123, description: 'x' }, settings: { currency: 'EUR', timeZone: 'UTC' }, onboarded: true });
  assert.equal(good.activeTimer.startMs, 123); // valid timer survives refresh
  assert.equal(good.settings.currency, 'EUR');
});

// 13. Empty states: summarize of nothing is all zeros (UI renders empty cards).
test('summarize of empty list is zeroed', () => {
  const t = hk.summarize([], {});
  assert.deepEqual([t.totalMs, t.billMs, t.nonBillMs, t.billCents], [0, 0, 0, 0]);
});
