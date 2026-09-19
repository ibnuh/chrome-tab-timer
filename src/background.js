import {
  ACTION_DONE_LABELS,
  HISTORY_KEY,
  MAX_HISTORY,
  SETTINGS_KEY,
  TEMPLATES_KEY,
  TITLE_PREFIX_RE,
  URL_RULES_KEY,
  computeStats,
  formatDuration,
  isValidPattern,
  normalizeSettings,
  normalizeStartRequest,
  normalizeTabId,
  normalizeTemplates,
  normalizeUrlRules,
  stripTitlePrefix,
} from './lib.js';

// Timer storage key prefix
const TIMER_PREFIX = 'timer_';
const BADGE_ALARM = 'badge_update';

// Chrome 120 honors alarms down to 30s; older versions clamp to 60s. Anything
// shorter than this needs setTimeout for precision, but setTimeout lives in
// worker memory and does not survive suspension, so short timers also get a
// backstop alarm. On a pre-120 browser that alarm lands late rather than never.
const MIN_ALARM_MS = 30000;
const BADGE_PERIOD_MINUTES = 0.5;

const shortTimers = new Map();

// Guards against two paths (setTimeout, backstop alarm, badge sweep) racing to
// run the same completion twice.
const firing = new Set();

// --- Caches ---
//
// Settings and URL rules are read on hot paths (every tab title tick, every
// navigation, every badge sweep). Both are invalidated by storage.onChanged.

let settingsCache = null;
let urlRulesCache = null;
let presetSignature = '';

function invalidateCaches(changes) {
  if (!changes || changes[SETTINGS_KEY]) {
    settingsCache = null;
  }
  if (!changes || changes[URL_RULES_KEY]) {
    urlRulesCache = null;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  invalidateCaches(changes);

  // Rebuild the preset submenu when the preset list actually changes, rather
  // than leaving stale entries until the next browser start.
  if (changes[SETTINGS_KEY]) {
    const signature = normalizeSettings(changes[SETTINGS_KEY].newValue).presets.join(',');
    if (signature !== presetSignature) {
      presetSignature = signature;
      rebuildContextMenus();
    }
  }
});

// --- Sound playback via offscreen document ---

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  // Cleared in a finally: caching a rejected promise here would permanently
  // disable sound for the life of the worker.
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play notification sound when a timer completes',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function playSound() {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'PLAY_SOUND' });
}

// --- Settings ---

async function getSettings() {
  if (settingsCache) {
    return settingsCache;
  }
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  settingsCache = normalizeSettings(result[SETTINGS_KEY]);
  return settingsCache;
}

// --- History ---

// History is a read-modify-write list, so concurrent updates have to be
// serialized: two timers finishing at the same moment would otherwise both read
// the same list and the second write would drop the first entry.
let historyQueue = Promise.resolve();

function withHistoryLock(fn) {
  historyQueue = historyQueue.then(fn).catch((err) => {
    console.warn('Tab Timer: history update failed', err);
  });
  return historyQueue;
}

function addHistoryEntry(timer, tabTitle) {
  return withHistoryLock(async () => {
    const result = await chrome.storage.local.get(HISTORY_KEY);
    const entries = result[HISTORY_KEY] || [];
    entries.unshift({
      tabTitle,
      label: timer.label || '',
      action: timer.action,
      completedAt: Date.now(),
      duration: timer.endTime - (timer.startTime || timer.endTime),
    });
    if (entries.length > MAX_HISTORY) {
      entries.length = MAX_HISTORY;
    }
    await chrome.storage.local.set({ [HISTORY_KEY]: entries });
  });
}

// --- Storage helpers ---

