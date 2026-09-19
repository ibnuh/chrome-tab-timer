import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  ACTIONS,
  SETTINGS_DEFAULTS,
  TITLE_PREFIX_RE,
  clampInt,
  computeStats,
  dayKeysBack,
  dayLabel,
  escapeHtml,
  formatClock,
  formatCountdown,
  formatDuration,
  formatPresetLabel,
  isValidPattern,
  localDayKey,
  normalizePresets,
  normalizeSettings,
  normalizeStartRequest,
  normalizeTemplates,
  normalizeUrlRules,
  stripTitlePrefix,
  timeAgo,
  titleWithCountdown,
  truncate,
} from '../src/lib.js';

const LIB_URL = new URL('../src/lib.js', import.meta.url).href;

/** Runs `body` in a fresh node process pinned to `timezone`, and parses its JSON output. */
function inTimezone(timezone, body) {
  const script = `const lib = await import(${JSON.stringify(LIB_URL)});\n${body}`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: timezone },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

// --- Formatting ---

test('formatDuration covers each unit band', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(-5000), '0s');
  assert.equal(formatDuration(999), '1s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(300_000), '5m 0s');
  assert.equal(formatDuration(5_400_000), '1h 30m');
  assert.equal(formatDuration(Number.NaN), '0s');
});

test('formatClock renders m:ss and h:mm:ss', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(1), '0:01');
  assert.equal(formatClock(59_000), '0:59');
  // Countdown rounds up, so a partial second still reads as a full second.
  assert.equal(formatClock(59_400), '1:00');
  assert.equal(formatClock(60_000), '1:00');
  assert.equal(formatClock(270_000), '4:30');
  assert.equal(formatClock(3_600_000), '1:00:00');
  assert.equal(formatClock(3_909_000), '1:05:09');
  assert.equal(formatClock(undefined), '0:00');
});

test('formatPresetLabel renders readable units', () => {
  assert.equal(formatPresetLabel(30), '30s');
  assert.equal(formatPresetLabel(60), '1m');
  assert.equal(formatPresetLabel(90), '1m 30s');
  assert.equal(formatPresetLabel(5400), '1h 30m');
  assert.equal(formatPresetLabel(7200), '2h');
  assert.equal(formatPresetLabel(0), '-');
  assert.equal(formatPresetLabel('nonsense'), '-');
});

test('round trip: every formatCountdown output is stripped by TITLE_PREFIX_RE', () => {
  // The ticker writes `prefix + original`; anything the pattern fails to strip
  // would stack up on the next tick.
  const samples = [
    1, 5, 30, 59, 60, 61, 90, 599, 600, 3599, 3600, 3660, 5400, 7200, 86_400,
  ];
  for (const secs of samples) {
    const title = titleWithCountdown('Inbox (3)', secs);
    assert.ok(
      TITLE_PREFIX_RE.test(title),
      `prefix not matched for ${secs}s: ${JSON.stringify(title)}`
    );
    assert.equal(stripTitlePrefix(title), 'Inbox (3)', `failed for ${secs}s`);
  }
});

test('stripTitlePrefix leaves an unprefixed title alone', () => {
  assert.equal(stripTitlePrefix('Inbox (3)'), 'Inbox (3)');
  assert.equal(stripTitlePrefix(''), '');
  assert.equal(stripTitlePrefix(null), '');
  assert.equal(stripTitlePrefix('4m30s | Page'), 'Page');
  assert.equal(stripTitlePrefix('1h0m | Page'), 'Page');
});

test('formatCountdown stays compact for the title bar', () => {
  assert.equal(formatCountdown(0), '0s');
  assert.equal(formatCountdown(45), '45s');
  assert.equal(formatCountdown(270), '4m30s');
  assert.equal(formatCountdown(300), '5m');
  assert.equal(formatCountdown(5400), '1h30m');
});

// --- Text safety ---

test('escapeHtml escapes quotes as well as angle brackets', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  // Attribute context: the popup puts tab titles inside title="...".
  assert.equal(escapeHtml('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
});

test('truncate appends an ellipsis only when it cuts', () => {
  assert.equal(truncate('abcdef', 3), 'abc...');
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate(null, 3), '');
});

// --- Timezones ---

test('localDayKey uses the local calendar day', () => {
  // Midday UTC is the same calendar day for any offset in [-11, +11].
  const midday = new Date('2026-09-20T12:00:00Z').getTime();
  assert.equal(localDayKey(midday), '2026-09-20');
});

test('a late-evening timer is bucketed and labelled as the local day', () => {
  // 2026-09-19T23:00Z is Sunday 08:00 in Tokyo. The old code keyed this as
  // 2026-09-19 and then labelled that key "Sat", filing a Sunday timer under Sat.
  const result = inTimezone(
    'Asia/Tokyo',
    `
    const ts = new Date('2026-09-19T23:00:00Z').getTime();
    const evt = new Date(ts).toLocaleString('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short' });
    const stats = lib.computeStats([{ duration: 60000, action: 'reload', completedAt: ts }]);
    process.stdout.write(JSON.stringify({
      key: lib.localDayKey(ts),
      byDay: stats.byDay,
      label: lib.dayLabel(lib.localDayKey(ts)),
      actualWeekday: evt.slice(0, 3),
    }));
    `
  );

  assert.equal(result.actualWeekday, 'Sun', 'sanity: event is Sunday locally');
  assert.equal(result.key, '2026-09-20');
  assert.deepEqual(result.byDay, { '2026-09-20': 1 });
  // The regression: the label must agree with the bucket it heads.
  assert.equal(result.label, 'Sun');
});

