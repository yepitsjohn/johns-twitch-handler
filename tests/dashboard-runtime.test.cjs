const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createApiClient, createPoller } = require('../src/StreamSidekick/wwwroot/dashboard-runtime.js');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('overlapping identical status reads share one request, without caching later reads', async () => {
  const gate = deferred(); let calls = 0;
  const client = createApiClient({ fetch: async () => { calls++; await gate.promise; return Response.json({ connected: true }); } });
  const first = client.request('/api/obs/status');
  const second = client.request('/api/obs/status');
  assert.equal(calls, 1);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [{ connected: true }, { connected: true }]);
  await client.request('/api/obs/status');
  assert.equal(calls, 2);
});
test('writes, different queries, custom headers, and caller cancellation are independent', async () => {
  let calls = 0;
  const client = createApiClient({ fetch: async () => { calls++; return Response.json({ ok: true }); } });
  await Promise.all([
    client.request('/api/markers', { method: 'POST', body: '{}' }),
    client.request('/api/markers', { method: 'POST', body: '{}' }),
    client.request('/api/status?a=1'), client.request('/api/status?a=2'),
    client.request('/api/status', { signal: new AbortController().signal }),
    client.request('/api/status', { headers: { 'X-Test': 'yes' } }),
  ]);
  assert.equal(calls, 6);
});
test('a failed read is removed so retry can succeed; server errors stay actionable', async () => {
  let fail = true;
  const client = createApiClient({ fetch: async () => fail
    ? Response.json({ error: 'Open OBS first.' }, { status: 400 }) : Response.json({ ok: true }) });
  await assert.rejects(client.request('/api/status'), /Open OBS first/);
  fail = false;
  assert.deepEqual(await client.request('/api/status'), { ok: true });
});
test('read timeout releases shared work and caller abort keeps its original cancellation', async () => {
  const controller = new AbortController();
  const aborted = new DOMException('caller cancelled', 'AbortError');
  const client = createApiClient({ timeoutSignal: () => controller.signal,
    fetch: (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(aborted))) });
  const first = client.request('/api/status');
  const second = client.request('/api/status');
  controller.abort();
  const result = await Promise.allSettled([first, second]);
  assert.ok(result.every(item => item.status === 'rejected' && item.reason.code === 'handler-timeout'));
  const caller = new AbortController();
  const separate = client.request('/api/status', { signal: caller.signal }); caller.abort();
  await assert.rejects(separate, error => error === aborted);
});
test('connection errors name the installed shortcut instead of a developer command file', async () => {
  const client = createApiClient({ fetch: async () => { throw new TypeError('network failed'); } });
  await assert.rejects(client.request('/api/status'), error => error.code === 'handler-unavailable'
    && /Desktop or Start Menu/.test(error.message) && !/\.cmd/.test(error.message));
});

function clock() {
  let next = 0;
  const timers = new Map();
  return { timers,
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fire() { const [id, timer] = timers.entries().next().value; timers.delete(id); return timer.callback(); }
  };
}
test('hidden-tab suspension removes all polling timers and resumes each job only once', async () => {
  const timer = clock(); let calls = 0;
  const poller = createPoller(timer);
  poller.add(async () => { calls++; }, 1000);
  poller.add(async () => { calls++; }, 5000);
  assert.equal(timer.timers.size, 2);
  poller.setPaused(true); assert.equal(timer.timers.size, 0);
  poller.setPaused(false); poller.setPaused(false);
  assert.equal(timer.timers.size, 2);
  assert.ok([...timer.timers.values()].every(item => item.delay === 0));
  await timer.fire(); await timer.fire();
  assert.equal(calls, 2);
  poller.stop(); assert.equal(timer.timers.size, 0);
});
test('suspending and resuming during a slow request never overlaps the running job', async () => {
  const timer = clock(); const gate = deferred(); let calls = 0;
  const poller = createPoller(timer);
  poller.add(async () => { calls++; await gate.promise; }, 1000);
  const running = timer.fire();
  poller.setPaused(true); poller.setPaused(false);
  assert.equal(calls, 1); assert.equal(timer.timers.size, 0);
  gate.resolve(); await running;
  assert.equal(timer.timers.size, 1);
  poller.stop();
});
test('inactive controls do no work; task errors do not stop later refreshes', async () => {
  const timer = clock(); let active = false, calls = 0, errors = 0;
  const poller = createPoller({ ...timer, onError: () => { errors++; } });
  const remove = poller.add(async () => { calls++; throw new Error('temporary'); }, 1000, () => active);
  await timer.fire(); assert.equal(calls, 0);
  active = true; await timer.fire();
  assert.equal(calls, 1); assert.equal(errors, 1); assert.equal(timer.timers.size, 1);
  remove(); assert.equal(timer.timers.size, 0);
});