async function getTimer(tabId) {
  const key = TIMER_PREFIX + tabId;
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

async function getAllTimers() {
  const all = await chrome.storage.local.get(null);
  const timers = {};
  const staleKeys = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(TIMER_PREFIX)) {
      continue;
    }
    if (!value || typeof value.tabId !== 'number' || !Number.isFinite(value.endTime)) {
      staleKeys.push(key);
      continue;
    }
    timers[key] = value;
  }
  if (staleKeys.length > 0) {
    await chrome.storage.local.remove(staleKeys);
  }
  return timers;
}

async function setTimer(tabId, data) {
  await chrome.storage.local.set({ [TIMER_PREFIX + tabId]: data });
}

async function removeTimer(tabId) {
  await chrome.storage.local.remove(TIMER_PREFIX + tabId);
  await chrome.alarms.clear(TIMER_PREFIX + tabId);
  clearShortTimer(tabId);
  await restoreTabTitle(tabId);
  await updateBadgeForTab(tabId);
}

function clearShortTimer(tabId) {
  const handle = shortTimers.get(tabId);
  if (handle) {
    clearTimeout(handle);
    shortTimers.delete(tabId);
  }
}

// --- Templates ---

async function getTemplates() {
  const result = await chrome.storage.local.get(TEMPLATES_KEY);
  return normalizeTemplates(result[TEMPLATES_KEY]);
}

async function saveTemplates(templates) {
  await chrome.storage.local.set({ [TEMPLATES_KEY]: normalizeTemplates(templates) });
}

// --- URL Rules ---

async function getUrlRules() {
  if (urlRulesCache) {
    return urlRulesCache;
  }
  const result = await chrome.storage.local.get(URL_RULES_KEY);
  urlRulesCache = normalizeUrlRules(result[URL_RULES_KEY]);
  return urlRulesCache;
}

async function saveUrlRules(rules) {
  const normalized = normalizeUrlRules(rules);
  urlRulesCache = normalized;
  await chrome.storage.local.set({ [URL_RULES_KEY]: normalized });
  return normalized;
}

// --- Shared timer start helper ---

async function startTimerForTab(tabId, duration, action, label) {
  const now = Date.now();
  const timerData = {
    tabId,
    startTime: now,
    endTime: now + duration,
    action: action || 'alert',
    label: label || '',
    paused: false,
  };
  await setTimer(tabId, timerData);
  createTimerAlarm(tabId, duration);
  await ensureBadgeAlarm();
  await updateBadgeForTab(tabId);
  await updateTabTitle(tabId);
}

// --- Alarm management ---

function createTimerAlarm(tabId, delayMs) {
  clearShortTimer(tabId);

  // Inclusive: at exactly the floor the alarm is only exact on Chrome 120+, so
  // a timer at the boundary gets the precise path too.
  if (delayMs <= MIN_ALARM_MS) {
    const handle = setTimeout(() => {
      shortTimers.delete(tabId);
      onTimerFired(tabId);
    }, delayMs);
    shortTimers.set(tabId, handle);
  }

  // Always arm the alarm, even when setTimeout is doing the precise work. It
  // outlives worker suspension, and onTimerFired is idempotent, so an early
  // setTimeout firing simply wins and the later alarm becomes a no-op.
  const alarmDelayMs = Math.max(delayMs, MIN_ALARM_MS);
  chrome.alarms.create(TIMER_PREFIX + tabId, { delayInMinutes: alarmDelayMs / 60000 });
}

// --- Badge ---

async function updateBadgeForTab(tabId) {
  // Without this a missing tab id reaches setBadgeText as an explicitly
  // undefined tabId, which Chrome reads as "no tab" and applies globally.
  if (!Number.isInteger(tabId)) {
    return;
  }
  const timer = await getTimer(tabId);
  if (!timer || timer.paused) {
    await setBadge(tabId, '');
    return;
  }

  const remaining = Math.max(0, timer.endTime - Date.now());
  const totalSec = Math.ceil(remaining / 1000);

  let text;
  if (remaining <= 0) {
    text = '';
  } else if (totalSec >= 3600) {
    text = Math.floor(totalSec / 3600) + 'h';
  } else if (totalSec >= 60) {
    text = Math.ceil(totalSec / 60) + 'm';
  } else {
    text = totalSec + 's';
  }

  await setBadge(tabId, text);
}

