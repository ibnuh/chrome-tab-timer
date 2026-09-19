// Pure helpers shared by the service worker, popup, options page, and tests.
//
// Nothing in this file may touch chrome.* APIs or the DOM, so that every export
// stays directly testable under `node --test`. All chrome-specific behavior
// belongs in background.js, popup.js, or options.js.

// --- Actions ---

export const ACTIONS = ['alert', 'close', 'reload', 'mute', 'focus'];

/** Labels for choosing an action (selects, menus). */
export const ACTION_LABELS = {
  alert: 'Alert',
  close: 'Close tab',
  reload: 'Reload tab',
  mute: 'Mute tab',
  focus: 'Focus tab',
};

/** Labels for reporting an action that already happened (notifications). */
export const ACTION_DONE_LABELS = {
  alert: 'Alert',
  close: 'Tab closed',
  reload: 'Tab reloaded',
  mute: 'Tab muted',
  focus: 'Tab focused',
};

// --- Settings shape ---

export const SETTINGS_KEY = 'settings';
export const HISTORY_KEY = 'history_log';
export const TEMPLATES_KEY = 'templates';
export const URL_RULES_KEY = 'url_rules';

export const MAX_HISTORY = 200;
export const MAX_PRESETS = 12;
export const MAX_TEMPLATES = 50;
export const MAX_URL_RULES = 50;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_LABEL_LENGTH = 50;

/** Upper bound accepted for a timer duration (7 days). */
export const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_DURATION_MS = 1000;

export const SETTINGS_DEFAULTS = {
  sound: true,
  notification: true,
  tabTitle: true,
  theme: 'system',
  defaultAction: 'alert',
  enabledActions: [...ACTIONS],
  presets: [30, 60, 300, 600, 900, 1800],
  snoozeMinutes: 5,
  alertOnTabClose: false,
};

const THEMES = ['system', 'light', 'dark'];

// --- Primitives ---

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Strictly positive whole number, or null.
 *
 * clampInt() is wrong for this: it clamps *up* to `min`, so a stored 0 or -5
 * would come back as a valid 1 rather than being rejected.
 */
function positiveInt(value) {
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function shortString(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// --- Formatting ---

/** Human duration for notifications and history, e.g. "5m 30s". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0s';
  }
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

/** Clock readout for the countdown UI, e.g. "1:05:09" or "4:30". */
export function formatClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0:00';
  }
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${pad2(m)}:${pad2(s)}`;
  }
  return `${m}:${pad2(s)}`;
}

/** Readable duration for preset chips and the options page, e.g. "1h 30m". */
export function formatPresetLabel(secs) {
  const n = typeof secs === 'number' ? secs : Number.parseInt(secs, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return '-';
  }
  if (n >= 3600) {
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (n >= 60) {
    const m = Math.floor(n / 60);
    const s = n % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${n}s`;
}

/**
 * Compact countdown used for the tab title prefix, e.g. "4m30s".
 *
 * The in-page ticker injected by background.js duplicates this logic on purpose:
 * chrome.scripting serializes the function source, so it cannot reach back into
 * this module. The titlePrefixRoundTrip test pins the contract between them.
 */
