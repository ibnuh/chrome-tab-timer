import {
  ACTION_LABELS,
  ACTIONS,
  MAX_PATTERN_LENGTH,
  SETTINGS_KEY,
  formatPresetLabel,
  isValidPattern,
  normalizeSettings,
  normalizeUrlRules,
} from './lib.js';

let settings = {};
let urlRules = [];

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
  settings = await loadSettings();
  applyTheme(settings.theme);
  renderSettings();

  const resp = await chrome.runtime.sendMessage({ type: 'GET_URL_RULES' });
  urlRules = normalizeUrlRules(resp.rules);
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
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

async function loadSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
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
      label.textContent = formatPresetLabel(settings.presets[i]);
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

    const error = document.createElement('span');
    error.className = 'rule-error';
    error.hidden = true;

    // Validated live so a broken pattern is caught before saving, not on the
    // next navigation where it would throw inside the worker.
    const validate = () => {
      if (!pattern.value) {
        error.hidden = true;
        row.classList.remove('invalid');
        return;
      }
      const valid = isValidPattern(pattern.value);
      row.classList.toggle('invalid', !valid);
      error.hidden = valid;
      error.textContent = valid
        ? ''
        : pattern.value.length > MAX_PATTERN_LENGTH
          ? `Pattern is longer than ${MAX_PATTERN_LENGTH} characters`
          : 'Not a valid regular expression';
    };

    pattern.addEventListener('input', () => {
      urlRules[i].pattern = pattern.value;
      validate();
    });

    const duration = document.createElement('input');
    duration.type = 'number';
    duration.min = '1';
    duration.placeholder = 'sec';
    duration.value = rule.duration || 300;
    duration.addEventListener('input', () => {
      urlRules[i].duration = parseInt(duration.value, 10) || 300;
    });

    const action = document.createElement('select');
    for (const value of ACTIONS) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = ACTION_LABELS[value];
      action.appendChild(opt);
    }
    action.value = rule.action || 'alert';
    action.addEventListener('change', () => {
      urlRules[i].action = action.value;
    });

    const toggle = document.createElement('label');
    toggle.className = 'toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = rule.enabled !== false;
    cb.addEventListener('change', () => {
      urlRules[i].enabled = cb.checked;
    });
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

    row.append(pattern, duration, action, toggle, remove, error);
    editor.appendChild(row);
    validate();
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
    if (cb.checked) {
      checked.push(cb.value);
    }
  });
  if (checked.length === 0) {
    checked.push('alert');
    document.querySelector('#action-list input[value="alert"]').checked = true;
  }
  settings.enabledActions = checked;

  // A rule with no pattern is an unfinished row and is simply dropped; a rule
  // with an unparseable pattern is refused, because saving it would leave a rule
  // that throws on every matching navigation.
  const blank = urlRules.filter((rule) => !rule.pattern || !rule.pattern.trim());
  const invalid = urlRules.filter((rule) => rule.pattern?.trim() && !isValidPattern(rule.pattern));
  if (invalid.length > 0) {
    showStatus(
      invalid.length === 1
        ? 'Fix the invalid URL pattern before saving'
        : `Fix ${invalid.length} invalid URL patterns before saving`,
      true
    );
    document.querySelector('.url-rule.invalid input[type="text"]')?.focus();
    return;
  }

  const normalized = normalizeSettings(settings);
  settings = normalized;
  urlRules = normalizeUrlRules(urlRules.filter((rule) => !blank.includes(rule)));

  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  await chrome.runtime.sendMessage({ type: 'SAVE_URL_RULES', rules: urlRules });

  renderSettings();
  renderUrlRules();
  showStatus('Settings saved');
}

function showStatus(text, isError = false) {
  const status = document.getElementById('save-status');
  status.textContent = text;
  status.classList.toggle('error', isError);
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => {
    status.textContent = '';
    status.classList.remove('error');
  }, isError ? 4000 : 2000);
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
  if (!file) {
    return;
  }

  try {
    const data = JSON.parse(await file.text());
    const result = await chrome.runtime.sendMessage({ type: 'IMPORT_DATA', data });
    if (result?.error) {
      showStatus(`Import failed: ${result.error}`, true);
      return;
    }

    settings = await loadSettings();
    const resp = await chrome.runtime.sendMessage({ type: 'GET_URL_RULES' });
    urlRules = normalizeUrlRules(resp.rules);
    renderSettings();
    renderUrlRules();
    applyTheme(settings.theme);

    const dropped = result?.dropped || {};
    const skipped = (dropped.templates || 0) + (dropped.urlRules || 0);
    showStatus(skipped > 0 ? `Imported, skipped ${skipped} unusable entr${skipped === 1 ? 'y' : 'ies'}` : 'Imported successfully');
  } catch {
    showStatus('Import failed: invalid file', true);
  } finally {
    e.target.value = '';
  }
}