async function setBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // Tab went away mid-update; the orphan sweep will clean up behind us.
  }
}

async function applyBadgeStyle() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  } catch {
    // Non-fatal: the badge text still renders with the default colour.
  }
}

async function updateAllBadges() {
  const timers = await getAllTimers();
  for (const timer of Object.values(timers)) {
    await updateBadgeForTab(timer.tabId);
  }
  if (Object.keys(timers).length > 0) {
    await ensureBadgeAlarm();
  } else {
    await chrome.alarms.clear(BADGE_ALARM);
  }
}

/**
 * Safety net for anything the alarm and setTimeout paths missed: drops timers
 * whose tab is gone, fires timers whose deadline already passed, refreshes
 * badges. Runs on the badge alarm and on startup.
 */
async function reconcileTimers() {
  const timers = await getAllTimers();
  const openTabIds = new Set((await chrome.tabs.query({})).map((t) => t.id));

  for (const timer of Object.values(timers)) {
    if (!openTabIds.has(timer.tabId)) {
      await removeTimer(timer.tabId);
    } else if (!timer.paused && timer.endTime <= Date.now()) {
      await onTimerFired(timer.tabId);
    }
  }

  await updateAllBadges();
}

async function ensureBadgeAlarm() {
  const existing = await chrome.alarms.get(BADGE_ALARM);
  if (!existing) {
    chrome.alarms.create(BADGE_ALARM, { periodInMinutes: BADGE_PERIOD_MINUTES });
  }
}

// --- Tab title ---

/**
 * Injects (or refreshes) the in-page countdown ticker.
 *
 * The injected function is serialized by chrome.scripting, so it cannot call
 * into lib.js; formatSec mirrors formatCountdown there, and the
 * titlePrefixRoundTrip test pins the contract for both.
 */
async function updateTabTitle(tabId) {
  const [cfg, timer] = await Promise.all([getSettings(), getTimer(tabId)]);

  if (!timer || !cfg.tabTitle) {
    await restoreTabTitle(tabId);
    return;
  }

  const base = stripTitlePrefix(await getTabTitle(tabId));

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (endTime, pausedRemaining, prefixRe, initialBase) => {
        const re = new RegExp(prefixRe);
        let original = initialBase;
        // What this ticker last wrote, so a page rewriting its own title is
        // detected rather than clobbered on the next tick.
        let lastApplied = null;

        function formatSec(totalSec) {
          if (totalSec <= 0) return '0s';
          const h = Math.floor(totalSec / 3600);
          const m = Math.floor((totalSec % 3600) / 60);
          const s = totalSec % 60;
          if (h > 0) return h + 'h' + m + 'm';
          if (m > 0 && s > 0) return m + 'm' + s + 's';
          if (m > 0) return m + 'm';
          return s + 's';
        }

        function stop() {
          if (window.__tabTimerInterval) {
            clearInterval(window.__tabTimerInterval);
            window.__tabTimerInterval = null;
          }
        }

        function tick() {
          const current = document.title;
          if (lastApplied !== null && current !== lastApplied) {
            original = current.replace(re, '');
          }
          window.__tabTimerOrigTitle = original;

          const remaining = endTime ? Math.max(0, endTime - Date.now()) : pausedRemaining || 0;
          const totalSec = Math.ceil(remaining / 1000);
          if (totalSec <= 0) {
            stop();
            window.__tabTimerOrigTitle = null;
            document.title = original;
            return;
          }
          lastApplied = formatSec(totalSec) + ' | ' + original;
          document.title = lastApplied;
        }

        stop();
        tick();
        if (endTime) {
          window.__tabTimerInterval = setInterval(tick, 1000);
        }
      },
      args: [timer.paused ? null : timer.endTime, timer.paused ? timer.remaining : null, TITLE_PREFIX_RE.source, base],
    });
  } catch {
    // Restricted pages (chrome://, the Web Store) reject injection. The timer
    // itself is unaffected, only the title countdown is skipped.
  }
}

