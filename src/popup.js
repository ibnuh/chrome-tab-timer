import {
  ACTION_LABELS,
  SETTINGS_DEFAULTS,
  dayKeysBack,
  dayLabel,
  escapeHtml,
  formatClock,
  formatDuration,
  formatPresetLabel,
  stripTitlePrefix,
  timeAgo,
  truncate,
} from './lib.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/** Short labels for the narrow history chip. */
const HISTORY_ACTION_LABELS = {
  alert: 'Alert',
  close: 'Closed',
  reload: 'Reloaded',
  mute: 'Muted',
  focus: 'Focused',
};

let currentTabId = null;
let currentTabGroupId = null;
let tickInterval = null;
let settings = null;

// Snapshot of the last render. The 1s tick recomputes countdowns from these
// objects locally, so an open popup sends no messages while it just counts down.
let currentTimer = null;
let activeTimers = [];
let currentTimeEl = null;
let rowTimeEls = [];

let refreshing = false;
let refreshQueued = false;
let refreshTimer = null;

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return;
  }
  currentTabId = tab.id;
  currentTabGroupId = tab.groupId >= 0 ? tab.groupId : null;

  // Falls back to defaults rather than throwing: the worker now answers failures
  // with {error}, and a popup that half-initialises is worse than one running on
  // default presets.
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  settings = resp?.settings || SETTINGS_DEFAULTS;

  applyTheme(settings.theme);
  buildPresets();
  buildActionSelect();
  await buildTemplates();

  if (currentTabGroupId !== null) {
    $('#group-option').style.display = '';
  }

  $('#input-min').addEventListener('input', () => {
    clearPresetHighlight();
    updateStartBtn();
  });
  $('#input-sec').addEventListener('input', () => {
    clearPresetHighlight();
    updateStartBtn();
  });
  $('#start-btn').addEventListener('click', startTimer);
  $('#save-template-btn').addEventListener('click', saveAsTemplate);
  $('#clear-history-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
    await refresh();
  });
  $('#cancel-all-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CANCEL_ALL_TIMERS' });
    await refresh();
  });
  $('#open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#stats-btn').addEventListener('click', showStats);
  $('#close-stats-btn').addEventListener('click', () => {
    $('#stats-section').style.display = 'none';
  });

  for (const id of ['#input-min', '#input-sec']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        startTimer();
      }
    });
  }

  // Every timer mutation lands in storage, so this is the single trigger for
  // rebuilding the lists.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      scheduleRefresh();
    }
  });

  updateStartBtn();
  await refresh();
  tickInterval = setInterval(tickCountdowns, 1000);
});

window.addEventListener('pagehide', () => {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
});

function applyTheme(theme) {
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

// --- Static controls ---

function buildPresets() {
  const container = $('#presets');
  container.innerHTML = '';
  for (const secs of settings.presets) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = formatPresetLabel(secs);
    btn.addEventListener('click', () => {
      clearPresetHighlight();
      btn.classList.add('active');
      $('#input-min').value = Math.floor(secs / 60);
      $('#input-sec').value = secs % 60;
      updateStartBtn();
    });
    container.appendChild(btn);
  }
}

function buildActionSelect() {
  const select = $('#action-select');
  select.innerHTML = '';
  for (const action of settings.enabledActions) {
    const opt = document.createElement('option');
    opt.value = action;
    opt.textContent = ACTION_LABELS[action] || action;
    select.appendChild(opt);
  }
  select.value = settings.defaultAction;
}

async function buildTemplates() {
  const { templates } = await chrome.runtime.sendMessage({ type: 'GET_TEMPLATES' });
  const bar = $('#templates-bar');
  const list = $('#templates-list');

  if (!templates || templates.length === 0) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = '';
  list.innerHTML = '';

  for (const tpl of templates) {
    const chip = document.createElement('button');
    chip.className = 'template-chip';
    chip.textContent = tpl.name;
    chip.title = `${formatPresetLabel(tpl.duration / 1000)} - ${ACTION_LABELS[tpl.action] || tpl.action}`;
    chip.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        type: 'START_TIMER',
        tabId: currentTabId,
        duration: tpl.duration,
        action: tpl.action,
        label: tpl.label || tpl.name,
      });
      await refresh();
    });

    // Right-click to delete
    chip.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const { templates: fresh } = await chrome.runtime.sendMessage({ type: 'GET_TEMPLATES' });
      await chrome.runtime.sendMessage({
        type: 'SAVE_TEMPLATES',
        templates: (Array.isArray(fresh) ? fresh : []).filter((t) => t.name !== tpl.name),
      });
      await buildTemplates();
    });

    list.appendChild(chip);
  }
}