const app = fs.readFileSync('src/StreamSidekick/wwwroot/app.js', 'utf8');
function startupFixture({ connected = true, sessionActive = false, failSetup = false, failOptional = false } = {}) {
  const values = new Map(); const elements = new Map(); const messages = [], polls = [], intervals = [];
  let opened = 0, setupFails = failSetup;
  const state = { channelName: '', raidDays: 31, youtubeVideoId: '', preflight: { obsConnected: connected, twitchConfigured: false }, sessionActive, setup: null };
  const context = vm.createContext({ state,
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    $: selector => { if (!elements.has(selector)) elements.set(selector, {}); return elements.get(selector); },
    loadSetupConfiguration: async () => { if (setupFails) throw new Error('Helper is unavailable'); state.setup = { wowToolsEnabled: false }; },
    showStartupMessage: (message, retry) => messages.push({ message, retry }),
    openSettings: () => { opened++; }, startPolling: (...args) => polls.push(args),
    window: { setInterval: (...args) => intervals.push(args) },
    document: { hidden: false, body: { dataset: {} } },
  });
  const helpers = ['loadManualPreflightItems','renderManualPreflightItems','loadPreflightVisibility','loadChat','renderCombinedChat',
    'refreshPreflight','refreshObs','refreshAudio','refreshReport','refreshStreamHistory','refreshPerformance','loadProfileAnalysis',
    'refreshOptimizerStatus','refreshAlerts','refreshChatChime','refreshTwitchChat','refreshSpotify','refreshTangia','refreshStreamElements','refreshTikFinity',
    'refreshAds','refreshChatCommands','refreshAutomations','refreshRaids','refreshViewerNotes','refreshWardogsStatus','renderAds','renderDuringStatusStrip'];
  helpers.forEach(name => { context[name] = async () => {}; });
  if (failOptional) context.refreshViewerNotes = async () => { throw new Error('notes unavailable'); };
  const code = app.slice(app.indexOf('function startDashboardPolling()'), app.indexOf('$("#retry-startup").addEventListener'));
  vm.runInContext('let startupInProgress = false; let dashboardPollingStarted = false;\n' + code, context);
  return { state, messages, polls, intervals, healthTask: context.refreshPerformance, audioTask: context.refreshAudio, opened: () => opened,
    retrySetup: () => { setupFails = false; }, boot: () => vm.runInContext('boot()', context) };
}
test('startup failure offers retry; retry starts monitoring once', async () => {
  const f = startupFixture({ failSetup: true });
  await f.boot(); assert.equal(f.polls.length, 0); assert.equal(f.messages.at(-1).retry, true);
  f.retrySetup(); await f.boot(); const count = f.polls.length;
  assert.ok(count > 10); assert.equal(f.intervals.length, 2);
  await f.boot(); assert.equal(f.polls.length, count); assert.equal(f.intervals.length, 2);
  assert.equal(f.messages.at(-1).message, null);
  assert.equal(f.polls.find(item => item[0] === f.healthTask)[2], undefined, 'health has no diagnostic panel gate');
  assert.equal(f.polls.find(item => item[0] === f.audioTask)[3], true, 'mixer reads require visible controls');
});
test('optional startup failure does not prevent monitoring', async () => {
  const f = startupFixture({ failOptional: true }); await f.boot();
  assert.ok(f.polls.length > 10); assert.equal(f.messages.at(-1).retry, true);
});
test('missing Twitch does not force setup when OBS is connected; active streams are uninterrupted', async () => {
  const connected = startupFixture(); await connected.boot(); assert.equal(connected.opened(), 0);
  const firstRun = startupFixture({ connected: false }); await firstRun.boot(); assert.equal(firstRun.opened(), 1);
  const live = startupFixture({ connected: false, sessionActive: true }); await live.boot(); assert.equal(live.opened(), 0);
});

