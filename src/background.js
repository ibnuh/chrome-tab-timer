// Timer storage key prefix
const TIMER_PREFIX = 'timer_';
const BADGE_ALARM = 'badge_update';
const MIN_ALARM_MS = 61000;

const shortTimers = new Map();

// Storage keys
const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'history_log';
const TEMPLATES_KEY = 'templates';
const URL_RULES_KEY = 'url_rules';
const MAX_HISTORY = 200;

// --- Sound playback via offscreen document ---

let creatingOffscreen = null;

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play notification sound when a timer completes',
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}

async function playSound() {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'PLAY_SOUND' });
}

// --- Settings ---

const SETTINGS_DEFAULTS = {
  sound: true,
  notification: true,
  tabTitle: true,
  theme: 'system',
  defaultAction: 'alert',
  enabledActions: ['alert', 'close', 'reload', 'mute', 'focus'],
  presets: [30, 60, 300, 600, 900, 1800],
  snoozeMinutes: 5,
  alertOnTabClose: false,
};

async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...SETTINGS_DEFAULTS, ...result[SETTINGS_KEY] };
}

// --- History ---

async function addHistoryEntry(timer, tabTitle) {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  const entries = result[HISTORY_KEY] || [];
  entries.unshift({
    tabTitle,
    label: timer.label || '',
    action: timer.action,
    completedAt: Date.now(),
    duration: timer.endTime - (timer.startTime || timer.endTime),
  });
  if (entries.length > MAX_HISTORY) entries.length = MAX_HISTORY;
  await chrome.storage.local.set({ [HISTORY_KEY]: entries });
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
    if (key.startsWith(TIMER_PREFIX)) {
      if (!value || !value.tabId || !Number.isFinite(value.endTime)) {
        staleKeys.push(key);
        continue;
      }
      timers[key] = value;
    }
  }
  if (staleKeys.length > 0) {
    await chrome.storage.local.remove(staleKeys);
  }
  return timers;
}

async function setTimer(tabId, data) {
  const key = TIMER_PREFIX + tabId;
  await chrome.storage.local.set({ [key]: data });
}

async function removeTimer(tabId) {
  const key = TIMER_PREFIX + tabId;
  await chrome.storage.local.remove(key);
  await chrome.alarms.clear(TIMER_PREFIX + tabId);
  if (shortTimers.has(tabId)) {
    clearTimeout(shortTimers.get(tabId));
    shortTimers.delete(tabId);
  }
  await restoreTabTitle(tabId);
  await updateBadgeForTab(tabId);
}

// --- Templates ---

async function getTemplates() {
  const result = await chrome.storage.local.get(TEMPLATES_KEY);
  return result[TEMPLATES_KEY] || [];
}

async function saveTemplates(templates) {
  await chrome.storage.local.set({ [TEMPLATES_KEY]: templates });
}

// --- URL Rules ---

async function getUrlRules() {
  const result = await chrome.storage.local.get(URL_RULES_KEY);
  return result[URL_RULES_KEY] || [];
}

async function saveUrlRules(rules) {
  await chrome.storage.local.set({ [URL_RULES_KEY]: rules });
}

// --- Shared timer start helper ---

async function startTimerForTab(tabId, duration, action, label) {
  const now = Date.now();
  const endTime = now + duration;
  const timerData = { tabId, startTime: now, endTime, action: action || 'alert', label: label || '', paused: false };
  await setTimer(tabId, timerData);
  createTimerAlarm(tabId, duration);
  await ensureBadgeAlarm();
  await updateBadgeForTab(tabId);
  await updateTabTitle(tabId);
}

// --- Alarm management ---

function createTimerAlarm(tabId, delayMs) {
  if (shortTimers.has(tabId)) {
    clearTimeout(shortTimers.get(tabId));
    shortTimers.delete(tabId);
  }

  if (delayMs < MIN_ALARM_MS) {
    const handle = setTimeout(() => {
      shortTimers.delete(tabId);
      onTimerFired(tabId);
    }, delayMs);
    shortTimers.set(tabId, handle);
  } else {
    chrome.alarms.create(TIMER_PREFIX + tabId, { delayInMinutes: delayMs / 60000 });
  }
}

// --- Badge ---

async function updateBadgeForTab(tabId) {
  const timer = await getTimer(tabId);
  if (!timer || timer.paused) {
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch {}
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

  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
  } catch {}
}