async function saveAsTemplate() {
  const min = parseInt($('#input-min').value, 10) || 0;
  const sec = parseInt($('#input-sec').value, 10) || 0;
  const duration = (min * 60 + sec) * 1000;
  if (duration < 1000) {
    return;
  }

  const name = prompt('Template name:');
  if (!name) {
    return;
  }

  const { templates } = await chrome.runtime.sendMessage({ type: 'GET_TEMPLATES' });
  const updated = Array.isArray(templates) ? templates : [];
  updated.push({
    name,
    duration,
    action: $('#action-select').value,
    label: $('#label-input').value.trim(),
  });
  await chrome.runtime.sendMessage({ type: 'SAVE_TEMPLATES', templates: updated });
  await buildTemplates();
}

function clearPresetHighlight() {
  $$('.preset-btn').forEach((b) => b.classList.remove('active'));
}

function updateStartBtn() {
  const min = parseInt($('#input-min').value, 10) || 0;
  const sec = parseInt($('#input-sec').value, 10) || 0;
  $('#start-btn').disabled = min * 60 + sec < 1;
}

// --- Start timer ---

async function startTimer() {
  const min = parseInt($('#input-min').value, 10) || 0;
  const sec = parseInt($('#input-sec').value, 10) || 0;
  const duration = (min * 60 + sec) * 1000;
  if (duration < 1000) {
    return;
  }

  const action = $('#action-select').value;
  const label = $('#label-input').value.trim();
  const applyToGroup = currentTabGroupId !== null && $('#apply-to-group')?.checked;

  const response = await chrome.runtime.sendMessage(
    applyToGroup
      ? { type: 'START_TIMER_FOR_GROUP', groupId: currentTabGroupId, duration, action, label }
      : { type: 'START_TIMER', tabId: currentTabId, duration, action, label }
  );

  if (response?.error) {
    console.warn('Tab Timer: could not start timer:', response.error);
    return;
  }

  $('#input-min').value = '';
  $('#input-sec').value = '';
  $('#label-input').value = '';
  if ($('#apply-to-group')) {
    $('#apply-to-group').checked = false;
  }
  clearPresetHighlight();
  updateStartBtn();
  await refresh();
}

// --- Render ---

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 50);
}

async function refresh() {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    const [currentResp, allResp, historyResp] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_TIMER', tabId: currentTabId }),
      chrome.runtime.sendMessage({ type: 'GET_ALL_TIMERS' }),
      chrome.runtime.sendMessage({ type: 'GET_HISTORY' }),
    ]);

    currentTimer = currentResp?.timer || null;
    activeTimers = Object.values(allResp?.timers || {}).sort(
      (a, b) => (a.paused ? Infinity : a.endTime) - (b.paused ? Infinity : b.endTime)
    );

    renderCurrentTab();
    await renderAllTimers();
    renderHistory(historyResp?.history || []);
    tickCountdowns();
  } catch (err) {
    // Stale UI beats a popup that stops updating entirely.
    console.error('Tab Timer: refresh failed', err);
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      refresh();
    }
  }
}

function remainingOf(timer, now) {
  if (!timer) {
    return 0;
  }
  return timer.paused ? Math.max(0, timer.remaining || 0) : Math.max(0, timer.endTime - now);
}

/** Text-only update, run once a second. Sends no messages. */
function tickCountdowns() {
  const now = Date.now();
  if (currentTimeEl && currentTimer) {
    currentTimeEl.textContent = formatClock(remainingOf(currentTimer, now));
  }
  for (let i = 0; i < rowTimeEls.length; i++) {
    const timer = activeTimers[i];
    if (timer && rowTimeEls[i]) {
      rowTimeEls[i].textContent = formatClock(remainingOf(timer, now));
    }
  }
}

function renderCurrentTab() {
  const area = $('#current-timer-area');
  currentTimeEl = null;

  if (!currentTimer) {
    area.innerHTML = '<div class="no-timer">No timer on this tab</div>';
    return;
  }

  const pauseLabel = currentTimer.paused ? 'Resume' : 'Pause';
  const pauseAction = currentTimer.paused ? 'RESUME_TIMER' : 'PAUSE_TIMER';
  const labelHtml = currentTimer.label
    ? `<div class="timer-label">${escapeHtml(currentTimer.label)}</div>`
    : '';

  area.innerHTML = `
    <div class="current-timer">
      <div class="timer-display">
        <div class="time-left">${formatClock(remainingOf(currentTimer, Date.now()))}</div>
        ${labelHtml}
      </div>
      <div class="actions">
        <button class="btn btn-pause" data-action="${pauseAction}">${pauseLabel}</button>
        <button class="btn btn-cancel" data-action="CANCEL_TIMER">Cancel</button>
      </div>
    </div>
  `;

  currentTimeEl = area.querySelector('.time-left');

  area.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: btn.dataset.action, tabId: currentTabId });
      await refresh();
    });
  });
}