async function restoreTabTitle(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (prefixRe) => {
        if (window.__tabTimerInterval) {
          clearInterval(window.__tabTimerInterval);
          window.__tabTimerInterval = null;
        }
        const original = window.__tabTimerOrigTitle;
        window.__tabTimerOrigTitle = null;
        document.title = original || document.title.replace(new RegExp(prefixRe), '');
      },
      args: [TITLE_PREFIX_RE.source],
    });
  } catch {
    // Nothing to restore when the page is gone or injection is disallowed.
  }
}

async function getTabTitle(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.title || 'Unknown tab';
  } catch {
    return 'Unknown tab';
  }
}

// --- Timer fired handler ---

async function onTimerFired(tabId) {
  if (firing.has(tabId)) {
    return;
  }
  // Claimed before the first await: checking and setting across an await is not
  // atomic, and the alarm, the setTimeout, and the 30s sweep can all arrive at
  // the same expired timer.
  firing.add(tabId);
  try {
    const timer = await getTimer(tabId);
    if (!timer) {
      return;
    }
    // Storage is cleared before the action runs. Closing the tab first would
    // let tabs.onRemoved see a live timer and report a cancellation for a timer
    // that actually completed.
    await removeTimer(tabId);
    await executeAction(timer);
    await updateAllBadges();
  } finally {
    firing.delete(tabId);
  }
}

// --- Actions on timer completion ---