test('dayLabel parses the key as local, not UTC', () => {
  // 2026-09-20 is a Sunday.
  assert.equal(dayLabel('2026-09-20'), 'Sun');
  assert.equal(dayLabel('2026-09-21'), 'Mon');
  assert.equal(dayLabel('nonsense'), '');
});

test('dayKeysBack returns local keys oldest first', () => {
  const now = new Date(2026, 8, 20, 15, 0, 0).getTime();
  const keys = dayKeysBack(3, now);
  assert.deepEqual(keys, ['2026-09-18', '2026-09-19', '2026-09-20']);
});

test('timeAgo bands', () => {
  const now = 1_000_000_000;
  assert.equal(timeAgo(now, now), 'just now');
  assert.equal(timeAgo(now - 30_000, now), 'just now');
  assert.equal(timeAgo(now - 90_000, now), '1m ago');
  assert.equal(timeAgo(now - 7_200_000, now), '2h ago');
  assert.equal(timeAgo(now - 172_800_000, now), '2d ago');
  assert.equal(timeAgo(undefined, now), '');
  assert.equal(timeAgo(Number.NaN, now), '');
});

// --- Stats ---

test('computeStats aggregates totals, actions, and days', () => {
  const day = new Date(2026, 8, 20, 12, 0, 0).getTime();
  const stats = computeStats([
    { duration: 1000, action: 'close', completedAt: day },
    { duration: 3000, action: 'close', completedAt: day },
    { duration: 2000, action: 'alert', completedAt: day },
  ]);
  assert.equal(stats.total, 3);
  assert.equal(stats.totalDuration, 6000);
  assert.equal(stats.avgDuration, 2000);
  assert.deepEqual(stats.byAction, { close: 2, alert: 1 });
  assert.deepEqual(stats.byDay, { '2026-09-20': 3 });
});

test('computeStats tolerates empty and malformed input', () => {
  for (const input of [[], undefined, null, 'nope']) {
    const stats = computeStats(input);
    assert.equal(stats.total, 0);
    assert.deepEqual(stats.byDay, {});
  }
  const stats = computeStats([{ action: 'bogus', completedAt: Date.now() }]);
  assert.deepEqual(stats.byAction, { alert: 1 }, 'unknown action falls back to alert');
  assert.equal(stats.totalDuration, 0);
});

test('computeStats never builds a NaN day bucket', () => {
  const stats = computeStats([
    { duration: 1000, action: 'alert' },
    { duration: 1000, action: 'alert', completedAt: null },
  ]);
  assert.equal(stats.total, 2, 'entries with no timestamp still count');
  assert.deepEqual(stats.byDay, {}, 'but contribute no day bucket');
  assert.ok(!Object.keys(stats.byDay).some((k) => k.includes('NaN')));
});

// --- Primitive coercion ---

test('clampInt clamps and falls back', () => {
  assert.equal(clampInt(5, 1, 10, 0), 5);
  assert.equal(clampInt(50, 1, 10, 0), 10);
  assert.equal(clampInt(-5, 1, 10, 0), 1);
  assert.equal(clampInt('7', 1, 10, 0), 7);
  assert.equal(clampInt('abc', 1, 10, 99), 99);
  assert.equal(clampInt(undefined, 1, 10, 99), 99);
});

// --- Settings validation ---

test('normalizeSettings returns defaults for junk input', () => {
  for (const input of [undefined, null, 'nope', 42, []]) {
    assert.deepEqual(normalizeSettings(input), SETTINGS_DEFAULTS);
  }
});

test('normalizeSettings coerces each field', () => {
  const s = normalizeSettings({
    sound: 'yes',
    notification: false,
    tabTitle: true,
    theme: 'neon',
    defaultAction: 'close',
    enabledActions: ['close', 'close', 'bogus'],
    presets: [90, 30, 30, -5, 'x'],
    snoozeMinutes: 999,
    alertOnTabClose: true,
  });
  assert.equal(s.sound, true, 'non-boolean sound falls back to the default');
  assert.equal(s.notification, false);
  assert.equal(s.theme, 'system', 'unknown theme falls back');
  assert.deepEqual(s.enabledActions, ['close']);
  assert.equal(s.defaultAction, 'close');
  assert.deepEqual(s.presets, [30, 90], 'deduped, sorted, negatives dropped');
  assert.equal(s.snoozeMinutes, 60, 'clamped');
  assert.equal(s.alertOnTabClose, true);
});

