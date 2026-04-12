const SETTINGS_KEY = 'settings';

const DEFAULTS = {
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

let settings = {};
let urlRules = [];

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
  settings = await loadSettings();
  applyTheme(settings.theme);
  renderSettings();

  // Load URL rules
  const resp = await chrome.runtime.sendMessage({ type: 'GET_URL_RULES' });
  urlRules = resp.rules || [];
  renderUrlRules();

  document.getElementById('save-btn').addEventListener('click', saveSettings);
  document.getElementById('add-preset-btn').addEventListener('click', addPreset);
  document.getElementById('add-url-rule-btn').addEventListener('click', addUrlRule);
  document.getElementById('opt-theme').addEventListener('change', (e) => applyTheme(e.target.value));
  document.getElementById('export-btn').addEventListener('click', exportData);
  document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', importData);
});

function applyTheme(theme) {
  let resolved = theme;
  if (theme === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', resolved);
}

async function loadSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULTS, ...result[SETTINGS_KEY] };
}

function renderSettings() {
  document.getElementById('opt-sound').checked = settings.sound;
  document.getElementById('opt-notification').checked = settings.notification;
  document.getElementById('opt-tabtitle').checked = settings.tabTitle;
  document.getElementById('opt-theme').value = settings.theme;
  document.getElementById('opt-default-action').value = settings.defaultAction;
  document.getElementById('opt-snooze').value = settings.snoozeMinutes;
  document.getElementById('opt-alert-tab-close').checked = settings.alertOnTabClose;

  document.querySelectorAll('#action-list input[type="checkbox"]').forEach((cb) => {
    cb.checked = settings.enabledActions.includes(cb.value);
  });

  renderPresets();
}

// --- Presets ---

function renderPresets() {
  const editor = document.getElementById('presets-editor');
  editor.innerHTML = '';

  settings.presets.forEach((secs, i) => {
    const row = document.createElement('div');
    row.className = 'preset-row';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.value = secs;

    const label = document.createElement('span');
    label.className = 'preset-label';
    label.textContent = formatPresetLabel(secs);

    input.addEventListener('input', () => {
      settings.presets[i] = parseInt(input.value, 10) || 0;
      label.textContent = formatPresetLabel(parseInt(input.value, 10) || 0);
    });

    const remove = document.createElement('button');
    remove.className = 'remove-preset';
    remove.innerHTML = '&times;';
    remove.addEventListener('click', () => {
      settings.presets.splice(i, 1);
      renderPresets();
    });

    row.append(input, label, remove);
    editor.appendChild(row);
  });
}

function addPreset() {
  settings.presets.push(60);
  renderPresets();
}

function formatPresetLabel(secs) {
  if (!secs || secs <= 0) return '-';
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return m > 0 ? `= ${h}h ${m}m` : `= ${h}h`;
  }
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s > 0 ? `= ${m}m ${s}s` : `= ${m}m`;
  }
  return `= ${secs}s`;
}

// --- URL Rules ---

function renderUrlRules() {
  const editor = document.getElementById('url-rules-editor');
  editor.innerHTML = '';

  urlRules.forEach((rule, i) => {
    const row = document.createElement('div');
    row.className = 'url-rule';

    const pattern = document.createElement('input');
    pattern.type = 'text';
    pattern.placeholder = 'URL pattern (regex)';
    pattern.value = rule.pattern || '';
    pattern.addEventListener('input', () => { urlRules[i].pattern = pattern.value; });

    const duration = document.createElement('input');
    duration.type = 'number';
    duration.min = '1';
    duration.placeholder = 'sec';
    duration.value = rule.duration || 300;
    duration.addEventListener('input', () => { urlRules[i].duration = parseInt(duration.value, 10) || 300; });

    const action = document.createElement('select');
    for (const [val, text] of Object.entries({ alert: 'Alert', close: 'Close', reload: 'Reload', mute: 'Mute', focus: 'Focus' })) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      action.appendChild(opt);
    }
    action.value = rule.action || 'alert';
    action.addEventListener('change', () => { urlRules[i].action = action.value; });

    const toggle = document.createElement('label');
    toggle.className = 'toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = rule.enabled !== false;
    cb.addEventListener('change', () => { urlRules[i].enabled = cb.checked; });
    const slider = document.createElement('span');
    slider.className = 'toggle-slider';
    toggle.append(cb, slider);

    const remove = document.createElement('button');
    remove.className = 'remove-preset';
    remove.innerHTML = '&times;';
    remove.addEventListener('click', () => {
      urlRules.splice(i, 1);
      renderUrlRules();
    });

    row.append(pattern, duration, action, toggle, remove);
    editor.appendChild(row);
  });
}

function addUrlRule() {
  urlRules.push({ pattern: '', duration: 1800, action: 'alert', enabled: true, label: '' });
  renderUrlRules();
}

// --- Save ---

async function saveSettings() {
  settings.sound = document.getElementById('opt-sound').checked;
  settings.notification = document.getElementById('opt-notification').checked;
  settings.tabTitle = document.getElementById('opt-tabtitle').checked;
  settings.theme = document.getElementById('opt-theme').value;
  settings.defaultAction = document.getElementById('opt-default-action').value;
  settings.snoozeMinutes = parseInt(document.getElementById('opt-snooze').value, 10) || 5;
  settings.alertOnTabClose = document.getElementById('opt-alert-tab-close').checked;

  const checked = [];
  document.querySelectorAll('#action-list input[type="checkbox"]').forEach((cb) => {
    if (cb.checked) checked.push(cb.value);
  });
  if (checked.length === 0) {
    checked.push('alert');
    document.querySelector('#action-list input[value="alert"]').checked = true;
  }
  settings.enabledActions = checked;

  settings.presets = [...new Set(settings.presets.filter((v) => v > 0))].sort((a, b) => a - b);

  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  await chrome.runtime.sendMessage({ type: 'SAVE_URL_RULES', rules: urlRules });

  showStatus('Settings saved');
}

function showStatus(text) {
  const status = document.getElementById('save-status');
  status.textContent = text;
  setTimeout(() => { status.textContent = ''; }, 2000);
}

// --- Export/Import ---

async function exportData() {
  const { data } = await chrome.runtime.sendMessage({ type: 'EXPORT_DATA' });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tab-timer-settings.json';
  a.click();
  URL.revokeObjectURL(url);
  showStatus('Exported');
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await chrome.runtime.sendMessage({ type: 'IMPORT_DATA', data });

    // Reload
    settings = await loadSettings();
    const resp = await chrome.runtime.sendMessage({ type: 'GET_URL_RULES' });
    urlRules = resp.rules || [];
    renderSettings();
    renderUrlRules();
    applyTheme(settings.theme);
    showStatus('Imported successfully');
  } catch (err) {
    showStatus('Import failed: invalid file');
  }

  e.target.value = '';
}