async function updateAllBadges() {
  const timers = await getAllTimers();
  const timerTabIds = new Set();

  const openTabs = await chrome.tabs.query({});
  const openTabIds = new Set(openTabs.map((t) => t.id));

  for (const [, timer] of Object.entries(timers)) {
    if (!openTabIds.has(timer.tabId)) {
      await removeTimer(timer.tabId);
      continue;
    }
    timerTabIds.add(timer.tabId);
    await updateBadgeForTab(timer.tabId);
  }

  if (timerTabIds.size > 0) {
    await ensureBadgeAlarm();
  } else {
    await chrome.alarms.clear(BADGE_ALARM);
  }
}

// --- Tab title ---

const TITLE_PREFIX_RE = /^\d+[hms]\d*[ms]? \| /;

async function updateTabTitle(tabId) {
  const cfg = await getSettings();
  if (!cfg.tabTitle) return;
  const timer = await getTimer(tabId);
  if (!timer) return;

  const endTime = timer.paused ? null : timer.endTime;
  const pausedRemaining = timer.paused ? timer.remaining : null;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (endTime, pausedRemaining, prefixRe) => {
        const re = new RegExp(prefixRe);
        if (!window.__tabTimerOrigTitle) {
          window.__tabTimerOrigTitle = document.title.replace(re, '');
        }
        if (window.__tabTimerInterval) {
          clearInterval(window.__tabTimerInterval);
          window.__tabTimerInterval = null;
        }

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

        function tick() {
          let remaining;
          if (endTime) {
            remaining = Math.max(0, endTime - Date.now());
          } else {
            remaining = pausedRemaining || 0;
          }
          const totalSec = Math.ceil(remaining / 1000);
          if (totalSec <= 0) {
            document.title = window.__tabTimerOrigTitle;
            if (window.__tabTimerInterval) clearInterval(window.__tabTimerInterval);
            window.__tabTimerInterval = null;
            window.__tabTimerOrigTitle = null;
            return;
          }
          const prefix = formatSec(totalSec) + ' | ';
          document.title = prefix + window.__tabTimerOrigTitle;
        }

        tick();
        if (endTime) {
          window.__tabTimerInterval = setInterval(tick, 1000);
        }
      },
      args: [endTime, pausedRemaining, TITLE_PREFIX_RE.source],
    });
  } catch {}
}

async function restoreTabTitle(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.__tabTimerInterval) {
          clearInterval(window.__tabTimerInterval);
          window.__tabTimerInterval = null;
        }
        if (window.__tabTimerOrigTitle) {
          document.title = window.__tabTimerOrigTitle;
          window.__tabTimerOrigTitle = null;
        }
      },
    });
  } catch {}
}


async function ensureBadgeAlarm() {
  const existing = await chrome.alarms.get(BADGE_ALARM);
  if (!existing) {
    chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1/6 });
  }
}

// --- Timer fired handler ---

async function onTimerFired(tabId) {
  const timer = await getTimer(tabId);
  if (!timer) return;

  await executeAction(timer);
  await removeTimer(tabId);
  await updateAllBadges();
}

// --- Actions on timer completion ---

const ACTION_LABELS = {
  alert: 'Alert',
  close: 'Tab closed',
  reload: 'Tab reloaded',
  mute: 'Tab muted',
  focus: 'Tab focused',
};

async function executeAction(timer) {
  const { tabId, action, label } = timer;
  const tabTitle = await getTabTitle(tabId);
  const cfg = await getSettings();

  await addHistoryEntry(timer, tabTitle);

  const durationStr = formatDuration(timer.endTime - (timer.startTime || timer.endTime));
  const title = label ? `Timer: ${label}` : 'Tab Timer';
  const actionDesc = ACTION_LABELS[action] || 'Alert';
  const message = `${durationStr} timer completed\n${tabTitle}\nAction: ${actionDesc}`;

  if (cfg.sound) {
    try { await playSound(); } catch (e) { console.warn('Could not play sound', e); }
  }

  if (cfg.notification) {
    chrome.notifications.create('timer_done_' + tabId, {
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
    console.warn('Action failed for tab', tabId, e);
  }
}

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function getTabTitle(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return (tab.title || 'Unknown tab').replace(TITLE_PREFIX_RE, '');
  } catch {
    return 'Unknown tab';
  }
}

// --- Snooze ---

async function snoozeTimer(tabId) {
  const cfg = await getSettings();
  const duration = cfg.snoozeMinutes * 60 * 1000;
  await startTimerForTab(tabId, duration, 'alert', `Snoozed (${cfg.snoozeMinutes}m)`);
}

// --- Context menu ---

function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tabtimer-parent',
      title: 'Tab Timer',
      contexts: ['page'],
    });

    const presetLabels = {
      30: '30s', 60: '1m', 300: '5m', 600: '10m', 900: '15m', 1800: '30m', 3600: '1h',
    };

    // We'll add presets dynamically from settings
    getSettings().then((cfg) => {
      for (const secs of cfg.presets) {
        const label = presetLabels[secs] || formatDuration(secs * 1000);
        chrome.contextMenus.create({
          id: `tabtimer-preset-${secs}`,
          parentId: 'tabtimer-parent',
          title: `Set ${label} timer`,
          contexts: ['page'],
        });
      }

      chrome.contextMenus.create({
        id: 'tabtimer-sep1',
        parentId: 'tabtimer-parent',
        type: 'separator',
        contexts: ['page'],
      });

      chrome.contextMenus.create({
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
    });
  });
}