async function renderAllTimers() {
  const section = $('#active-section');
  const list = $('#timer-list');
  rowTimeEls = [];

  if (activeTimers.length === 0) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }

  section.style.display = '';

  const tabs = await chrome.tabs.query({});
  const tabMap = new Map(tabs.map((t) => [t.id, t.title || `Tab ${t.id}`]));

  let html = '';
  for (const timer of activeTimers) {
    const title = stripTitlePrefix(tabMap.get(timer.tabId) || 'Closed tab');
    const isCurrent = timer.tabId === currentTabId;

    html += `
      <li class="timer-item">
        <div class="tab-info">
          <div class="tab-title${isCurrent ? ' current' : ''}" title="${escapeHtml(title)}">${escapeHtml(truncate(title, 28))}</div>
          ${timer.paused ? '<div class="timer-meta">Paused</div>' : ''}
        </div>
        <span class="time-remaining${timer.paused ? ' paused' : ''}">${formatClock(remainingOf(timer, Date.now()))}</span>
        <button class="cancel-btn" data-cancel-tab="${timer.tabId}" title="Cancel">&times;</button>
      </li>
    `;
  }
  list.innerHTML = html;

  rowTimeEls = [...list.querySelectorAll('.time-remaining')];

  list.querySelectorAll('[data-cancel-tab]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        type: 'CANCEL_TIMER',
        tabId: parseInt(btn.dataset.cancelTab, 10),
      });
      await refresh();
    });
  });
}

function renderHistory(history) {
  const section = $('#history-section');
  const list = $('#history-list');

  if (history.length === 0) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }

  section.style.display = '';

  let html = '';
  for (const entry of history.slice(0, 10)) {
    const title = entry.label
      ? `${escapeHtml(entry.label)} - ${escapeHtml(truncate(entry.tabTitle, 22))}`
      : escapeHtml(truncate(entry.tabTitle, 32));
    const actionTag = escapeHtml(HISTORY_ACTION_LABELS[entry.action] || entry.action || '');

    html += `
      <li class="history-item">
        <div class="history-info">
          <div class="history-title" title="${escapeHtml(entry.tabTitle)}">${title}</div>
          <div class="history-meta">${formatDuration(entry.duration)} &middot; ${timeAgo(entry.completedAt)}</div>
        </div>
        <span class="history-action">${actionTag}</span>
      </li>
    `;
  }
  if (history.length > 10) {
    html += `<li class="empty-state">+${history.length - 10} more</li>`;
  }
  list.innerHTML = html;
}

// --- Stats ---

async function showStats() {
  const { stats } = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
  if (!stats) {
    return;
  }
  const section = $('#stats-section');
  const content = $('#stats-content');

  content.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-value">${stats.total}</div><div class="stat-label">Total Timers</div></div>
      <div class="stat-card"><div class="stat-value">${formatDuration(stats.totalDuration)}</div><div class="stat-label">Total Time</div></div>
      <div class="stat-card"><div class="stat-value">${formatDuration(stats.avgDuration)}</div><div class="stat-label">Avg Duration</div></div>
      <div class="stat-card"><div class="stat-value">${Object.keys(stats.byDay).length}</div><div class="stat-label">Active Days</div></div>
    </div>
    <div class="stat-bar-section">
      <div class="stat-bar-title">By Action</div>
      ${barChart(
        Object.entries(stats.byAction).map(([action, count]) => [
          ACTION_LABELS[action] || action,
          count,
        ])
      )}
    </div>
    <div class="stat-bar-section">
      <div class="stat-bar-title">Last 7 Days</div>
      ${barChart(
        dayKeysBack(7).map((day) => [dayLabel(day), stats.byDay[day] || 0]),
        'No timers in the last 7 days'
      )}
    </div>
  `;

  section.style.display = '';
}

/** Horizontal bar rows for [label, count] pairs, scaled to the largest count. */
function barChart(rows, emptyText = 'No data') {
  // The 7-day chart always has 7 rows, so an all-zero week has to be treated as
  // empty here rather than by the caller.
  if (rows.length === 0 || rows.every(([, count]) => count === 0)) {
    return `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
  }
  const max = Math.max(1, ...rows.map(([, count]) => count));
  return rows
    .map(([label, count]) => {
      const pct = (count / max) * 100;
      return `
      <div class="stat-bar-row">
        <span class="stat-bar-label">${escapeHtml(label)}</span>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
        <span class="stat-bar-count">${count}</span>
      </div>`;
    })
    .join('');
}
