const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const ALL_ACTIONS = {
  alert: 'Alert',
  close: 'Close tab',
  reload: 'Reload tab',
  mute: 'Mute tab',
  focus: 'Focus tab',
};

let currentTabId = null;
let currentTabGroupId = null;
let refreshInterval = null;
let settings = null;

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;
  currentTabGroupId = tab.groupId >= 0 ? tab.groupId : null;

  const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  settings = resp.settings;

  applyTheme(settings.theme);
  buildPresets();
  buildActionSelect();
  await buildTemplates();

  // Show group option if tab is in a group
  if (currentTabGroupId !== null) {
    $('#group-option').style.display = '';
  }

  $('#input-min').addEventListener('input', () => { clearPresetHighlight(); updateStartBtn(); });
  $('#input-sec').addEventListener('input', () => { clearPresetHighlight(); updateStartBtn(); });
  $('#start-btn').addEventListener('click', startTimer);
  $('#save-template-btn').addEventListener('click', saveAsTemplate);
  $('#clear-history-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
    await render();
  });
  $('#cancel-all-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CANCEL_ALL_TIMERS' });
    await render();
  });
  $('#open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#stats-btn').addEventListener('click', showStats);
  $('#close-stats-btn').addEventListener('click', () => { $('#stats-section').style.display = 'none'; });

  $('#input-min').addEventListener('keydown', (e) => { if (e.key === 'Enter') startTimer(); });
  $('#input-sec').addEventListener('keydown', (e) => { if (e.key === 'Enter') startTimer(); });

  updateStartBtn();
  await render();
  refreshInterval = setInterval(render, 1000);
});

function applyTheme(theme) {
  let resolved = theme;
  if (theme === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', resolved);
}

function buildPresets() {
  const container = $('#presets');
  container.innerHTML = '';
  for (const secs of settings.presets) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.dataset.seconds = secs;
    btn.textContent = formatPresetLabel(secs);
    btn.addEventListener('click', () => {
      $$('.preset-btn').forEach((b) => b.classList.remove('active'));
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
    opt.textContent = ALL_ACTIONS[action] || action;
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
    chip.title = `${formatPresetLabel(tpl.duration / 1000)} - ${ALL_ACTIONS[tpl.action] || tpl.action}`;
    chip.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        type: 'START_TIMER',
        tabId: currentTabId,
        duration: tpl.duration,
        action: tpl.action,
        label: tpl.label || tpl.name,
      });
      await render();
    });

    // Right-click to delete
    chip.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const { templates: current } = await chrome.runtime.sendMessage({ type: 'GET_TEMPLATES' });
      const updated = current.filter((t) => t.name !== tpl.name);
      await chrome.runtime.sendMessage({ type: 'SAVE_TEMPLATES', templates: updated });
      await buildTemplates();
    });

    list.appendChild(chip);
  }
}

async function saveAsTemplate() {
  const min = parseInt($('#input-min').value, 10) || 0;
  const sec = parseInt($('#input-sec').value, 10) || 0;
  const duration = (min * 60 + sec) * 1000;
  if (duration < 1000) return;

  const action = $('#action-select').value;
  const label = $('#label-input').value.trim();
  const name = prompt('Template name:');
  if (!name) return;

  const { templates } = await chrome.runtime.sendMessage({ type: 'GET_TEMPLATES' });
  templates.push({ name, duration, action, label });
  await chrome.runtime.sendMessage({ type: 'SAVE_TEMPLATES', templates });
  await buildTemplates();
}