// --- URL-based auto timers ---

async function checkUrlRules(tabId, url) {
  if (!url) return;
  const rules = await getUrlRules();
  if (rules.length === 0) return;

  // Don't auto-set if tab already has a timer
  const existing = await getTimer(tabId);
  if (existing) return;

  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern) continue;
    try {
      const re = new RegExp(rule.pattern, 'i');
      if (re.test(url)) {
        await startTimerForTab(tabId, rule.duration * 1000, rule.action || 'alert', rule.label || `Auto: ${rule.pattern}`);
        return;
      }
    } catch {}
  }
}

// --- Stats ---

function computeStats(history) {
  if (!history || history.length === 0) {
    return { total: 0, totalDuration: 0, avgDuration: 0, byAction: {}, byDay: {} };
  }

  let totalDuration = 0;
  const byAction = {};
  const byDay = {};

  for (const entry of history) {
    totalDuration += entry.duration || 0;
    byAction[entry.action] = (byAction[entry.action] || 0) + 1;

    const day = new Date(entry.completedAt).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }

  return {
    total: history.length,
    totalDuration,
    avgDuration: Math.round(totalDuration / history.length),
    byAction,
    byDay,
  };
}

// --- Event listeners ---

// Alarm fired
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BADGE_ALARM) {
    await updateAllBadges();
    return;
  }

  if (!alarm.name.startsWith(TIMER_PREFIX)) return;

  const tabId = parseInt(alarm.name.slice(TIMER_PREFIX.length), 10);
  await onTimerFired(tabId);
});

// Notification clicked - focus the tab
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('timer_done_')) return;
  const tabId = parseInt(notificationId.slice('timer_done_'.length), 10);
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {}
  chrome.notifications.clear(notificationId);
});

// Notification button clicked - snooze
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (!notificationId.startsWith('timer_done_')) return;
  if (buttonIndex === 0) {
    const tabId = parseInt(notificationId.slice('timer_done_'.length), 10);
    await snoozeTimer(tabId);
  }
  chrome.notifications.clear(notificationId);
});

// Tab closed - clean up
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const timer = await getTimer(tabId);
  if (timer) {
    // Alert if setting is enabled
    const cfg = await getSettings();
    if (cfg.alertOnTabClose) {
      const durationStr = formatDuration(timer.endTime - (timer.startTime || timer.endTime));
      const label = timer.label ? ` (${timer.label})` : '';
      chrome.notifications.create('tab_closed_' + tabId, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Timer cancelled - tab closed',
        message: `${durationStr} timer${label} was cancelled because the tab was closed.`,
        priority: 1,
      });
    }
    await removeTimer(tabId);
    await updateAllBadges();
  }
});

// Tab activated - update badge
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await updateBadgeForTab(tabId);
});

// Tab URL changed - check URL rules
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url) {
    await checkUrlRules(tabId, changeInfo.url);
  }
  // Re-inject tab title after page load (survives reload/navigation)
  if (changeInfo.status === 'complete') {
    const timer = await getTimer(tabId);
    if (timer) {
      await updateTabTitle(tabId);
    }
  }
});

// Context menu clicked
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;

  if (info.menuItemId === 'tabtimer-cancel') {
    await removeTimer(tab.id);
    await updateAllBadges();
  } else if (info.menuItemId === 'tabtimer-cancel-all') {
    const timers = await getAllTimers();
    for (const [, timer] of Object.entries(timers)) {
      await removeTimer(timer.tabId);
    }
    await updateAllBadges();
  } else if (info.menuItemId.startsWith('tabtimer-preset-')) {
    const secs = parseInt(info.menuItemId.slice('tabtimer-preset-'.length), 10);
    const cfg = await getSettings();
    await startTimerForTab(tab.id, secs * 1000, cfg.defaultAction, '');
  }
});