test('normalizeSettings keeps defaultAction selectable', () => {
  // A defaultAction outside enabledActions would render a blank select.
  const s = normalizeSettings({ enabledActions: ['mute', 'reload'], defaultAction: 'close' });
  assert.equal(s.defaultAction, 'mute');
  assert.ok(s.enabledActions.includes(s.defaultAction));
});

test('normalizeSettings recovers when every action is disabled', () => {
  const s = normalizeSettings({ enabledActions: [], defaultAction: 'close' });
  assert.deepEqual(s.enabledActions, ['alert']);
  assert.equal(s.defaultAction, 'alert');
});

test('normalizePresets falls back when nothing survives', () => {
  assert.deepEqual(normalizePresets('nope'), SETTINGS_DEFAULTS.presets);
  assert.deepEqual(normalizePresets([]), SETTINGS_DEFAULTS.presets);
  assert.deepEqual(normalizePresets([0, -1]), SETTINGS_DEFAULTS.presets);
  assert.equal(normalizePresets(Array.from({ length: 40 }, (_, i) => i + 1)).length, 12);
});

// --- Templates ---

test('normalizeTemplates drops unusable entries', () => {
  const out = normalizeTemplates([
    { name: 'Good', duration: 60_000, action: 'close', label: 'x' },
    { name: '', duration: 60_000 },
    { name: 'No duration' },
    { name: 'Negative', duration: -5 },
    null,
    'nope',
    { name: 'Bad action', duration: 60_000, action: 'explode' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Good');
  assert.equal(out[0].action, 'close');
  assert.equal(out[1].action, 'alert', 'unknown action falls back');
  assert.equal(normalizeTemplates(undefined).length, 0);
});

test('normalizeTemplates clamps duration and truncates text', () => {
  const out = normalizeTemplates([
    { name: 'a'.repeat(200), duration: 999_999_999_999, label: 'b'.repeat(200) },
  ]);
  assert.equal(out[0].name.length, 60);
  assert.equal(out[0].label.length, 50);
  assert.ok(out[0].duration <= 7 * 24 * 60 * 60 * 1000);
});

// --- URL rules ---

test('isValidPattern rejects malformed and oversized patterns', () => {
  assert.equal(isValidPattern('^https://example\\.com'), true);
  assert.equal(isValidPattern('('), false, 'unclosed group does not compile');
  assert.equal(isValidPattern(''), false);
  assert.equal(isValidPattern(null), false);
  assert.equal(isValidPattern('a'.repeat(201)), false, 'over the length cap');
});

test('normalizeUrlRules drops rules with unusable patterns', () => {
  const out = normalizeUrlRules([
    { pattern: '^https://ok\\.com', duration: 60, action: 'mute', enabled: true },
    { pattern: '(', duration: 60 },
    { pattern: '', duration: 60 },
    { duration: 60 },
    null,
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pattern, '^https://ok\\.com');
  assert.equal(out[0].action, 'mute');
  assert.equal(normalizeUrlRules('nope').length, 0);
});

test('normalizeUrlRules clamps duration and defaults enabled', () => {
  const out = normalizeUrlRules([
    { pattern: 'a', duration: 0 },
    { pattern: 'b', enabled: false },
  ]);
  assert.equal(out[0].duration, 1, 'clamped up to 1s');
  assert.equal(out[0].enabled, true, 'enabled defaults on');
  assert.equal(out[1].duration, 300, 'missing duration defaults to 300s');
  assert.equal(out[1].enabled, false, 'explicit false is preserved');
});

// --- Start requests ---

test('normalizeStartRequest validates duration and coerces the rest', () => {
  const req = normalizeStartRequest({ tabId: 12, duration: 60_000, action: 'mute', label: 'hi' });
  assert.deepEqual(req, { tabId: 12, duration: 60_000, action: 'mute', label: 'hi' });
});

test('normalizeStartRequest rejects unusable requests', () => {
  assert.equal(normalizeStartRequest({ tabId: 1, duration: 0 }), null);
  assert.equal(normalizeStartRequest({ tabId: 1, duration: -1 }), null);
  assert.equal(normalizeStartRequest({ tabId: 1, duration: 'x' }), null);
  assert.equal(normalizeStartRequest({}), null);
});

test('normalizeStartRequest clamps and sanitises fields', () => {
  const req = normalizeStartRequest({
    tabId: 3,
    duration: 99_999_999_999,
    action: 'explode',
    label: 'z'.repeat(200),
  });
  assert.equal(req.duration, 7 * 24 * 60 * 60 * 1000);
  assert.equal(req.action, 'alert');
  assert.equal(req.label.length, 50);

  assert.equal(normalizeStartRequest({ tabId: -3, duration: 1000 }).tabId, null);
  assert.equal(normalizeStartRequest({ tabId: '7', duration: 1000 }).tabId, null);
});

test('ACTIONS is the single source of truth for action ids', () => {
  assert.deepEqual(ACTIONS, ['alert', 'close', 'reload', 'mute', 'focus']);
  assert.deepEqual(SETTINGS_DEFAULTS.enabledActions, ACTIONS);
});