async function executeAction(timer) {
  const { tabId, action, label } = timer;
  const [tabTitle, cfg] = await Promise.all([getTabTitle(tabId), getSettings()]);

  await addHistoryEntry(timer, tabTitle);

  const durationStr = formatDuration(timer.endTime - (timer.startTime || timer.endTime));
  const title = label ? `Timer: ${label}` : 'Tab Timer';
  const actionDesc = ACTION_DONE_LABELS[action] || ACTION_DONE_LABELS.alert;
  const message = `${durationStr} timer completed\n${tabTitle}\nAction: ${actionDesc}`;

  if (cfg.sound) {
    try {
      await playSound();
    } catch (e) {
      console.warn('Tab Timer: could not play sound', e);
    }
  }

  if (cfg.notification) {
    chrome.notifications.create(`timer_done_${tabId}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: `Snooze ${cfg.snoozeMinutes}m` }],
    });
  }

  try {
    switch (action) {
      case 'close':
        await chrome.tabs.remove(tabId);
        break;
      case 'reload':
        await chrome.tabs.reload(tabId);
        break;
      case 'mute':
        await chrome.tabs.update(tabId, { muted: true });
        break;
      case 'focus': {
        const tab = await chrome.tabs.get(tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(tabId, { active: true });
        break;
      }
      case 'alert':
      default:
        break;
    }
  } catch (e) {
    console.warn('Tab Timer: action failed for tab', tabId, e);
  }
}

// --- Snooze ---

async function snoozeTimer(tabId) {
  const cfg = await getSettings();
  await startTimerForTab(tabId, cfg.snoozeMinutes * 60 * 1000, 'alert', `Snoozed (${cfg.snoozeMinutes}m)`);
}

// --- Context menu ---

const PRESET_LABELS = {
  30: '30s',
  60: '1m',
  300: '5m',
  600: '10m',
  900: '15m',
  1800: '30m',
  3600: '1h',
};

/**
 * contextMenus.create reports failures through runtime.lastError rather than by
 * throwing, so reading it in the callback is the only way a duplicate id becomes
 * visible instead of silently dropping a menu item.
 */
function createMenuItem(options) {
  chrome.contextMenus.create(options, () => {
    if (chrome.runtime.lastError) {
      console.warn('Tab Timer: context menu item failed', options.id, chrome.runtime.lastError.message);
    }
  });
}

// Serialized: a rebuild is removeAll-then-create, so two overlapping rebuilds
// could interleave and leave the menu half-populated.
let menuQueue = Promise.resolve();

function rebuildContextMenus() {
  menuQueue = menuQueue.then(buildContextMenus).catch((err) => {
    console.warn('Tab Timer: could not rebuild context menus', err);
  });
  return menuQueue;
}

async function buildContextMenus() {
  await chrome.contextMenus.removeAll();
  const cfg = await getSettings();
  presetSignature = cfg.presets.join(',');

  createMenuItem({
    id: 'tabtimer-parent',
    title: 'Tab Timer',
    contexts: ['page'],
  });

  for (const secs of cfg.presets) {
    createMenuItem({
      id: `tabtimer-preset-${secs}`,
      parentId: 'tabtimer-parent',
      title: `Set ${PRESET_LABELS[secs] || formatDuration(secs * 1000)} timer`,
      contexts: ['page'],
    });
  }

  createMenuItem({
    id: 'tabtimer-sep1',
    parentId: 'tabtimer-parent',
    type: 'separator',
    contexts: ['page'],
  });

  createMenuItem({
    id: 'tabtimer-cancel',
    parentId: 'tabtimer-parent',
    title: 'Cancel timer on this tab',
    contexts: ['page'],
  });

  chrome.contextMenus.create({
    id: 'tabtimer-cancel-all',
    parentId: 'tabtimer-parent',
    title: 'Cancel all timers',
    contexts: ['page'],
  });
}

// --- URL-based auto timers ---

async function checkUrlRules(tabId, url) {
  if (!url) {
    return;
  }
  const rules = await getUrlRules();
  if (rules.length === 0) {
    return;
  }

  // Don't auto-set if tab already has a timer
  if (await getTimer(tabId)) {
    return;
  }

  for (const rule of rules) {
    if (!rule.enabled || !isValidPattern(rule.pattern)) {
      continue;
    }
    if (new RegExp(rule.pattern, 'i').test(url)) {
      await startTimerForTab(tabId, rule.duration * 1000, rule.action, rule.label || `Auto: ${rule.pattern}`);
      return;
    }
  }
}

// --- Event listeners ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BADGE_ALARM) {
    await reconcileTimers();
    return;
  }

  if (!alarm.name.startsWith(TIMER_PREFIX)) {
    return;
  }

  await onTimerFired(parseInt(alarm.name.slice(TIMER_PREFIX.length), 10));
});

// Notification clicked - focus the tab
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('timer_done_')) {
    return;
  }
  const tabId = parseInt(notificationId.slice('timer_done_'.length), 10);
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // Tab already closed.
  }
  chrome.notifications.clear(notificationId);
});

// Notification button clicked - snooze
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (!notificationId.startsWith('timer_done_')) {
    return;
  }
  if (buttonIndex === 0) {
    const tabId = parseInt(notificationId.slice('timer_done_'.length), 10);
    if (await getTimer(tabId)) {
      await snoozeTimer(tabId);
    }
  }
  chrome.notifications.clear(notificationId);
});

// Tab closed - clean up
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const timer = await getTimer(tabId);
  if (!timer) {
    return;
  }
  // Reached only when the user closed the tab themselves: onTimerFired clears
  // storage before running a close action.
  const cfg = await getSettings();
  if (cfg.alertOnTabClose) {
    const durationStr = formatDuration(timer.endTime - (timer.startTime || timer.endTime));
    const label = timer.label ? ` (${timer.label})` : '';
    chrome.notifications.create(`tab_closed_${tabId}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Timer cancelled - tab closed',
      message: `${durationStr} timer${label} was cancelled because the tab was closed.`,
      priority: 1,
    });
  }
  await removeTimer(tabId);
  await updateAllBadges();
});