// Keyboard shortcut
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'quick-timer') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const cfg = await getSettings();
    const defaultPreset = cfg.presets[0] || 60;
    await startTimerForTab(tab.id, defaultPreset * 1000, cfg.defaultAction, '');
  }
});

// --- Message handling from popup/options ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse);
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'START_TIMER': {
      const { tabId, duration, action, label } = msg;
      await startTimerForTab(tabId, duration, action, label);
      return { success: true };
    }

    case 'CANCEL_TIMER': {
      await removeTimer(msg.tabId);
      await updateAllBadges();
      return { success: true };
    }

    case 'CANCEL_ALL_TIMERS': {
      const timers = await getAllTimers();
      for (const [, timer] of Object.entries(timers)) {
        await removeTimer(timer.tabId);
      }
      await updateAllBadges();
      return { success: true };
    }

    case 'PAUSE_TIMER': {
      const timer = await getTimer(msg.tabId);
      if (!timer || timer.paused) return { success: false };
      const remaining = timer.endTime - Date.now();
      timer.paused = true;
      timer.remaining = remaining;
      await setTimer(msg.tabId, timer);
      await chrome.alarms.clear(TIMER_PREFIX + msg.tabId);
      if (shortTimers.has(msg.tabId)) {
        clearTimeout(shortTimers.get(msg.tabId));
        shortTimers.delete(msg.tabId);
      }
      await updateBadgeForTab(msg.tabId);
      await updateTabTitle(msg.tabId);
      return { success: true };
    }

    case 'RESUME_TIMER': {
      const timer = await getTimer(msg.tabId);
      if (!timer || !timer.paused) return { success: false };
      const remaining = timer.remaining;
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
      await chrome.storage.local.remove(HISTORY_KEY);
      return { success: true };

    case 'GET_SETTINGS':
      return { settings: await getSettings() };

    case 'GET_STATS': {
      const result = await chrome.storage.local.get(HISTORY_KEY);
      return { stats: computeStats(result[HISTORY_KEY] || []) };
    }

    // Templates
    case 'GET_TEMPLATES':
      return { templates: await getTemplates() };

    case 'SAVE_TEMPLATES':
      await saveTemplates(msg.templates);
      return { success: true };

    // URL rules
    case 'GET_URL_RULES':
      return { rules: await getUrlRules() };

    case 'SAVE_URL_RULES':
      await saveUrlRules(msg.rules);
      return { success: true };

    // Snooze
    case 'SNOOZE_TIMER':
      await snoozeTimer(msg.tabId);
      return { success: true };

    // Tab group
    case 'START_TIMER_FOR_GROUP': {
      const { groupId, duration, action, label } = msg;
      const tabs = await chrome.tabs.query({ groupId });
      for (const tab of tabs) {
        await startTimerForTab(tab.id, duration, action, label);
      }
      return { success: true, count: tabs.length };
    }

    // Export/import
    case 'EXPORT_DATA': {
      const allData = await chrome.storage.local.get(null);
      const exportData = {
        settings: allData[SETTINGS_KEY] || {},
        templates: allData[TEMPLATES_KEY] || [],
        urlRules: allData[URL_RULES_KEY] || [],
      };
      return { data: exportData };
    }

    case 'IMPORT_DATA': {
      const { data } = msg;
      if (data.settings) await chrome.storage.local.set({ [SETTINGS_KEY]: data.settings });
      if (data.templates) await chrome.storage.local.set({ [TEMPLATES_KEY]: data.templates });
      if (data.urlRules) await chrome.storage.local.set({ [URL_RULES_KEY]: data.urlRules });
      buildContextMenus();
      return { success: true };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

// On install/update
chrome.runtime.onInstalled.addListener(async () => {
  await getAllTimers();
  await updateAllBadges();
  buildContextMenus();
});

// On startup
chrome.runtime.onStartup.addListener(async () => {
  const timers = await getAllTimers();
  for (const [, timer] of Object.entries(timers)) {
    if (timer.paused) continue;
    const remaining = timer.endTime - Date.now();
    if (remaining <= 0) {
      await executeAction(timer, false);
      await removeTimer(timer.tabId);
    } else {
      createTimerAlarm(timer.tabId, remaining);
    }
  }
  await updateAllBadges();
  buildContextMenus();
});