test('active session prompts on close and releases its listener after each session', () => {
  const state = { sessionActive: false, sessionRevision: 0 };
  const warning = { hidden: true };
  const listeners = new Set();
  let registrations = 0;
  const context = vm.createContext({ state, $: () => warning, window: {
    addEventListener(type, handler) {
      assert.equal(type, 'beforeunload');
      registrations++;
      listeners.add(handler);
    },
    removeEventListener(type, handler) {
      assert.equal(type, 'beforeunload');
      assert.equal(listeners.delete(handler), true);
    }
  } });
  vm.runInContext(app.slice(app.indexOf('function warnBeforeClosingSession('), app.indexOf('function renderSession(')), context);
  assert.equal(listeners.size, 0);
  for (let cycle = 0; cycle < 100; cycle++) {
    context.setSessionActive(true);
    context.setSessionActive(true);
    assert.equal(listeners.size, 1);
    const event = { preventDefault() { this.defaultPrevented = true; } };
    [...listeners][0](event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(warning.hidden, false);
    context.setSessionActive(false);
    assert.equal(listeners.size, 0);
    assert.equal(warning.hidden, true);
  }
  assert.equal(registrations, 100);
});

test('failed health reads clear stale data and explain unavailability instead of showing healthy', async () => {
  const state = { system: { current: { cpuPercent: 2 } }, internet: { status: 'healthy' } };
  const elements = new Map();
  const context = vm.createContext({ state, api: async () => { throw new Error('Helper is unavailable'); },
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, { classList: { remove() {} } });
      return elements.get(selector);
    }, renderSimpleExperience() {} });
  vm.runInContext(app.slice(app.indexOf('async function refreshPerformance()'), app.indexOf('function renderInternetStatus(')), context);
  vm.runInContext(app.slice(app.indexOf('function setHeadroomSignal('), app.indexOf('function drawPerformanceChart(')), context);
  await vm.runInContext('refreshPerformance()', context);
  assert.equal(state.system, null); assert.equal(state.internet, null);
  vm.runInContext(app.slice(app.indexOf('function getSimpleHealthSummary()'), app.indexOf('function renderSimpleTools(')), context);
  const summary = vm.runInContext('getSimpleHealthSummary()', context);
  assert.equal(summary.state, 'Unavailable'); assert.equal(summary.level, 'warning');
  assert.equal(summary.detail, 'Helper is unavailable');
  assert.equal(elements.get('#headroom-value').textContent, '--');
  assert.equal(elements.get('#network-health').textContent, 'Unavailable');
  assert.equal(elements.get('#performance-warning').textContent, 'Helper is unavailable');
  vm.runInContext(app.slice(app.indexOf('function getSimpleDuringModel()'), app.indexOf('function getSimpleAfterModel()')), context);
  vm.runInContext(app.slice(app.indexOf('function renderDuringStatusStrip('), app.indexOf('async function runSimplePrimaryAction()')), context);
  vm.runInContext('renderDuringStatusStrip("during")', context);
  assert.equal(elements.get('#live-status-title').textContent, 'HEALTH UNAVAILABLE');
  assert.equal(elements.get('#live-status-detail').textContent, 'Helper is unavailable');
  assert.equal(elements.get('#live-status-fix').textContent, 'Review connection');
});
test('hidden diagnostics still receive fresh health data without repainting charts', async () => {
  const state = {};
  const snapshot = { current: { cpuPercent: 2 }, history: [], resourceDrains: [] };
  const internet = { status: 'healthy' }; let diagnosed = 0, charts = 0;
  const context = vm.createContext({ state,
    api: async path => path === '/api/system/status' ? snapshot : internet,
    document: { querySelector: () => ({ getClientRects: () => [] }) },
    evaluateHeadroom: () => { diagnosed++; }, drawPerformanceChart: () => { charts++; },
    $: () => ({}), renderSimpleExperience() {} });
  vm.runInContext(app.slice(app.indexOf('async function refreshPerformance()'), app.indexOf('function renderInternetStatus(')), context);
  await vm.runInContext('refreshPerformance()', context);
  assert.equal(state.system, snapshot); assert.equal(state.internet, internet);
  assert.equal(diagnosed, 1); assert.equal(charts, 0);
});