export function formatCountdown(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec <= 0) {
    return '0s';
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}h${m}m`;
  }
  if (m > 0 && s > 0) {
    return `${m}m${s}s`;
  }
  if (m > 0) {
    return `${m}m`;
  }
  return `${s}s`;
}

/**
 * Matches every prefix formatCountdown can produce, followed by " | ".
 *
 * formatCountdown emits at most two units ("1h0m", "12m5s", "45s"), which is
 * what this pattern accepts. Keep the two in sync: an unmatched prefix is never
 * stripped, and would compound on every tick.
 */
export const TITLE_PREFIX_RE = /^\d+[hms]\d*[ms]? \| /;

export function stripTitlePrefix(title) {
  return String(title ?? '').replace(TITLE_PREFIX_RE, '');
}

export function titleWithCountdown(title, totalSec) {
  return `${formatCountdown(totalSec)} | ${stripTitlePrefix(title)}`;
}

// --- Dates ---

/**
 * Calendar day of a timestamp in the user's local timezone, as "YYYY-MM-DD".
 *
 * Must not use toISOString(): that buckets by UTC, so an 8am Sunday timer in
 * Tokyo (UTC+9) would land in Saturday's bucket.
 */
export function localDayKey(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Weekday label for a localDayKey.
 *
 * Parses the parts rather than the string: `new Date('2026-09-20')` is UTC
 * midnight, which formats back as the previous day west of Greenwich.
 */
export function dayLabel(dayKey) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return '';
  }
  return new Date(y, m - 1, d).toLocaleDateString('en', { weekday: 'short' });
}

/** Local day keys for the `count` days ending at `now`, oldest first. */
export function dayKeysBack(count, now = Date.now()) {
  const keys = [];
  for (let i = count - 1; i >= 0; i--) {
    keys.push(localDayKey(now - i * 86400000));
  }
  return keys;
}

export function timeAgo(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) {
    return '';
  }
  const sec = Math.floor((now - timestamp) / 1000);
  if (sec < 60) {
    return 'just now';
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  return `${Math.floor(hr / 24)}d ago`;
}

// --- Stats ---

export function computeStats(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return { total: 0, totalDuration: 0, avgDuration: 0, byAction: {}, byDay: {} };
  }

  let totalDuration = 0;
  const byAction = {};
  const byDay = {};

  for (const entry of history) {
    const duration = Number.isFinite(entry?.duration) ? entry.duration : 0;
    totalDuration += duration;

    const action = oneOf(entry?.action, ACTIONS, 'alert');
    byAction[action] = (byAction[action] || 0) + 1;

    // An entry with no usable timestamp still counts toward the totals, but
    // must not create a NaN-NaN-NaN bucket.
    if (Number.isFinite(entry?.completedAt)) {
      const day = localDayKey(entry.completedAt);
      byDay[day] = (byDay[day] || 0) + 1;
    }
  }

  return {
    total: history.length,
    totalDuration,
    avgDuration: Math.round(totalDuration / history.length),
    byAction,
    byDay,
  };
}

// --- Text safety ---

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes text for both element content and quoted attribute values.
 *
 * Quotes matter: the popup interpolates tab titles into title="..." attributes,
 * and a tab title is attacker-controlled on any page the user visits.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

export function truncate(str, len) {
  const s = String(str ?? '');
  return s.length > len ? `${s.slice(0, len)}...` : s;
}

// --- Validation ---

export function normalizePresets(input) {
  if (!Array.isArray(input)) {
    return [...SETTINGS_DEFAULTS.presets];
  }
  const cleaned = [
    ...new Set(input.map(positiveInt).filter((v) => v !== null && v <= 86400)),
  ].sort((a, b) => a - b);
  return cleaned.length > 0 ? cleaned.slice(0, MAX_PRESETS) : [...SETTINGS_DEFAULTS.presets];
}

/** Coerces arbitrary stored/imported data into a valid settings object. */
export function normalizeSettings(input) {
  const raw = input && typeof input === 'object' ? input : {};

  // Absent means "never configured" and gets the full default set; an array that
  // yields nothing usable is a user who disabled everything, which needs a floor
  // or the popup's action select would render empty.
  let enabledActions = [...SETTINGS_DEFAULTS.enabledActions];
  if (Array.isArray(raw.enabledActions)) {
    const filtered = [...new Set(raw.enabledActions.filter((a) => ACTIONS.includes(a)))];
    enabledActions = filtered.length > 0 ? filtered : ['alert'];
  }

  return {
    sound: bool(raw.sound, SETTINGS_DEFAULTS.sound),
    notification: bool(raw.notification, SETTINGS_DEFAULTS.notification),
    tabTitle: bool(raw.tabTitle, SETTINGS_DEFAULTS.tabTitle),
    theme: oneOf(raw.theme, THEMES, SETTINGS_DEFAULTS.theme),
    // defaultAction must be selectable, or the popup would show a blank select.
    defaultAction: enabledActions.includes(raw.defaultAction)
      ? raw.defaultAction
      : enabledActions[0],
    enabledActions,
    presets: normalizePresets(raw.presets),
    snoozeMinutes: clampInt(raw.snoozeMinutes, 1, 60, SETTINGS_DEFAULTS.snoozeMinutes),
    alertOnTabClose: bool(raw.alertOnTabClose, SETTINGS_DEFAULTS.alertOnTabClose),
  };
}

export function normalizeTemplates(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  const out = [];
  for (const tpl of input) {
    if (!tpl || typeof tpl !== 'object') {
      continue;
    }
    const name = typeof tpl.name === 'string' ? tpl.name.trim().slice(0, 60) : '';
    const rawDuration = positiveInt(tpl.duration);
    if (!name || rawDuration === null) {
      continue;
    }
    out.push({
      name,
      duration: Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, rawDuration)),
      action: oneOf(tpl.action, ACTIONS, 'alert'),
      label: shortString(tpl.label, MAX_LABEL_LENGTH),
    });
    if (out.length >= MAX_TEMPLATES) {
      break;
    }
  }
  return out;
}

/**
 * True when `pattern` compiles. Run before persisting a rule: a pattern that
 * throws is dead weight, and a pathological one can hang the worker on every
 * navigation that reaches it.
 */
export function isValidPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    return false;
  }
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}

/** Coerces arbitrary data into valid URL rules, dropping unusable patterns. */
export function normalizeUrlRules(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  const out = [];
  for (const rule of input) {
    if (!rule || typeof rule !== 'object') {
      continue;
    }
    const pattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : '';
    if (!isValidPattern(pattern)) {
      continue;
    }
    out.push({
      pattern,
      duration: clampInt(rule.duration, 1, 86400, 300),
      action: oneOf(rule.action, ACTIONS, 'alert'),
      enabled: rule.enabled !== false,
      label: shortString(rule.label, MAX_LABEL_LENGTH),
    });
    if (out.length >= MAX_URL_RULES) {
      break;
    }
  }
  return out;
}

/** Validates an inbound timer-start request. Returns null when unusable. */
export function normalizeStartRequest(msg) {
  // Checked before clamping: clampInt would turn a rejected 0 into a valid 1s.
  const raw = positiveInt(msg?.duration);
  if (raw === null || raw < MIN_DURATION_MS) {
    return null;
  }
  return {
    tabId: normalizeTabId(msg?.tabId),
    duration: Math.min(MAX_DURATION_MS, raw),
    action: oneOf(msg?.action, ACTIONS, 'alert'),
    label: shortString(msg?.label, MAX_LABEL_LENGTH),
  };
}

export function normalizeTabId(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}
