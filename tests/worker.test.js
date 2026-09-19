import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Integration tests for the service worker's message layer.
 *
 * background.js is loaded against a minimal chrome stub so the request
 * validation, error responses, and import normalization can be exercised
 * without a browser. The stub deliberately stays small: assertions here are
 * about observable behavior (what a sender gets back, what lands in storage),
 * not about which chrome calls were made.
 */

const BACKGROUND_URL = new URL('../src/background.js', import.meta.url).href;

function createChromeStub({ store = {}, throwOn = null, openTabs = [], latencyMs = 0 } = {}) {
  const state = {
    store: { ...store },
    alarms: new Map(),
    created: [],
    cleared: [],
    openTabs: openTabs.map((t) => (typeof t === 'number' ? { id: t, windowId: 1 } : t)),
    // Keys of every completed storage read, in order. Lets a test wait for a
    // specific read to land instead of guessing with sleeps.
    reads: [],
    notifications: [],
  };
  const delay = () => (latencyMs > 0 ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve());
  const listeners = { message: [], alarm: [], storageChanged: [], installed: [], startup: [] };

  const maybeThrow = (label) => {
    if (throwOn === label) {
      throw new Error(`stub failure: ${label}`);
    }
  };

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          maybeThrow('storage.get');
          await delay();
          state.reads.push(keys === undefined ? null : keys);
          if (keys === null || keys === undefined) {
            return { ...state.store };
          }
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) {
            if (key in state.store) {
              out[key] = state.store[key];
            }
          }
          return out;
        },
        async set(items) {
          maybeThrow('storage.set');
          // Writes are delayed too, not just reads. With an instant remove the
          // completion window closes before a concurrent path can enter it,
          // which is how the double-completion race hid from an earlier version
          // of this test.
          await delay();
          Object.assign(state.store, items);
        },
        async remove(keys) {
          maybeThrow('storage.remove');
          await delay();
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete state.store[key];
          }
        },
      },
      onChanged: { addListener: (l) => listeners.storageChanged.push(l) },
    },
    alarms: {
      async get(name) {
        return state.alarms.get(name);
      },
      create(name, info) {
        state.alarms.set(name, info);
        state.created.push({ name, info });
      },
      async clear(name) {
        state.alarms.delete(name);
        state.cleared.push(name);
        return true;
      },
      onAlarm: { addListener: (l) => listeners.alarm.push(l) },
    },
    tabs: {
      async query(query) {
        maybeThrow('tabs.query');
        if (query?.groupId !== undefined) {
          if (query.groupId < 0) {
            throw new Error('invalid groupId');
          }
          return state.openTabs.filter((t) => t.groupId === query.groupId);
        }
        return state.openTabs;
      },
      async get(tabId) {
        return { id: tabId, title: 'Example Page', windowId: 1 };
      },
      async remove() {},
      async update() {},
      async reload() {},
      onRemoved: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    runtime: {
      async sendMessage() {},
      onMessage: { addListener: (l) => listeners.message.push(l) },
      onInstalled: { addListener: (l) => listeners.installed.push(l) },
      onStartup: { addListener: (l) => listeners.startup.push(l) },
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
    },
    scripting: { async executeScript() {} },
    offscreen: {
      async hasDocument() {
        return true;
      },
      async createDocument() {},
    },
    notifications: {
      create(id, options) {
        state.notifications.push({ id, title: options?.title });
      },
      clear() {},
      onClicked: { addListener: () => {} },
      onButtonClicked: { addListener: () => {} },
    },
    contextMenus: {
      async removeAll() {},
      create() {},
      onClicked: { addListener: () => {} },
    },
    commands: { onCommand: { addListener: () => {} } },
    windows: { async update() {} },
  };

  return { chrome, state, listeners };
}

let unique = 0;

async function loadWorker(options) {
  const stub = createChromeStub(options);
  // Cache-busting query keeps each test on its own module instance, since the
  // worker registers its listeners as an import side effect.
  globalThis.chrome = stub.chrome;
  await import(`${BACKGROUND_URL}?test=${unique++}`);
  return stub;
}