// Tab activated - update badge
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await updateBadgeForTab(tabId);
});

// Tab URL changed - check URL rules, and re-arm the title countdown
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url) {
    await checkUrlRules(tabId, changeInfo.url);
  }
  // Re-inject after page load so the countdown survives reload/navigation.
  if (changeInfo.status === 'complete' && (await getTimer(tabId))) {
    await updateTabTitle(tabId);
  }
});

// Context menu clicked
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) {
    return;
  }

  if (info.menuItemId === 'tabtimer-cancel') {
    await removeTimer(tab.id);
    await updateAllBadges();
  } else if (info.menuItemId === 'tabtimer-cancel-all') {
    await cancelAllTimers();
  } else if (String(info.menuItemId).startsWith('tabtimer-preset-')) {
    const secs = parseInt(String(info.menuItemId).slice('tabtimer-preset-'.length), 10);
    const cfg = await getSettings();
    if (Number.isFinite(secs) && secs > 0) {
      await startTimerForTab(tab.id, secs * 1000, cfg.defaultAction, '');
    }
  }
});

// Keyboard shortcut
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'quick-timer') {
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return;
  }
  const cfg = await getSettings();
  await startTimerForTab(tab.id, (cfg.presets[0] || 60) * 1000, cfg.defaultAction, '');
});

// --- Shared operations used by menus and messages ---

async function cancelAllTimers() {
  const timers = await getAllTimers();
  for (const timer of Object.values(timers)) {
    await removeTimer(timer.tabId);
  }
  await updateAllBadges();
  return Object.keys(timers).length;
}

// --- Message handling from popup/options ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => {
      // Without this the port closes with no response and the popup's await
      // rejects with a confusing "message port closed" error.
      console.error('Tab Timer: message failed', msg?.type, err);
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    });
  return true;
});