async function showStats() {
  const { stats } = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
  const section = $('#stats-section');
  const content = $('#stats-content');

  const maxByAction = Math.max(1, ...Object.values(stats.byAction));
  let actionBars = '';
  for (const [action, count] of Object.entries(stats.byAction)) {
    const pct = (count / maxByAction) * 100;
    const label = ALL_ACTIONS[action] || action;
    actionBars += `
      <div class="stat-bar-row">
        <span class="stat-bar-label">${label}</span>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
        <span class="stat-bar-count">${count}</span>
      </div>`;
  }

  // Last 7 days bars
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  const maxByDay = Math.max(1, ...days.map((d) => stats.byDay[d] || 0));
  let dayBars = '';
  for (const d of days) {
    const count = stats.byDay[d] || 0;
    const pct = (count / maxByDay) * 100;
    const label = new Date(d).toLocaleDateString('en', { weekday: 'short' });
    dayBars += `
      <div class="stat-bar-row">
        <span class="stat-bar-label">${label}</span>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
        <span class="stat-bar-count">${count}</span>
      </div>`;
  }

  content.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-value">${stats.total}</div><div class="stat-label">Total Timers</div></div>
      <div class="stat-card"><div class="stat-value">${formatDuration(stats.totalDuration)}</div><div class="stat-label">Total Time</div></div>
      <div class="stat-card"><div class="stat-value">${formatDuration(stats.avgDuration)}</div><div class="stat-label">Avg Duration</div></div>
      <div class="stat-card"><div class="stat-value">${Object.keys(stats.byDay).length}</div><div class="stat-label">Active Days</div></div>
    </div>
    <div class="stat-bar-section">
      <div class="stat-bar-title">By Action</div>
      ${actionBars || '<div class="empty-state">No data</div>'}
    </div>
    <div class="stat-bar-section">
      <div class="stat-bar-title">Last 7 Days</div>
      ${dayBars}
    </div>
  `;

  section.style.display = '';
}

function formatPresetLabel(secs) {
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  return `${secs}s`;
}

function clearPresetHighlight() {
  $$('.preset-btn').forEach((b) => b.classList.remove('active'));
}

function updateStartBtn() {
  const min = parseInt($('#input-min').value, 10) || 0;
  const sec = parseInt($('#input-sec').value, 10) || 0;
  $('#start-btn').disabled = (min * 60 + sec) < 1;
}

window.addEventListener('unload', () => {
  if (refreshInterval) clearInterval(refreshInterval);
});

// --- Start timer ---

async function startTimer() {
  const min = parseInt($('#input-min').value, 10) || 0;
  const sec = parseInt($('#input-sec').value, 10) || 0;
  const duration = (min * 60 + sec) * 1000;
  if (duration < 1000) return;

  const action = $('#action-select').value;
  const label = $('#label-input').value.trim();
  const applyToGroup = currentTabGroupId !== null && $('#apply-to-group')?.checked;

  if (applyToGroup) {
    await chrome.runtime.sendMessage({
      type: 'START_TIMER_FOR_GROUP',
      groupId: currentTabGroupId,
      duration, action, label,
    });
  } else {
    await chrome.runtime.sendMessage({
      type: 'START_TIMER',
      tabId: currentTabId,
      duration, action, label,
    });
  }

  $('#input-min').value = '';
  $('#input-sec').value = '';
  $('#label-input').value = '';
  if ($('#apply-to-group')) $('#apply-to-group').checked = false;
  clearPresetHighlight();
  updateStartBtn();
  await render();
}

// --- Render ---

async function render() {
  await renderCurrentTab();
  await renderAllTimers();
  await renderHistory();
}

async function renderCurrentTab() {
  const area = $('#current-timer-area');
  const { timer } = await chrome.runtime.sendMessage({ type: 'GET_TIMER', tabId: currentTabId });

  if (!timer) {
    area.innerHTML = '<div class="no-timer">No timer on this tab</div>';
    return;
  }

  const remaining = timer.paused ? timer.remaining : Math.max(0, timer.endTime - Date.now());
  const timeStr = formatTime(remaining);
  const pauseLabel = timer.paused ? 'Resume' : 'Pause';
  const pauseAction = timer.paused ? 'RESUME_TIMER' : 'PAUSE_TIMER';
  const labelHtml = timer.label ? `<div class="timer-label">${escapeHtml(timer.label)}</div>` : '';

  area.innerHTML = `
    <div class="current-timer">
      <div class="timer-display">
        <div class="time-left">${timeStr}</div>
        ${labelHtml}
      </div>
      <div class="actions">
        <button class="btn btn-pause" data-action="${pauseAction}" data-tab="${currentTabId}">${pauseLabel}</button>
        <button class="btn btn-cancel" data-action="CANCEL_TIMER" data-tab="${currentTabId}">Cancel</button>
      </div>
    </div>
  `;

  area.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: btn.dataset.action, tabId: parseInt(btn.dataset.tab, 10) });
      await render();
    });
  });
}

async function renderAllTimers() {
  const section = $('#active-section');
  const list = $('#timer-list');
  const { timers } = await chrome.runtime.sendMessage({ type: 'GET_ALL_TIMERS' });

  const entries = Object.values(timers);
  if (entries.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';

  const tabs = await chrome.tabs.query({});
  const tabMap = {};
  for (const t of tabs) tabMap[t.id] = t.title || 'Tab ' + t.id;

  let html = '';
  for (const timer of entries) {
    const remaining = timer.paused ? timer.remaining : Math.max(0, timer.endTime - Date.now());
    const timeStr = formatTime(remaining);
    const rawTitle = tabMap[timer.tabId] || 'Closed tab';
    const title = rawTitle.replace(/^\d+[hms]\d*[ms]? \| /, '');
    const isCurrent = timer.tabId === currentTabId;
    const pausedClass = timer.paused ? ' paused' : '';

    html += `
      <li class="timer-item">
        <div class="tab-info">
          <div class="tab-title${isCurrent ? ' current' : ''}" title="${escapeHtml(title)}">${escapeHtml(truncate(title, 28))}</div>
          ${timer.paused ? '<div class="timer-meta">Paused</div>' : ''}
        </div>
        <span class="time-remaining${pausedClass}">${timeStr}</span>
        <button class="cancel-btn" data-cancel-tab="${timer.tabId}" title="Cancel">&times;</button>
      </li>
    `;
  }
  list.innerHTML = html;

  list.querySelectorAll('[data-cancel-tab]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'CANCEL_TIMER', tabId: parseInt(btn.dataset.cancelTab, 10) });
      await render();
    });
  });
}

async function renderHistory() {
  const section = $('#history-section');
  const list = $('#history-list');
  const { history } = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });

  if (!history || history.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';

  const actionLabels = { alert: 'Alert', close: 'Closed', reload: 'Reloaded', mute: 'Muted', focus: 'Focused' };

  let html = '';
  // Show max 10 in popup
  const shown = history.slice(0, 10);
  for (const entry of shown) {
    const title = entry.label
      ? `${escapeHtml(entry.label)} - ${escapeHtml(truncate(entry.tabTitle, 22))}`
      : escapeHtml(truncate(entry.tabTitle, 32));
    const ago = timeAgo(entry.completedAt);
    const dur = formatDuration(entry.duration);
    const actionTag = actionLabels[entry.action] || entry.action;

    html += `
      <li class="history-item">
        <div class="history-info">
          <div class="history-title" title="${escapeHtml(entry.tabTitle)}">${title}</div>
          <div class="history-meta">${dur} &middot; ${ago}</div>
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

// --- Helpers ---

function formatTime(ms) {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function pad(n) { return n.toString().padStart(2, '0'); }

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