/** Sends a message through the worker's onMessage listener and awaits the response. */
function send(listener, msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no response within 1s')), 1000);
    listener(msg, {}, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

// --- Settings ---

test('GET_SETTINGS returns defaults when nothing is stored', async () => {
  const { listeners } = await loadWorker();
  const res = await send(listeners.message[0], { type: 'GET_SETTINGS' });
  assert.equal(res.settings.sound, true);
  assert.deepEqual(res.settings.enabledActions, ['alert', 'close', 'reload', 'mute', 'focus']);
  assert.deepEqual(res.settings.presets, [30, 60, 300, 600, 900, 1800]);
});

test('GET_SETTINGS repairs corrupt stored settings', async () => {
  const { listeners } = await loadWorker({
    store: { settings: { presets: 'nope', theme: 'neon', enabledActions: [] } },
  });
  const res = await send(listeners.message[0], { type: 'GET_SETTINGS' });
  assert.equal(res.settings.theme, 'system');
  assert.deepEqual(res.settings.enabledActions, ['alert']);
  assert.deepEqual(res.settings.presets, [30, 60, 300, 600, 900, 1800]);
});

// --- Starting timers ---

test('START_TIMER rejects unusable durations', async () => {
  const { listeners } = await loadWorker();
  const listener = listeners.message[0];
  for (const duration of [0, -1, 999, 'abc', undefined]) {
    const res = await send(listener, { type: 'START_TIMER', tabId: 1, duration });
    assert.equal(res.error, 'invalid timer request', `duration ${duration} was accepted`);
  }
});

test('START_TIMER rejects a missing tab id', async () => {
  const { listeners } = await loadWorker();
  const res = await send(listeners.message[0], { type: 'START_TIMER', duration: 60_000 });
  assert.equal(res.error, 'invalid timer request');
});

test('START_TIMER stores a timer and arms both an alarm and a backstop', async () => {
  const { listeners, state } = await loadWorker();
  const before = Date.now();
  const res = await send(listeners.message[0], {
    type: 'START_TIMER',
    tabId: 7,
    duration: 60_000,
    action: 'mute',
    label: 'hello',
  });

  assert.equal(res.success, true);
  const timer = state.store.timer_7;
  assert.equal(timer.tabId, 7);
  assert.equal(timer.action, 'mute');
  assert.equal(timer.label, 'hello');
  assert.equal(timer.paused, false);
  assert.ok(timer.endTime >= before + 60_000, 'endTime is in the future');
  assert.ok(state.alarms.has('timer_7'), 'a timer alarm was armed');
  assert.ok(state.alarms.has('badge_update'), 'the badge sweep alarm was armed');
});

test('a sub-30s timer still gets a backstop alarm', async () => {
  // The regression this guards: these used to be setTimeout only, so a suspended
  // worker dropped them entirely.
  const { listeners, state } = await loadWorker();
  const res = await send(listeners.message[0], {
    type: 'START_TIMER',
    tabId: 3,
    duration: 1000,
    action: 'alert',
  });
  assert.equal(res.success, true);
  assert.ok(state.alarms.has('timer_3'), 'backstop alarm armed for a 1s timer');
});

test('START_TIMER validates the action and truncates the label', async () => {
  const { listeners, state } = await loadWorker();
  await send(listeners.message[0], {
    type: 'START_TIMER',
    tabId: 4,
    duration: 60_000,
    action: 'explode',
    label: 'z'.repeat(200),
  });
  assert.equal(state.store.timer_4.action, 'alert');
  assert.equal(state.store.timer_4.label.length, 50);
});

test('START_TIMER_FOR_GROUP rejects a non-integer group id', async () => {
  const { listeners } = await loadWorker();
  const listener = listeners.message[0];
  for (const groupId of [undefined, '5', 1.5, -1]) {
    const res = await send(listener, { type: 'START_TIMER_FOR_GROUP', groupId, duration: 60_000 });
    assert.ok(res.error, `groupId ${groupId} was accepted`);
  }
});

// --- Import ---

test('IMPORT_DATA normalizes and reports what it dropped', async () => {
  const { listeners, state } = await loadWorker();
  const res = await send(listeners.message[0], {
    type: 'IMPORT_DATA',
    data: {
      settings: { theme: 'dark', snoozeMinutes: 999 },
      templates: [
        { name: 'Keep', duration: 60_000 },
        { name: '', duration: 60_000 },
      ],
      urlRules: [{ pattern: '^https://ok', duration: 60 }, { pattern: '(' }],
    },
  });

  assert.equal(res.success, true);
  assert.deepEqual(res.dropped, { templates: 1, urlRules: 1 });
  assert.equal(state.store.settings.theme, 'dark');
  assert.equal(state.store.settings.snoozeMinutes, 60, 'clamped');
  assert.equal(state.store.templates.length, 1);
  assert.equal(state.store.url_rules.length, 1);
});

test('IMPORT_DATA leaves omitted sections untouched', async () => {
  const { listeners, state } = await loadWorker({
    store: { templates: [{ name: 'Existing', duration: 60_000 }] },
  });
  const res = await send(listeners.message[0], { type: 'IMPORT_DATA', data: { settings: {} } });
  assert.equal(res.success, true);
  assert.equal(state.store.templates.length, 1, 'templates survived an import that omitted them');
});

test('IMPORT_DATA rejects a malformed payload', async () => {
  const { listeners } = await loadWorker();
  const listener = listeners.message[0];
  for (const data of [null, 'nope', 42, {}]) {
    const res = await send(listener, { type: 'IMPORT_DATA', data });
    assert.ok(res.error, `payload ${JSON.stringify(data)} was accepted`);
  }
});

// --- Error handling ---

test('an unknown message type gets an error response', async () => {
  const { listeners } = await loadWorker();
  const res = await send(listeners.message[0], { type: 'NOPE' });
  assert.equal(res.error, 'Unknown message type');
});

test('a malformed message gets an error response', async () => {
  const { listeners } = await loadWorker();
  const listener = listeners.message[0];
  assert.ok((await send(listener, {})).error);
  assert.ok((await send(listener, null)).error);
  assert.ok((await send(listener, { type: 42 })).error);
});

test('a rejected handler still responds instead of closing the port', async () => {
  // Without the .catch in the onMessage wrapper, sendResponse is never called
  // and the caller sees "message port closed" instead of an error.
  const { listeners } = await loadWorker({ throwOn: 'storage.get' });
  const res = await send(listeners.message[0], { type: 'GET_SETTINGS' });
  assert.match(res.error, /stub failure/);
});

// --- Lifecycle ---

test('startup equips badges and does not throw on an empty store', async () => {
  const { listeners, state } = await loadWorker();
  await listeners.startup[0]();
  assert.ok(state.alarms.has('badge_update') === false, 'no sweep alarm when nothing is pending');
});

test('startup drops a timer whose tab is gone', async () => {
  const { listeners, state } = await loadWorker({
    store: {
      timer_11: { tabId: 11, endTime: Date.now() + 60_000, action: 'alert', paused: false },
      history_log: [],
    },
    openTabs: [],
  });

  await listeners.startup[0]();

  assert.equal(state.store.timer_11, undefined, 'orphaned timer was cleared');
  assert.equal(state.store.history_log.length, 0, 'a cancelled timer is not a completion');
});

test('startup fires a timer whose deadline passed while the browser was closed', async () => {
  const { listeners, state } = await loadWorker({
    openTabs: [9],
    store: {
      // A timer that expired an hour ago and was never fired.
      timer_9: { tabId: 9, startTime: Date.now() - 7200_000, endTime: Date.now() - 3600_000, action: 'alert', label: '', paused: false },
      history_log: [],
    },
  });

  await listeners.startup[0]();

  assert.equal(state.store.timer_9, undefined, 'the expired timer was cleared');
  assert.equal(state.store.history_log.length, 1, 'completion was recorded');
  assert.equal(state.store.history_log[0].duration, 3600_000);
});

test('an alarm landing mid-sweep does not double-complete a timer', async () => {
  // The alarm, the setTimeout, and the 30s sweep can all arrive at the same
  // expired timer. The `firing` claim has to happen before the first await: if
  // the check and the set are separated by one, both paths read a live timer and
  // both complete it, producing two notifications, two chimes, and two history
  // entries.
  //
  // Storage latency is what opens that window in reality, so the stub adds some
  // and the alarm is fired from inside it rather than after a fixed sleep.
  const expires = Date.now() - 60_000;
  const { listeners, state } = await loadWorker({
    openTabs: [7],
    latencyMs: 30,
    store: {
      timer_7: {
        tabId: 7,
        startTime: expires - 60_000,
        endTime: expires,
        action: 'alert',
        label: '',
        paused: false,
      },
      history_log: [],
    },
  });

  const sweep = listeners.startup[0]();

  // The sweep now holds a snapshot that still contains the expired timer and is
  // on its way to completing it.
  const deadline = Date.now() + 2000;
  while (!state.reads.includes(null)) {
    if (Date.now() > deadline) {
      throw new Error('sweep never read the timer index');
    }
    await new Promise((r) => setTimeout(r, 1));
  }

  const viaAlarm = listeners.alarm[0]({ name: 'timer_7' });
  await Promise.all([sweep, viaAlarm]);

  // The notification count is the reliable signal. History length is not: a
  // double completion can still leave one entry, because the two writes race.
  assert.equal(state.notifications.length, 1, 'exactly one notification raised');
  assert.equal(state.notifications[0].title, 'Tab Timer');
  assert.equal(state.store.history_log.length, 1, 'exactly one completion recorded');
  assert.equal(state.store.timer_7, undefined, 'the timer was cleared');
});

test('a paused timer is left alone by the startup sweep', async () => {
  const { listeners, state } = await loadWorker({
    openTabs: [5],
    store: {
      timer_5: { tabId: 5, endTime: Date.now() - 1000, action: 'alert', paused: true, remaining: 30_000 },
    },
  });

  await listeners.startup[0]();

  assert.ok(state.store.timer_5, 'paused timer survived');
  assert.equal(state.store.timer_5.paused, true);
});