async function handleMessage(msg) {
  if (!msg || typeof msg.type !== 'string') {
    return { error: 'malformed message' };
  }

  switch (msg.type) {
    case 'START_TIMER': {
      const req = normalizeStartRequest(msg);
      if (!req || req.tabId === null) {
        return { error: 'invalid timer request' };
      }
      await startTimerForTab(req.tabId, req.duration, req.action, req.label);
      return { success: true };
    }

    case 'CANCEL_TIMER': {
      const tabId = normalizeTabId(msg.tabId);
      if (tabId === null) {
        return { error: 'invalid tab id' };
      }
      await removeTimer(tabId);
      await updateAllBadges();
      return { success: true };
    }

    case 'CANCEL_ALL_TIMERS':
      return { success: true, count: await cancelAllTimers() };

    case 'PAUSE_TIMER': {
      const timer = await getTimer(msg.tabId);
      if (!timer || timer.paused) {
        return { error: 'no running timer' };
      }
      timer.paused = true;
      timer.remaining = Math.max(0, timer.endTime - Date.now());
      await setTimer(msg.tabId, timer);
      await chrome.alarms.clear(TIMER_PREFIX + msg.tabId);
      clearShortTimer(msg.tabId);
      await updateBadgeForTab(msg.tabId);
      await updateTabTitle(msg.tabId);
      return { success: true };
    }

    case 'RESUME_TIMER': {
      const timer = await getTimer(msg.tabId);
      if (!timer || !timer.paused) {
        return { error: 'no paused timer' };
      }
      const remaining = Math.max(0, timer.remaining || 0);
      timer.paused = false;
      timer.endTime = Date.now() + remaining;
      delete timer.remaining;
      await setTimer(msg.tabId, timer);
      createTimerAlarm(msg.tabId, remaining);
      await ensureBadgeAlarm();
      await updateBadgeForTab(msg.tabId);
      await updateTabTitle(msg.tabId);
      return { success: true };
    }

    case 'GET_TIMER':
      return { timer: await getTimer(msg.tabId) };

    case 'GET_ALL_TIMERS':
      return { timers: await getAllTimers() };

    case 'GET_HISTORY': {
      const result = await chrome.storage.local.get(HISTORY_KEY);
      return { history: result[HISTORY_KEY] || [] };
    }

    case 'CLEAR_HISTORY':
      // Through the same lock, so a completion landing at the same moment
      // cannot resurrect the entries this is clearing.
      await withHistoryLock(() => chrome.storage.local.remove(HISTORY_KEY));
      return { success: true };

    case 'GET_SETTINGS':
      return { settings: await getSettings() };

    case 'GET_STATS': {
      const result = await chrome.storage.local.get(HISTORY_KEY);
      return { stats: computeStats(result[HISTORY_KEY] || []) };
    }

    case 'GET_TEMPLATES':
      return { templates: await getTemplates() };

    case 'SAVE_TEMPLATES': {
      const templates = await saveTemplates(msg.templates);
      return { success: true, count: templates.length };
    }

    case 'GET_URL_RULES':
      return { rules: await getUrlRules() };

    case 'SAVE_URL_RULES': {
      const rules = await saveUrlRules(msg.rules);
      return { success: true, count: rules.length };
    }

    case 'SNOOZE_TIMER':
      if (!(await getTimer(msg.tabId))) {
        return { error: 'no timer to snooze' };
      }
      await snoozeTimer(msg.tabId);
      return { success: true };

    case 'START_TIMER_FOR_GROUP': {
      const req = normalizeStartRequest(msg);
      if (!req || !Number.isInteger(msg.groupId) || msg.groupId < 0) {
        return { error: 'invalid group timer request' };
      }
      const tabs = await chrome.tabs.query({ groupId: msg.groupId });
      for (const tab of tabs) {
        await startTimerForTab(tab.id, req.duration, req.action, req.label);
      }
      return { success: true, count: tabs.length };
    }

    case 'PLAY_SOUND': {
      // Sent by playSound() and consumed by the offscreen document.
      return { success: true };
    }

    case 'EXPORT_DATA': {
      const all = await chrome.storage.local.get(null);
      return {
        data: {
          settings: all[SETTINGS_KEY] || {},
          templates: all[TEMPLATES_KEY] || [],
          urlRules: all[URL_RULES_KEY] || [],
        },
      };
    }

    case 'IMPORT_DATA': {
      const data = msg.data;
      if (!data || typeof data !== 'object') {
        return { error: 'malformed import file' };
      }

      // Only keys actually present are written, so importing a partial file
      // does not silently reset everything it omits.
      const updates = {};
      const dropped = {};
      if (data.settings !== undefined) {
        updates[SETTINGS_KEY] = normalizeSettings(data.settings);
      }
      if (data.templates !== undefined) {
        const templates = normalizeTemplates(data.templates);
        updates[TEMPLATES_KEY] = templates;
        dropped.templates = (Array.isArray(data.templates) ? data.templates.length : 0) - templates.length;
      }
      if (data.urlRules !== undefined) {
        const rules = normalizeUrlRules(data.urlRules);
        updates[URL_RULES_KEY] = rules;
        dropped.urlRules = (Array.isArray(data.urlRules) ? data.urlRules.length : 0) - rules.length;
      }
      if (Object.keys(updates).length === 0) {
        return { error: 'nothing to import' };
      }

      await chrome.storage.local.set(updates);
      invalidateCaches(null);
      await rebuildContextMenus();
      return { success: true, dropped };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

// On install/update
chrome.runtime.onInstalled.addListener(async () => {
  await getAllTimers();
  await applyBadgeStyle();
  await rebuildContextMenus();
  await reconcileTimers();
});

// On startup
chrome.runtime.onStartup.addListener(async () => {
  // Badge text and colour are session state, so re-apply after a browser start.
  await applyBadgeStyle();
  await rebuildContextMenus();
  await reconcileTimers();
});
