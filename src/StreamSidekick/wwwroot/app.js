// Lightweight DOM helpers keep the dashboard dependency-free and easy to run locally.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// This object is the browser's latest view of server state. Secrets never belong here or in localStorage.
const state = {
  obs: { connected: false, scenes: [], currentScene: null },
  audio: { connected: false, inputs: [] },
  audioInteracting: false,
  setup: null,
  preflight: null,
  report: null,
  optimizer: null,
  optimizerBusy: false,
  autoEndingSession: false,
  sessionActive: false,
  wardogs: null,
  channelName: localStorage.getItem("streamsidekick.channel") || "",
  wow: null,
  wowPresets: [],
  wowEvents: null,
  system: null,
  internet: null,
  spotify: null,
  spotifyEnabled: true,
  musicOverlayVisible: null,
  musicOverlayBusy: false,
  spotifyResults: [],
  tangia: null,
  tangiaEnabled: true,
  streamElements: null,
  streamElementsEnabled: true,
  streamElementsConfirmed: false,
  tikFinity: null,
  tikFinityEnabled: false,
  manualPreflightItems: [],
  ads: null,
  adOptionsSaving: false,
  chatChime: null,
  twitchChatFeed: null,
  twitchChatBusy: false,
  chatCommands: [],
  automations: [],
  raids: { channels: [], history: [], warning: null },
  raidDays: Number(localStorage.getItem("streamsidekick.raidDays")) || 31,
  youtubeVideoId: localStorage.getItem("streamsidekick.youtubeVideoId") || "",
  viewerNotes: [],
  demo: {
    active: false,
    phase: "before",
    status: "intro",
    incident: null,
    runId: 0,
    gpu: 68,
    renderMissed: 0.03,
    latency: 32,
    timeline: []
  },
  gameProfile: localStorage.getItem("streamsidekick.gameProfile") === "fps" ? "fps" : "rpg",
  wowEditionId: localStorage.getItem("streamsidekick.wowEdition") || "classic",
  wowProfileId: localStorage.getItem("streamsidekick.wowProfile") || ""
};

const gameProfileDefinitions = {
  fps: {
    name: "FPS profile",
    summary: "Kill, death, loadout, and match-focused tools",
    markerPlaceholder: "What happened in the match?"
  },
  rpg: {
    name: "RPG profile",
    summary: "Character, encounter, and progression tools",
    markerPlaceholder: "What happened in the adventure?"
  }
};

function applyGameProfile(profile, options = {}) {
  const selected = Object.hasOwn(gameProfileDefinitions, profile) ? profile : "rpg";
  const definition = gameProfileDefinitions[selected];
  state.gameProfile = selected;
  document.body.dataset.gameProfile = selected;
  $$('[data-game-profile]').forEach(button => {
    const active = button.dataset.gameProfile === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#game-profile-name").textContent = definition.name;
  $("#game-profile-summary").textContent = definition.summary;
  $("#marker-title").placeholder = definition.markerPlaceholder;
  $$('[data-game-profile-only]').forEach(element => {
    element.hidden = element.dataset.gameProfileOnly !== selected;
  });
  $$('[data-game-profiles]').forEach(panel => {
    const profiles = panel.dataset.gameProfiles.split(/\s+/);
    panel.classList.toggle("game-profile-hidden", !profiles.includes(selected));
  });
  renderFpsMarkerSummary();
  if (options.persist !== false) localStorage.setItem("streamsidekick.gameProfile", selected);
  if (options.refreshLayout !== false && document.body.dataset.workspacePage) {
    setActiveWorkspace(document.body.dataset.workspacePage, { persist: false });
  }
  if (options.announce) toast(`${definition.name} selected.`);
}

function initializeGameProfile() {
  applyGameProfile(state.gameProfile, { persist: false, refreshLayout: false });
  $$('[data-game-profile]').forEach(button => button.addEventListener("click", () => {
    applyGameProfile(button.dataset.gameProfile, { announce: true });
  }));
}

const dashboardRequests = HandlerDashboardRuntime.createApiClient({
  fetch: (path, options) => (window.HandlerConnection?.fetch || fetch)(path, options)
});
function api(path, options = {}) { return dashboardRequests.request(path, options); }

// --- Shared UI feedback and preflight ---------------------------------------------------------

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 3600);
}

function setCheck(id, ok, detail, actionLabel, mode = ok ? "ok" : "warn") {
  const row = $(id);
  row.classList.toggle("ok", mode === "ok");
  row.classList.toggle("warn", mode === "warn");
  row.classList.toggle("skipped", mode === "skipped");
  row.querySelector(".check-icon").textContent = mode === "skipped" ? "−" : ok ? "✓" : "!";
  if (detail) row.querySelector("small").textContent = detail;
  const button = row.querySelector("button");
  if (button && actionLabel) button.textContent = actionLabel;
}

function savedPreference(key, fallback) {
  const value = localStorage.getItem(key);
  return value == null ? fallback : value === "true";
}

const manualPreflightStorageKey = "johns-handler.manual-preflight";
const preflightVisibilityStorageKey = "johns-handler.preflight-hidden";
let hiddenPreflightRows = new Set();

function loadManualPreflightItems() {
  const saved = localStorage.getItem(manualPreflightStorageKey);
  if (saved == null) {
    state.manualPreflightItems = [{ id: "get-coffee", label: "Get Coffee", checked: false }];
    saveManualPreflightItems();
    return;
  }
  try {
    const items = JSON.parse(saved);
    state.manualPreflightItems = Array.isArray(items)
      ? items.filter(item => item && typeof item.id === "string" && typeof item.label === "string").slice(0, 12).map(item => ({
          id: item.id,
          label: item.label.trim().slice(0, 60),
          checked: item.checked === true
        })).filter(item => item.label)
      : [];
  } catch {
    state.manualPreflightItems = [{ id: "get-coffee", label: "Get Coffee", checked: false }];
    saveManualPreflightItems();
  }
}

function saveManualPreflightItems() {
  // These reminders are intentionally browser-local because they have no OBS or account wiring.
  localStorage.setItem(manualPreflightStorageKey, JSON.stringify(state.manualPreflightItems));
}

function renderManualPreflightItems() {
  const list = $("#manual-preflight-items");
  if (!list) return;
  list.innerHTML = state.manualPreflightItems.map(item => `<label class="check-row manual ${item.checked ? "ok" : "warn"}" data-manual-preflight-id="${escapeHtml(item.id)}">
    <input class="manual-preflight-checkbox" type="checkbox" ${item.checked ? "checked" : ""} aria-label="${escapeHtml(item.label)} complete">
    <div><strong>${escapeHtml(item.label)}</strong><small>Manual reminder</small></div>
    <button class="manual-preflight-remove" type="button" aria-label="Remove ${escapeHtml(item.label)}" title="Remove reminder">×</button>
  </label>`).join("");
  updateDashboardBorder();
  renderSimpleManualReminders();
}

function addManualPreflightItem() {
  const input = $("#manual-preflight-name");
  const label = input.value.trim();
  if (!label) { toast("Enter a preflight reminder first.", true); return; }
  if (state.manualPreflightItems.length >= 12) { toast("Preflight supports up to 12 manual reminders.", true); return; }
  if (state.manualPreflightItems.some(item => item.label.toLowerCase() === label.toLowerCase())) {
    toast("That reminder is already in Preflight.", true);
    return;
  }
  state.manualPreflightItems.push({ id: crypto.randomUUID?.() || `manual-${Date.now()}`, label: label.slice(0, 60), checked: false });
  input.value = "";
  saveManualPreflightItems();
  renderManualPreflightItems();
  toast(`Added “${label.slice(0, 60)}” to Preflight.`);
}

function loadPreflightVisibility() {
  try {
    const saved = JSON.parse(localStorage.getItem(preflightVisibilityStorageKey) || "[]");
    hiddenPreflightRows = new Set(Array.isArray(saved) ? saved.filter(id => typeof id === "string") : []);
  } catch {
    hiddenPreflightRows = new Set();
  }
  applyPreflightVisibility();
}

function builtInPreflightRows() {
  return $$("#preflight-check-list > .check-row[id]");
}

function applyPreflightVisibility() {
  builtInPreflightRows().forEach(row => { row.hidden = hiddenPreflightRows.has(row.id); });
}

function renderPreflightVisibilityList() {
  const list = $("#preflight-visibility-list");
  list.innerHTML = builtInPreflightRows().map(row => {
    const label = row.querySelector("strong")?.textContent?.trim() || row.id;
    return `<label><input type="checkbox" data-preflight-visible="${escapeHtml(row.id)}" ${hiddenPreflightRows.has(row.id) ? "" : "checked"}> <span>${escapeHtml(label)}</span></label>`;
  }).join("");
}

function savePreflightVisibility() {
  localStorage.setItem(preflightVisibilityStorageKey, JSON.stringify([...hiddenPreflightRows]));
  applyPreflightVisibility();
}

function applyOptionalIntegrationState() {
  const spotifyPanel = document.querySelector('[data-panel-id="spotify"]');
  const tangiaPanel = document.querySelector('[data-panel-id="tangia"]');
  const streamElementsPanel = document.querySelector('[data-panel-id="streamelements"]');
  const tikFinityPanel = document.querySelector('[data-panel-id="tikfinity"]');
  if (spotifyPanel) spotifyPanel.hidden = !state.spotifyEnabled;
  if (tangiaPanel) tangiaPanel.hidden = !state.tangiaEnabled;
  if (streamElementsPanel) streamElementsPanel.hidden = !state.streamElementsEnabled;
  if (tikFinityPanel) tikFinityPanel.hidden = !state.tikFinityEnabled;
  $("#spotify-settings").hidden = !state.spotifyEnabled;
  const choices = {
    spotify: state.spotifyEnabled,
    tangia: state.tangiaEnabled,
    streamelements: state.streamElementsEnabled,
    tikfinity: state.tikFinityEnabled
  };
  $$('[data-integration-choice]').forEach(button => {
    const selected = choices[button.dataset.integrationChoice] === (button.dataset.enabled === "true");
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

async function loadSetupConfiguration() {
  state.setup = await api("/api/setup");
  const releasePill = $("#release-channel-pill");
  const releaseLabel = state.setup.releaseLabel || "Owner build";
  const releaseVersion = state.setup.releaseVersion || "development";
  releasePill.textContent = `Version ${releaseVersion} · ${releaseLabel}`;
  releasePill.title = `${releaseLabel} · ${releaseVersion}`;
  releasePill.classList.toggle("tester", state.setup.releaseChannel?.toLowerCase() === "tester");
  document.title = state.setup.releaseChannel?.toLowerCase() === "tester"
    ? `John's Twitch Handler · ${releaseLabel} ${releaseVersion}`
    : `John's Twitch Handler · ${releaseVersion}`;
  state.spotifyEnabled = savedPreference("streamsidekick.spotifyEnabled", state.setup.spotifyEnabledByDefault !== false);
  state.tangiaEnabled = savedPreference("streamsidekick.tangiaEnabled", state.setup.tangiaEnabledByDefault !== false);
  state.streamElementsEnabled = savedPreference("streamsidekick.streamElementsEnabled", state.setup.streamElementsEnabledByDefault !== false);
  state.streamElementsConfirmed = savedPreference("streamsidekick.streamElementsConfirmed", false);
  state.tikFinityEnabled = savedPreference("streamsidekick.tikFinityEnabled", state.setup.tikFinityEnabledByDefault === true);
  const wowToolsEnabled = state.setup.wowToolsEnabled === true;
  document.querySelector('[data-panel-id="wow-addons"]').hidden = !wowToolsEnabled;
  document.querySelector('[data-panel-id="wow-events"]').hidden = !wowToolsEnabled;
  applyOptionalIntegrationState();
  // Tell the local service about this browser's preference. A default No means no socket is opened.
  state.tikFinity = await api("/api/tikfinity/enabled", {
    method: "PUT",
    body: JSON.stringify({ enabled: state.tikFinityEnabled })
  });
  renderCombinedChat();
  renderTikFinity();
}

async function setOptionalIntegration(name, enabled) {
  const integrations = {
    spotify: { key: "spotifyEnabled", label: "Spotify", refresh: refreshSpotify },
    tangia: { key: "tangiaEnabled", label: "Tangia", refresh: refreshTangia },
    streamelements: { key: "streamElementsEnabled", label: "StreamElements", refresh: refreshStreamElements },
    tikfinity: { key: "tikFinityEnabled", label: "TikFinity", refresh: refreshTikFinity }
  };
  const integration = integrations[name];
  if (!integration) return;
  const { key, label, refresh } = integration;
  if (state[key] === enabled) return;
  state[key] = enabled;
  localStorage.setItem(`streamsidekick.${key}`, String(state[key]));
  applyOptionalIntegrationState();
  if (name === "tikfinity") {
    state.tikFinity = await api("/api/tikfinity/enabled", {
      method: "PUT",
      body: JSON.stringify({ enabled: state.tikFinityEnabled })
    });
    renderCombinedChat();
    renderTikFinity();
  }
  await refreshPreflight();
  if (state[key]) await refresh();
  toast(`${label} ${state[key] ? "enabled" : "skipped"} on this computer.`);
}

function getReadinessAssessment() {
  const preflight = state.preflight;
  const spotifyReady = !state.spotifyEnabled || Boolean(state.spotify?.connected && state.spotify?.playback);
  const musicOverlayReady = !state.spotifyEnabled || Boolean(preflight?.musicOverlayConfigured);
  const tangiaReady = !state.tangiaEnabled || Boolean(preflight?.tangiaConfigured);
  const streamElementsReady = !state.streamElementsEnabled || Boolean(preflight?.streamElementsReady);
  const tikFinityReady = !state.tikFinityEnabled || Boolean(preflight?.tikFinityReady);
  const manualItemsReady = state.manualPreflightItems.every(item => item.checked);
  const internetReady = Boolean(state.internet?.online)
    && !["offline", "slow", "unstable"].includes(state.internet?.status);
  // An intentionally disabled integration is ready by definition. This preserves the full feature
  // set for John while keeping a tester's border honest about only the tools they chose to use.
  const ready = Boolean(
    preflight?.obsConnected
    && preflight?.microphoneReady
    && preflight?.nvidiaBroadcast?.running
    && preflight?.twitchRewardsReady
    && internetReady
    && spotifyReady
    && musicOverlayReady
    && tangiaReady
    && streamElementsReady
    && tikFinityReady
    && manualItemsReady
  );

  return {
    ready,
    internetReady,
    spotifyReady,
    musicOverlayReady,
    tangiaReady,
    streamElementsReady,
    tikFinityReady,
    manualItemsReady
  };
}

function updateDashboardBorder() {
  const live = Boolean(state.obs?.streamActive);
  const readiness = getReadinessAssessment();

  const border = $("#status-border");
  border.className = `status-border ${live ? "live" : readiness.ready ? "ready" : "warning"}`;
}

async function refreshPreflight() {
  try {
    const wasTracking = state.sessionActive;
    state.preflight = await api(`/api/preflight?spotifyEnabled=${state.spotifyEnabled}&tangiaEnabled=${state.tangiaEnabled}&streamElementsEnabled=${state.streamElementsEnabled}&streamElementsConfirmed=${state.streamElementsConfirmed}&tikFinityEnabled=${state.tikFinityEnabled}`);
    state.sessionActive = state.preflight.sessionActive;
    if (!state.musicOverlayBusy && typeof state.preflight.musicOverlayVisible === "boolean") {
      state.musicOverlayVisible = state.preflight.musicOverlayVisible;
      renderMusicOverlayVisibility();
    }
    setCheck("#check-obs", state.preflight.obsConnected, state.preflight.obsConnected ? "Connected and ready" : "Connection required", state.preflight.obsConnected ? "Ready" : "Connect");
    const microphone = state.preflight.microphone || {};
    const microphoneReady = Boolean(state.preflight.microphoneReady);
    $("#console-microphone").textContent = !microphone.connected
      ? "OBS not connected"
      : !microphone.found
        ? "Not found"
        : microphone.muted ? "Muted" : "Ready";
    setCheck(
      "#check-microphone",
      microphoneReady,
      microphone.status || "Checking the OBS microphone mute state",
      microphoneReady ? "Ready" : !microphone.connected ? "Connect" : microphone.found ? "Unmute" : "Mixer");
    const nvidia = state.preflight.nvidiaBroadcast;
    setCheck("#check-nvidia", nvidia.running, nvidia.running ? "Running. Voice and camera effects are ready." : nvidia.installed ? "Installed, but not running" : "NVIDIA Broadcast not found", nvidia.running ? "Running" : "Open");
    const twitchReady = Boolean(state.preflight.twitchRewardsReady);
    const twitchDetail = twitchReady
      ? "Alerts, Channel Points, and feedback are connected"
      : state.preflight.twitchConfigured
        ? state.preflight.twitchStatus || "Configured, but Twitch events are disconnected"
        : "Connect Twitch for alerts and viewer song requests";
    setCheck("#check-twitch", twitchReady, twitchDetail, twitchReady ? "Ready" : "Set up");
    if (!state.spotifyEnabled) renderSpotifyPreflight(null);
    setCheck(
      "#check-music-overlay",
      !state.spotifyEnabled || Boolean(state.preflight.musicOverlayConfigured),
      !state.spotifyEnabled ? "Skipped on this computer" : state.preflight.musicOverlayStatus || "Add the music overlay to OBS as a Browser Source",
      !state.spotifyEnabled ? "Skipped" : state.preflight.musicOverlayConfigured ? "Ready" : "Copy URL",
      !state.spotifyEnabled ? "skipped" : undefined);
    setCheck(
      "#check-tangia",
      !state.tangiaEnabled || Boolean(state.preflight.tangiaConfigured),
      !state.tangiaEnabled ? "Skipped on this computer" : state.preflight.tangiaStatus || "Add Tangia to OBS as a Browser Source",
      !state.tangiaEnabled ? "Skipped" : state.preflight.tangiaConfigured ? "Ready" : "Open",
      !state.tangiaEnabled ? "skipped" : undefined);
    const streamElements = state.preflight.streamElements || {};
    setCheck(
      "#check-streamelements",
      !state.streamElementsEnabled || Boolean(state.preflight.streamElementsReady),
      !state.streamElementsEnabled
        ? "Skipped on this computer"
        : streamElements.installed && !state.streamElementsConfirmed
          ? "SE.Live detected. Confirm the selected outputs are connected in OBS."
          : streamElements.status || "Install SE.Live to configure multistream outputs",
      !state.streamElementsEnabled ? "Skipped" : state.preflight.streamElementsReady ? "Ready" : streamElements.installed ? "Confirm" : "Install",
      !state.streamElementsEnabled ? "skipped" : undefined);
    const tikFinity = state.preflight.tikFinity || {};
    setCheck(
      "#check-tikfinity",
      !state.tikFinityEnabled || Boolean(state.preflight.tikFinityReady),
      !state.tikFinityEnabled ? "Skipped on this computer" : tikFinity.status || "Open TikFinity to receive TikTok chat",
      !state.tikFinityEnabled ? "Skipped" : state.preflight.tikFinityReady ? "Ready" : "Open app",
      !state.tikFinityEnabled ? "skipped" : undefined);
    updateDashboardBorder();
    renderSession();
    renderChatCommands();
    if (wasTracking && !state.sessionActive) {
      await Promise.all([refreshReport(true), refreshStreamHistory()]);
      toast("OBS ended the stream. Your session was saved automatically.");
      window.setTimeout(revealPostStreamReport, 100);
    }
  } catch (error) {
    state.preflight = null;
    updateDashboardBorder();
    renderSimpleExperience();
    toast(error.message, true);
  }
}

async function refreshObs() {
  try {
    const snapshot = await api("/api/obs/status");
    state.obs = snapshot;
    renderObs();
  } catch (error) {
    state.obs = { connected: false, scenes: [], currentScene: null, error: error.message };
    renderObs();
  }
}

// --- OBS scenes and audio --------------------------------------------------------------------

function renderObs() {
  const pill = $("#obs-pill");
  pill.className = `pill ${state.obs.connected ? "online" : "offline"}`;
  pill.innerHTML = `<i></i> OBS ${state.obs.connected ? "connected" : "offline"}`;
  const live = state.obs.streamActive;
  // A page-level border makes live/readiness state visible even when Preflight is off-screen.
  updateDashboardBorder();
  $("#live-state").textContent = live ? "● LIVE" : state.obs.connected ? "Connected" : "Not connected";
  $("#live-state").style.color = live ? "var(--red)" : "";
  $("#save-replay-only").disabled = !state.obs.connected;
  $("#console-scene").textContent = state.obs.connected
    ? state.obs.currentScene || "No active scene"
    : "OBS not connected";
  $("#console-output").textContent = live
    ? "Live"
    : state.obs.recordingActive
      ? "Recording"
      : state.obs.connected ? "Standby" : "Offline";
  const consoleReplay = document.querySelector('[data-console-action="replay"]');
  if (consoleReplay) consoleReplay.disabled = !state.obs.connected;
  $("#obs-health").textContent = state.obs.connected
    ? `OBS ${Number(state.obs.activeFps || 0).toFixed(1)} FPS · render missed ${Number(state.obs.renderSkippedPercent || 0).toFixed(2)}% · encoder skipped ${Number(state.obs.outputSkippedPercent || 0).toFixed(2)}%`
    : "Connect OBS to include render and encoder health.";
  evaluateHeadroom();

  const grid = $("#scene-grid");
  if (!state.obs.connected || !state.obs.scenes?.length) {
    grid.className = "scene-grid empty-state";
    grid.textContent = state.obs.error || "Connect OBS to load scenes.";
    return;
  }

  grid.className = "scene-grid";
  grid.innerHTML = state.obs.scenes.map((scene, index) =>
    `<button class="scene-button ${scene === state.obs.currentScene ? "active" : ""}" data-scene="${escapeHtml(scene)}" title="${escapeHtml(scene)}">${index < 9 ? `<span>${index + 1}</span> ` : ""}${escapeHtml(scene)}</button>`
  ).join("");
  $$("[data-scene]").forEach(button => button.addEventListener("click", () => switchScene(button.dataset.scene)));
}

async function refreshAudio(force = false) {
  if (state.audioInteracting && !force) return;
  try {
    state.audio = await api("/api/obs/audio");
  } catch (error) {
    state.audio = { connected: false, inputs: [], error: error.message };
  }
  renderAudioMixer();
}

function formatAudioDb(value) {
  return Number(value) <= -59.5 ? "−∞ dB" : `${Number(value).toFixed(1)} dB`;
}

function renderAudioMixer() {
  const mixer = $("#audio-mixer");
  const inputs = state.audio.inputs || [];
  $("#audio-state").textContent = state.audio.connected ? `${inputs.length} source${inputs.length === 1 ? "" : "s"}` : "Not connected";
  const microphone = state.preflight?.microphone;
  $("#console-microphone").textContent = !state.audio.connected
    ? "OBS not connected"
    : microphone?.found === false
      ? "Not found"
      : microphone?.muted ? "Muted" : microphone?.found ? "Ready" : "Check mixer";
  if (!state.audio.connected || !inputs.length) {
    mixer.className = "audio-mixer empty-state";
    mixer.dataset.structure = "";
    mixer.textContent = state.audio.error || (state.audio.connected ? "No OBS audio sources found." : "Connect OBS to control its audio sources.");
    return;
  }

  mixer.className = "audio-mixer";
  const structure = JSON.stringify(inputs.map(input => input.inputName));
  if (mixer.dataset.structure !== structure) {
    // OBS meters update every second. Build controls only when sources are added, removed, or reordered;
    // replacing dozens of live range inputs every tick caused unnecessary layout and garbage collection.
    mixer.innerHTML = inputs.map(input => {
      const source = escapeHtml(input.inputName);
      return `<div class="audio-source" data-audio-source="${source}">
      <div class="audio-source-top"><strong title="${source}">${source}</strong><button class="mute-button" data-audio-mute="${source}"></button></div>
      <div class="audio-control-line">
        <span class="audio-meter" aria-hidden="true"><i></i></span>
        <input type="range" min="-60" max="6" step="0.5" data-audio-volume="${source}" aria-label="${source} volume">
        <output></output>
      </div>
    </div>`;
    }).join("");
    mixer.dataset.structure = structure;
  }

  const rows = new Map($$("#audio-mixer .audio-source").map(row => [row.dataset.audioSource, row]));
  inputs.forEach(input => {
    const row = rows.get(input.inputName);
    if (!row) return;
    const volume = Math.max(-60, Math.min(6, Number(input.volumeDb)));
    const fader = ((volume + 60) / 66 * 100).toFixed(1);
    const meter = Math.max(0, Math.min(100, Number(input.meterPercent) || 0));
    const button = row.querySelector("[data-audio-mute]");
    const slider = row.querySelector("[data-audio-volume]");
    row.querySelector(".audio-meter i").style.width = `${meter}%`;
    button.disabled = false;
    button.classList.toggle("muted", input.muted);
    button.dataset.muted = String(input.muted);
    button.textContent = input.muted ? "Unmute" : "Mute";
    button.setAttribute("aria-label", `${input.muted ? "Unmute" : "Mute"} ${input.inputName}`);
    slider.value = String(volume);
    slider.style.setProperty("--fader", `${fader}%`);
    slider.nextElementSibling.textContent = formatAudioDb(volume);
  });
}

// --- Tangia OBS Browser Source ---------------------------------------------------------------

async function refreshTangia() {
  if (!state.tangiaEnabled) {
    state.tangia = { connected: false, found: false, status: "Tangia is disabled on this computer." };
    return;
  }
  try {
    state.tangia = await api("/api/tangia");
  } catch (error) {
    state.tangia = { connected: false, found: false, status: error.message };
  }
  renderTangia();
}

function renderTangia() {
  const tangia = state.tangia || {};
  const ready = Boolean(tangia.connected && tangia.found);
  $("#tangia-state").textContent = ready ? tangia.bossFocusActive ? "Boss Focus" : "Ready" : "Setup needed";
  $("#tangia-summary").textContent = tangia.status || "Add Tangia to OBS as a Browser Source.";
  ["#tangia-visibility", "#tangia-mute", "#tangia-reload", "#tangia-boss-focus", "#tangia-volume"]
    .forEach(selector => { $(selector).disabled = !ready; });
  if (!ready) return;
  $("#tangia-visibility").textContent = tangia.visible === false ? "Show source" : "Hide source";
  $("#tangia-visibility").disabled = tangia.visible == null;
  $("#tangia-mute").textContent = tangia.muted ? "Unmute" : "Mute";
  $("#tangia-boss-focus").textContent = tangia.bossFocusActive ? "End Boss Focus" : "Boss Focus";
  $("#tangia-volume").value = Number(tangia.volumeDb || 0);
  $("#tangia-volume-value").textContent = formatAudioDb(tangia.volumeDb || 0);
}

async function updateTangia(path, body = null, successMessage = null) {
  try {
    state.tangia = await api(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
    renderTangia();
    await refreshPreflight();
    if (successMessage) toast(successMessage);
  } catch (error) { toast(error.message, true); }
}

// --- StreamElements and multistream planning ------------------------------------------------

const multistreamDestinationsKey = "streamsidekick.multistreamDestinations";
const multistreamBitrateKey = "streamsidekick.multistreamBitrate";

function readMultistreamDestinations() {
  const fallback = { twitch: true, youtube: false, tiktok: false };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(multistreamDestinationsKey) || "{}") };
  } catch {
    return fallback;
  }
}

function renderMultistreamPlan() {
  const destinations = readMultistreamDestinations();
  $$('[data-multistream-destination]').forEach(input => {
    input.checked = Boolean(destinations[input.dataset.multistreamDestination]);
  });

  const savedBitrate = Number(localStorage.getItem(multistreamBitrateKey));
  const bitrate = [2500, 3500, 4500, 6000].includes(savedBitrate) ? savedBitrate : 3500;
  $("#multistream-bitrate").value = String(bitrate);
  const outputCount = Object.values(destinations).filter(Boolean).length;
  const combinedMbps = outputCount * bitrate / 1000;
  $("#multistream-output-count").textContent = String(outputCount);
  $("#multistream-combined-bitrate").textContent = `${combinedMbps.toFixed(1)} Mbps`;
  $("#multistream-upload-target").textContent = outputCount
    ? `${(combinedMbps * 1.5).toFixed(1)} to ${(combinedMbps * 2).toFixed(1)} Mbps`
    : "No outputs selected";
}

async function refreshStreamElements() {
  if (!state.streamElementsEnabled) {
    state.streamElements = { installed: false, status: "StreamElements is disabled on this computer." };
    renderStreamElements();
    return;
  }
  try {
    state.streamElements = await api("/api/streamelements/status");
  } catch (error) {
    state.streamElements = { installed: false, status: error.message };
  }
  renderStreamElements();
}

function renderStreamElements() {
  const streamElements = state.streamElements || {};
  $("#streamelements-state").textContent = streamElements.installed
    ? state.streamElementsConfirmed ? "Ready" : streamElements.obsRunning ? "Confirm outputs" : "OBS closed"
    : "Setup needed";
  $("#streamelements-summary").textContent = streamElements.status || "Install SE.Live to add and manage streaming destinations inside OBS.";
  $("#streamelements-confirmed").checked = state.streamElementsConfirmed;
  $("#streamelements-confirmed").disabled = !streamElements.installed;
  renderMultistreamPlan();
}

// TikFinity owns the TikTok connection. This refresh reads only the Handler's local in-memory copy
// and makes no TikTok request of its own.
async function refreshTikFinity() {
  if (!state.tikFinityEnabled) {
    state.tikFinity = { enabled: false, connected: false, status: "Optional integration is turned off.", messages: [] };
    renderTikFinity();
    return;
  }
  try {
    state.tikFinity = await api("/api/tikfinity/status");
  } catch (error) {
    state.tikFinity = { enabled: true, connected: false, status: error.message, messages: [] };
  }
  renderTikFinity();
}

function renderTikFinity() {
  const snapshot = state.tikFinity || {};
  const stateLabel = $("#tikfinity-state");
  const summary = $("#tikfinity-summary");
  if (stateLabel) stateLabel.textContent = !state.tikFinityEnabled ? "Turned off" : snapshot.connected ? "Connected" : "Waiting";
  if (summary) summary.textContent = snapshot.status || "Waiting for TikFinity's local chat feed.";

  const messages = Array.isArray(snapshot.messages) ? snapshot.messages.slice(-50) : [];
  const html = messages.length
    ? messages.map(message => `<div class="tikfinity-message"><strong>${escapeHtml(message.displayName || message.userName || "TikTok viewer")}</strong><span>${escapeHtml(message.text || "")}</span><time>${escapeHtml(formatAlertTime(message.at))}</time></div>`).join("")
    : "No TikTok messages received.";
  [$("#tikfinity-card-list"), $("#tikfinity-chat-list")].filter(Boolean).forEach(list => {
    list.className = `tikfinity-chat-list${messages.length ? "" : " empty-state"}`;
    list.innerHTML = html;
    if (messages.length) list.scrollTop = list.scrollHeight;
  });
}

// --- Twitch ad timing ------------------------------------------------------------------------

async function refreshAds() {
  const previous = state.ads;
  try {
    const ads = await api("/api/ads/status");
    if (state.ads !== previous) return;
    state.ads = ads;
    renderAds();
  } catch (error) {
    if (state.ads !== previous) return;
    $("#ads-state").textContent = "Unavailable";
    $("#ad-message").textContent = error.message;
  }
}

function renderAds() {
  const ads = state.ads;
  const announceInChat = $("#ad-announce-in-chat");
  announceInChat.disabled = state.adOptionsSaving || typeof ads?.announceInChat !== "boolean";
  $("#edit-ad-messages").disabled = state.adOptionsSaving || typeof ads?.startMessage !== "string";
  if (!state.adOptionsSaving) announceInChat.checked = ads?.announceInChat === true;
  const countdown = $("#ad-countdown");
  const remaining = ads?.active && ads.endsAt
    ? Math.max(0, Math.ceil((new Date(ads.endsAt).valueOf() - Date.now()) / 1000))
    : 0;
  const active = remaining > 0;
  countdown.classList.toggle("active", active);
  countdown.querySelector("strong").textContent = formatOffset(remaining);
  countdown.querySelector("span").textContent = active
    ? `${ads.source} · ${ads.durationSeconds} seconds total`
    : ads?.status || "No ad break is running.";
  $("#ads-state").textContent = active ? "Running" : "Idle";
}

async function saveAdOptions(announceInChat) {
  state.adOptionsSaving = true;
  renderAds();
  try {
    state.ads = await api("/api/ads/options", {
      method: "PUT",
      body: JSON.stringify({ announceInChat })
    });
    $("#ad-message").textContent = announceInChat
      ? "Ad break start and end messages are enabled."
      : "Ad break announcements are off.";
  } catch (error) {
    $("#ad-message").textContent = error.message;
    toast(error.message, true);
  } finally {
    state.adOptionsSaving = false;
    renderAds();
  }
}

function editAdMessages() {
  $("#ad-start-message").value = state.ads.startMessage;
  $("#ad-end-message").value = state.ads.endMessage;
  $("#ad-messages-error").textContent = "";
  $("#ad-messages-dialog").showModal();
}

async function saveAdMessages(event) {
  event.preventDefault();
  if (state.adOptionsSaving) return;
  const start = $("#ad-start-message");
  const end = $("#ad-end-message");
  const errorMessage = $("#ad-messages-error");
  const saveButton = $("#save-ad-messages");
  state.adOptionsSaving = true;
  saveButton.disabled = start.readOnly = end.readOnly = true;
  errorMessage.textContent = "";
  renderAds();
  try {
    state.ads = await api("/api/ads/messages", {
      method: "PUT",
      body: JSON.stringify({ startMessage: start.value, endMessage: end.value })
    });
    $("#ad-messages-dialog").close();
    toast("Ad break messages saved.");
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    state.adOptionsSaving = false;
    saveButton.disabled = start.readOnly = end.readOnly = false;
    renderAds();
    if (!$("#ad-messages-dialog").open) $("#edit-ad-messages").focus();
  }
}

async function startAdBreak(startOnTwitch) {
  const durationSeconds = Number($("#ad-duration").value);
  const button = startOnTwitch ? $("#start-twitch-ad") : $("#start-ad-timer");
  try {
    button.disabled = true;
    const result = await api("/api/ads/start", {
      method: "POST",
      body: JSON.stringify({ durationSeconds, startOnTwitch })
    });
    state.ads = result.countdown || result;
    renderAds();
    $("#ad-message").textContent = startOnTwitch
      ? result.message || "Twitch accepted the ad."
      : "Manual timer started.";
    await refreshReport(false);
    toast(startOnTwitch ? "Twitch ad break started." : "Ad timer started.");
  } catch (error) {
    $("#ad-message").textContent = error.message;
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

// --- Session tracking and reports -------------------------------------------------------------

function renderSession() {
  const active = state.sessionActive;
  const pill = $("#session-pill");
  pill.className = `pill ${active ? "live" : "neutral"}`;
  pill.innerHTML = `<i></i> ${active ? "Session active" : "No session"}`;
  $("#session-toggle").textContent = active ? "End & report" : "Start session";
  $("#stream-title").disabled = active;
  $("#session-title").textContent = active ? (state.report?.title || "Session in progress") : "Ready when you are";
  $("#session-subtitle").textContent = active ? "Markers, scene changes, ads, and logged interactions are being recorded." : "Connect OBS, run the preflight, and start tracking the show.";
  renderFpsMarkerSummary();
  renderWardogs();
  renderSimpleExperience();
}

function renderFpsMarkerSummary(report = state.report) {
  const markers = report?.markers || [];
  const killCount = markers.filter(marker => marker.kind === "fps-kill").length;
  const deathCount = markers.filter(marker => marker.kind === "fps-death").length;
  const killValue = $("#fps-kill-count");
  const deathValue = $("#fps-death-count");
  const status = $("#fps-marker-status");
  if (killValue) killValue.textContent = String(killCount);
  if (deathValue) deathValue.textContent = String(deathCount);
  if (status) status.textContent = state.sessionActive
    ? "Ready. Marker options below also control replay and Twitch clips."
    : "Start a session to track kills and deaths.";
  $$('[data-fps-marker]').forEach(button => { button.disabled = !state.sessionActive; });
}

function renderWardogs() {
  const provider = state.wardogs;
  const result = state.report?.wardogs;
  const steamInput = $("#wardogs-steam-id");
  const serverInput = $("#wardogs-server");
  if (provider && document.activeElement !== steamInput) steamInput.value = provider.steamId || "";
  if (provider && document.activeElement !== serverInput) serverInput.value = provider.server || "";
  const configured = provider?.configured === true;
  const verified = result?.verifiedDelta === true;
  $("#wardogs-state").textContent = verified ? "Results ready" : configured ? "Configured" : "Not configured";
  $("#wardogs-kills").textContent = verified ? String(result.kills ?? 0) : "—";
  $("#wardogs-deaths").textContent = verified ? String(result.deaths ?? 0) : "—";
  const deaths = Number(result?.deaths || 0);
  const kills = Number(result?.kills || 0);
  $("#wardogs-kd").textContent = verified ? (deaths > 0 ? (kills / deaths).toFixed(2) : kills > 0 ? "∞" : "0.00") : "—";
  $("#wardogs-result-status").textContent = result?.status || provider?.status || "Add a SteamID64 and community server.";
  $("#capture-wardogs-baseline").disabled = !configured || !state.sessionActive;
  $("#fetch-wardogs-results").disabled = !configured || !state.report;
}

async function refreshWardogsStatus() {
  try {
    state.wardogs = await api("/api/wardogs/status");
    renderWardogs();
  } catch (error) {
    $("#wardogs-result-status").textContent = error.message;
  }
}

async function saveWardogsSettings() {
  try {
    state.wardogs = await api("/api/wardogs/settings", {
      method: "PUT",
      body: JSON.stringify({
        steamId: $("#wardogs-steam-id").value.trim(),
        server: $("#wardogs-server").value.trim()
      })
    });
    renderWardogs();
    toast(state.wardogs.configured ? "Wardogs setup saved." : "Wardogs results disabled.");
  } catch (error) { toast(error.message, true); }
}

async function captureWardogsBaseline() {
  try {
    const result = await api("/api/wardogs/baseline", { method: "POST" });
    state.wardogs = result.status;
    if (result.report) renderReport(result.report);
    renderWardogs();
    toast("Wardogs starting baseline captured.");
  } catch (error) { toast(error.message, true); }
}

async function fetchWardogsResults() {
  try {
    const result = await api("/api/wardogs/reconcile", {
      method: "POST",
      body: JSON.stringify({ reportId: state.report?.id || null })
    });
    state.wardogs = result.status;
    renderReport(result.report);
    renderWardogs();
    toast(result.report?.wardogs?.verifiedDelta
      ? "Wardogs kills and deaths added to the stream report."
      : "Wardogs stats fetched, but a reliable session delta was not available.",
      result.report?.wardogs?.verifiedDelta !== true);
  } catch (error) { toast(error.message, true); }
}

function renderReport(report) {
  state.report = report;
  $("#metric-duration").textContent = report ? Math.round(report.durationMinutes) : "0";
  $("#metric-highlights").textContent = report?.highlightCount ?? "0";
  $("#metric-scenes").textContent = report?.sceneChangeCount ?? "0";
  $("#metric-chat").textContent = report?.chatMessageCount ?? "0";
  $("#report-viewing-label").textContent = report
    ? `${new Date(report.startedAt).toLocaleDateString()} · ${report.endedAt ? "Saved" : "In progress"}`
    : "No saved stream selected";
  $("#report-performance").textContent = report?.performanceSummary || "Performance diagnosis appears after a tracked session.";
  renderFpsMarkerSummary(report);
  renderWardogs();
  const resourceList = $("#report-resource-drains");
  if (!report?.topResourceDrains?.length) {
    resourceList.className = "report-resource-drains empty-state";
    resourceList.textContent = "This older report did not retain process history. New streams will.";
  } else {
    resourceList.className = "report-resource-drains";
    resourceList.innerHTML = report.topResourceDrains.map(drain => `<div class="report-resource-row">
      <div><strong>${escapeHtml(drain.name)}</strong><small>${escapeHtml(drain.assessment)} · ${escapeHtml(drain.recommendation)}</small></div>
      <span>${drain.averageCpuPercent}% avg CPU<br>${Math.round(drain.averageMemoryMb)} MB avg</span>
    </div>`).join("");
  }
  renderPostStreamChecklist(report);
  renderStreamTimeline(report);
  const list = $("#marker-list");
  if (!report?.markers?.length) {
    list.className = "marker-list empty-state";
    list.textContent = "Your marked moments will appear here.";
  } else {
    list.className = "marker-list";
    list.innerHTML = [...report.markers].reverse().map(marker => {
      const link = marker.twitchEditUrl ? `<a href="${escapeHtml(marker.twitchEditUrl)}" target="_blank" rel="noreferrer">Edit clip ↗</a>` : "";
      return `<div class="marker-row"><span class="marker-time">${formatOffset(marker.offsetSeconds)}</span><div><strong>${escapeHtml(marker.title)}</strong><small>${escapeHtml(marker.kind)}${marker.note ? ` · ${escapeHtml(marker.note)}` : ""}</small></div>${link}</div>`;
    }).join("");
  }
  renderClipPublishingQueue(report);

  // Keep this timeline focused on stream-impacting automation and connectivity. Routine scene
  // changes are already summarized above, so duplicating every one would hide useful incidents.
  const activities = (report?.activities || []).filter(activity => ["tangia", "ad", "internet"].includes(activity.type));
  const activityList = $("#session-activity-list");
  if (!activities.length) {
    activityList.className = "marker-list empty-state";
    activityList.textContent = "Tangia interactions, ad breaks, and connection hiccups will appear here.";
  } else {
    const startedAt = new Date(report.startedAt).valueOf();
    activityList.className = "marker-list";
    activityList.innerHTML = [...activities].reverse().map(activity => {
      const offset = Math.max(0, (new Date(activity.at).valueOf() - startedAt) / 1000);
      return `<div class="marker-row"><span class="marker-time">${formatOffset(offset)}</span><div><strong>${escapeHtml(activity.detail)}</strong><small>${escapeHtml(activity.type)}</small></div></div>`;
    }).join("");
  }
  renderSimpleExperience();
}

function renderStreamHistory(history) {
  const list = $("#stream-history");
  if (!history?.length) {
    list.className = "stream-history empty-state";
    list.textContent = "Completed streams will be saved here automatically.";
    return;
  }
  list.className = "stream-history";
  list.innerHTML = history.map(report => {
    const when = new Date(report.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const stateLabel = report.completed ? "Saved" : "Interrupted";
    return `<div class="stream-history-row">
      <div><strong>${escapeHtml(report.title)}</strong><small>${escapeHtml(when)} · ${Math.round(report.durationMinutes)} min · ${report.chatMessageCount || 0} chats</small></div>
      <span class="history-state">${stateLabel}</span>
      <button class="secondary" data-open-report="${escapeHtml(report.id)}">Open</button>
    </div>`;
  }).join("");
}

async function refreshStreamHistory() {
  try { renderStreamHistory(await api("/api/reports?limit=30")); }
  catch (error) {
    $("#stream-history").className = "stream-history empty-state";
    $("#stream-history").textContent = error.message;
  }
}

async function openSavedReport(id) {
  try {
    renderReport(await api(`/api/reports/${encodeURIComponent(id)}`));
    toast("Saved stream opened.");
  } catch (error) { toast(error.message, true); }
}

const clipPublishingStorageKey = "johns-handler.clip-publishing";

function readClipPublishingState() {
  try {
    const value = JSON.parse(localStorage.getItem(clipPublishingStorageKey) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function publicTwitchClipUrl(marker) {
  return marker?.twitchClipId ? `https://clips.twitch.tv/${encodeURIComponent(marker.twitchClipId)}` : "";
}

function renderClipPublishingQueue(report) {
  const queue = $("#clip-publishing-queue");
  const clips = (report?.markers || []).filter(marker => marker.twitchClipId);
  if (!clips.length) {
    queue.className = "clip-publishing-queue empty-state";
    queue.textContent = "Create a Twitch clip to prepare it for TikTok and YouTube.";
    return;
  }

  const publishing = readClipPublishingState();
  queue.className = "clip-publishing-queue";
  queue.innerHTML = [...clips].reverse().map(marker => {
    const status = publishing[marker.twitchClipId] || {};
    const clipUrl = publicTwitchClipUrl(marker);
    return `<div class="clip-publish-row">
      <div class="clip-publish-title"><strong>${escapeHtml(marker.title)}</strong><small>${escapeHtml(clipUrl)}</small></div>
      <div class="clip-platforms">
        <label><input type="checkbox" data-clip-platform="tiktok" data-clip-id="${escapeHtml(marker.twitchClipId)}" ${status.tiktok ? "checked" : ""}> TikTok posted</label>
        <label><input type="checkbox" data-clip-platform="youtube" data-clip-id="${escapeHtml(marker.twitchClipId)}" ${status.youtube ? "checked" : ""}> YouTube posted</label>
      </div>
      <button class="secondary" data-open-streamladder="${escapeHtml(clipUrl)}">Copy clip + open StreamLadder</button>
    </div>`;
  }).join("");
}

function renderPostStreamChecklist(report) {
  const checklist = $("#post-stream-checklist");
  const storageKey = report?.id ? `johns-handler.post-stream.${report.id}` : null;
  let completed = [];
  if (storageKey) {
    try { completed = JSON.parse(localStorage.getItem(storageKey) || "[]"); }
    catch { completed = []; }
  }
  checklist.dataset.storageKey = storageKey || "";
  checklist.querySelectorAll("[data-post-task]").forEach(input => {
    input.checked = completed.includes(input.dataset.postTask);
    input.disabled = !storageKey;
  });
  const channel = state.channelName || "yepitsjohn";
  $("#open-twitch-stream-manager").href = `https://dashboard.twitch.tv/u/${encodeURIComponent(channel)}/stream-manager`;
}

function renderStreamTimeline(report) {
  const timeline = $("#stream-timeline");
  const items = report?.timeline || [];
  if (!items.length) {
    timeline.className = "stream-timeline empty-state";
    timeline.textContent = "Scene changes, highlights, Twitch events, breaks, and performance incidents will appear here.";
    return;
  }
  timeline.className = "stream-timeline";
  timeline.innerHTML = items.map(item => `
    <div class="timeline-row ${escapeHtml(item.severity || "info")}">
      <span class="marker-time">${formatOffset(item.offsetSeconds)}</span>
      <i aria-hidden="true"></i>
      <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)} · ${escapeHtml(item.type)}</small></div>
    </div>`).join("");
}

function revealPostStreamReport() {
  const panel = document.querySelector('[data-panel-id="report"]');
  if (!panel) return;
  setActiveWorkspace("after", { persist: true });
  if (panel.classList.contains("collapsed")) panel.querySelector(".panel-collapse-button")?.click();
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setGauge(name, value) {
  const normalized = Math.max(0, Math.min(100, Number(value) || 0));
  $(`#${name}-value`).textContent = `${Math.round(normalized)}%`;
  $(`#${name}-bar`).style.width = `${normalized}%`;
  const gauge = $(`#${name}-gauge`);
  gauge.classList.toggle("warn", normalized >= 85 && normalized < 95);
  gauge.classList.toggle("hot", normalized >= 95);
}

// --- Guided product demo ---------------------------------------------------------------------

function setDemoStage(phase) {
  ["before", "during", "after"].forEach((name, index) => {
    const stage = $(`#demo-stage-${name}`);
    const stageIndex = ["before", "during", "after"].indexOf(phase);
    stage.classList.toggle("active", name === phase);
    stage.classList.toggle("complete", index < stageIndex);
  });
}

function setDemoHero(level, icon, kicker, title, detail) {
  const hero = $("#demo-health-hero");
  hero.className = `demo-health-hero ${level}`;
  $("#demo-health-icon").textContent = icon;
  $("#demo-health-kicker").textContent = kicker;
  $("#demo-health-title").textContent = title;
  $("#demo-health-detail").textContent = detail;
}

function renderDemoMetrics() {
  const demo = state.demo;
  $("#demo-gpu-value").textContent = `${Math.round(demo.gpu)}%`;
  $("#demo-render-value").textContent = demo.renderMissed >= 1
    ? `${demo.renderMissed.toFixed(1)}% missed`
    : demo.renderMissed >= .25 ? "Beginning to fall behind" : "Healthy";
  $("#demo-network-value").textContent = `${Math.round(demo.latency)} ms`;
  $("#demo-headroom-value").textContent = `${Math.max(0, 100 - Math.round(demo.gpu))}%`;
}

function renderGuidedDemo() {
  const demo = state.demo;
  const primary = $("#demo-primary-action");
  const gpuButton = $("#demo-simulate-gpu");
  const networkButton = $("#demo-simulate-network");
  const fixButton = $("#demo-fix-it");
  const exitButton = $("#demo-exit");
  const metrics = $("#demo-metrics");
  const explanation = $("#demo-explanation");
  const fixes = $("#demo-fix-results");
  const summary = $("#demo-summary");

  setDemoStage(demo.phase);
  $("#demo-mode-state").textContent = demo.active ? "Safe demo mode" : "Demo off";
  exitButton.hidden = !demo.active;
  metrics.hidden = !demo.active || demo.phase === "before" || demo.phase === "after";
  fixes.hidden = true;
  summary.hidden = true;
  gpuButton.hidden = true;
  networkButton.hidden = true;
  fixButton.hidden = true;
  primary.hidden = false;

  if (!demo.active) {
    setDemoHero("healthy", "✓", "BEFORE THE STREAM", "See the complete Stream Health story", "Run a safe simulation using sample data. Nothing connects to or changes OBS.");
    explanation.innerHTML = "<strong>What this demonstrates</strong><p>Simple readiness, interpreted live health, safe corrective actions, and a useful session summary.</p>";
    primary.textContent = "Start guided demo";
    return;
  }

  if (demo.phase === "before") {
    setDemoHero("healthy", "✓", "BEFORE THE STREAM", "READY TO GO LIVE", "OBS, Twitch, audio, internet, and all enabled integrations passed their simulated checks.");
    explanation.innerHTML = "<strong>The technical detail stays out of the way</strong><p>Required checks are healthy. Spotify and Tangia are shown as intentionally skipped when disabled.</p>";
    primary.textContent = "Start demo stream";
    return;
  }

  if (demo.phase === "after") {
    setDemoHero("healthy", "✓", "AFTER THE STREAM", "STREAM SUMMARY", "The incident, recovery, and recommendation are preserved in a readable timeline.");
    explanation.innerHTML = "<strong>What happened?</strong><p>One performance incident was detected and recovered without changing disruptive broadcast settings.</p>";
    const issue = demo.incident === "network"
      ? "Connection instability appeared to be the likely cause. Review upload competition before the next stream."
      : "GPU pressure occurred once. Keep the lower-load scene available during demanding raid encounters.";
    const incidentLine = demo.incident === "network"
      ? "Connection instability detected at 185 ms"
      : "GPU pressure reached 94% with OBS render misses";
    summary.hidden = false;
    summary.innerHTML = `<strong>Example session</strong>
      <div class="demo-summary-metrics">
        <div><b>3h 04m</b><span>streamed</span></div>
        <div><b>9</b><span>highlights</span></div>
        <div><b>14</b><span>scene changes</span></div>
      </div>
      <div class="demo-timeline">
        <div><time>1:22:16</time><span>Boss victory marked and replay saved</span></div>
        <div><time>2:06:42</time><span>${incidentLine}</span></div>
        <div><time>2:07:18</time><span>Stream Health recovered after safe actions</span></div>
      </div>
      <div class="demo-recommendation"><strong>Recommendation:</strong> ${issue}</div>`;
    primary.textContent = "Run demo again";
    return;
  }

  renderDemoMetrics();
  if (demo.status === "healthy") {
    setDemoHero("healthy", "✓", "DURING THE STREAM", "STREAM HEALTHY", "Everything is operating normally. Choose a problem to see how the diagnosis works.");
    explanation.innerHTML = "<strong>Is everything okay?</strong><p>Yes. Raw values remain visible, but the interpreted answer comes first.</p>";
    primary.hidden = true;
    gpuButton.hidden = false;
    networkButton.hidden = false;
  } else if (demo.status === "building") {
    const network = demo.incident === "network";
    setDemoHero("warning", "!", "DETERMINISTIC RULE CHECK", network ? "CONNECTION QUALITY IS DECLINING" : "PERFORMANCE PRESSURE DETECTED", network ? "Latency and output congestion are increasing while OBS rendering remains healthy." : "GPU load and OBS render time are rising across the simulated sustained window.");
    explanation.innerHTML = `<strong>Watching for a sustained pattern</strong><p>${network ? "The PC remains healthy, which points toward the connection." : "A single spike is not enough. The rule waits for GPU pressure and render impact together."}</p>`;
    primary.hidden = true;
  } else if (demo.status === "diagnosed") {
    const network = demo.incident === "network";
    setDemoHero("critical", "!", "DURING THE STREAM", network ? "VIEWERS MAY BE EXPERIENCING DROPPED FRAMES" : "STREAM PERFORMANCE IS AT RISK", network ? "The connection to Twitch appears unstable. PC rendering remains healthy." : "GPU usage stayed above 90% while OBS render misses increased. GPU pressure is the likely cause.");
    explanation.innerHTML = `<strong>Likely cause: ${network ? "network instability" : "GPU pressure"}</strong><p>The conclusion comes from multiple related signals, not one universal threshold.</p>`;
    primary.hidden = true;
    fixButton.hidden = false;
  } else if (demo.status === "fixing") {
    setDemoHero("warning", "…", "SAFE CORRECTIVE ACTIONS", "RECOVERING STREAM HEADROOM", "The demo is applying reversible actions and watching the signals respond.");
    explanation.innerHTML = "<strong>No disruptive changes</strong><p>Encoder, resolution, bitrate, OBS, and the live stream remain untouched.</p>";
    fixes.hidden = false;
    fixes.innerHTML = demo.incident === "network"
      ? "<strong>Simulated actions</strong><ul><li>✓ Paused nonessential integration traffic</li><li>✓ Disabled a user-designated high-bandwidth overlay</li><li>✓ Preserved the current broadcast output settings</li></ul>"
      : "<strong>Simulated actions</strong><ul><li>✓ Paused Tangia animations</li><li>✓ Hid a user-designated animated overlay</li><li>✓ Enabled the predefined lower-load scene profile</li></ul>";
    primary.hidden = true;
  } else if (demo.status === "recovered") {
    setDemoHero("recovered", "✓", "DURING THE STREAM", "STREAM HEALTH RECOVERED", demo.incident === "network" ? "Connection quality returned to a healthy range after nonessential traffic was paused." : "GPU headroom and OBS rendering recovered after the simulated safe actions.");
    explanation.innerHTML = "<strong>The result is measured</strong><p>The incident and recovery will now appear in the post-stream summary.</p>";
    fixes.hidden = false;
    fixes.innerHTML = "<strong>Recovery confirmed</strong><p>Signals returned to a healthy range without a disruptive broadcast change.</p>";
    primary.textContent = "End demo stream";
  }
}

function resetGuidedDemo(active = false) {
  state.demo.runId += 1;
  Object.assign(state.demo, {
    active,
    phase: "before",
    status: active ? "ready" : "intro",
    incident: null,
    gpu: 68,
    renderMissed: .03,
    latency: 32,
    timeline: []
  });
  renderGuidedDemo();
}

function advanceGuidedDemo() {
  const demo = state.demo;
  if (!demo.active) {
    resetGuidedDemo(true);
  } else if (demo.phase === "before") {
    demo.phase = "during";
    demo.status = "healthy";
    renderGuidedDemo();
  } else if (demo.phase === "during" && demo.status === "recovered") {
    demo.phase = "after";
    renderGuidedDemo();
  } else if (demo.phase === "after") {
    resetGuidedDemo(true);
  }
}

async function runDemoIncident(type) {
  const demo = state.demo;
  if (!demo.active || demo.phase !== "during" || demo.status !== "healthy") return;
  demo.incident = type;
  demo.status = "building";
  const runId = ++demo.runId;
  const steps = type === "network"
    ? [
        { gpu: 67, renderMissed: .03, latency: 58 },
        { gpu: 66, renderMissed: .04, latency: 94 },
        { gpu: 68, renderMissed: .04, latency: 142 },
        { gpu: 67, renderMissed: .05, latency: 185 }
      ]
    : [
        { gpu: 76, renderMissed: .04, latency: 33 },
        { gpu: 84, renderMissed: .09, latency: 31 },
        { gpu: 91, renderMissed: .38, latency: 34 },
        { gpu: 94, renderMissed: 1.2, latency: 32 }
      ];
  renderGuidedDemo();
  for (const step of steps) {
    await new Promise(resolve => window.setTimeout(resolve, 850));
    if (runId !== demo.runId || !demo.active) return;
    Object.assign(demo, step);
    renderGuidedDemo();
  }
  demo.status = "diagnosed";
  renderGuidedDemo();
}

async function fixDemoIncident() {
  const demo = state.demo;
  if (demo.status !== "diagnosed") return;
  demo.status = "fixing";
  const runId = ++demo.runId;
  const steps = demo.incident === "network"
    ? [{ latency: 118 }, { latency: 72 }, { latency: 29 }]
    : [
        { gpu: 88, renderMissed: .62 },
        { gpu: 79, renderMissed: .18 },
        { gpu: 67, renderMissed: .04 }
      ];
  renderGuidedDemo();
  for (const step of steps) {
    await new Promise(resolve => window.setTimeout(resolve, 850));
    if (runId !== demo.runId || !demo.active) return;
    Object.assign(demo, step);
    renderGuidedDemo();
  }
  demo.status = "recovered";
  renderGuidedDemo();
}

// --- System and OBS performance diagnosis ----------------------------------------------------

async function refreshPerformance() {
  try {
    const [snapshot, internet] = await Promise.all([
      api("/api/system/status"),
      api("/api/internet/status")
    ]);
    state.system = snapshot;
    state.internet = internet;
    state.performanceError = null;
    const current = snapshot.current;
    // Simple health still receives fresh data when raw diagnostics are hidden.
    // Charts and process rows need repainting only when their panel is visible.
    if (document.querySelector('[data-panel-id="performance"]')?.getClientRects().length) {
      setGauge("cpu", current.cpuPercent);
      setGauge("gpu", current.gpuPercent);
      setGauge("vram", current.vramPercent);
      setGauge("ram", current.memoryPercent);
      $("#gpu-name").textContent = current.gpuName || "GPU monitor unavailable";
      $("#gpu-temp").textContent = current.gpuTemperatureC == null ? "--°C" : `${Math.round(current.gpuTemperatureC)}°C`;
      drawPerformanceChart(snapshot.history || []);
      renderResourceDrains(snapshot.resourceDrains || []);
      renderInternetStatus(internet);
    }
    evaluateHeadroom();
  } catch (error) {
    state.system = null;
    state.internet = null;
    state.performanceError = error.message;
    $("#performance-state").textContent = "Unavailable";
    $("#performance-warning").textContent = error.message;
    $("#performance-warning").classList.remove("alert");
    setHeadroomSignal("#headroom-value", "--", "warn");
    setHeadroomSignal("#network-health", "Unavailable", "warn");
    $("#internet-current").textContent = "Internet monitoring could not be refreshed.";
    $("#internet-current").className = "internet-current warn";
    renderSimpleExperience();
  }
}

function renderInternetStatus(internet) {
  const current = $("#internet-current");
  const events = $("#internet-events");
  const latency = internet.latencyMs == null ? "No response" : `${Math.round(internet.latencyMs)} ms`;
  current.textContent = `${internet.online ? latency : "Offline"} · ${Number(internet.failurePercent || 0).toFixed(0)}% failed checks in the last minute`;
  current.className = `internet-current ${internet.status === "offline" ? "hot" : internet.status === "slow" || internet.status === "unstable" ? "warn" : ""}`;

  const eventSignature = JSON.stringify(internet.events || []);
  if (events.dataset.signature === eventSignature) return;
  events.dataset.signature = eventSignature;
  if (!internet.events?.length) {
    events.className = "internet-events empty-state";
    events.textContent = "No connection hiccups recorded since John’s Twitch Handler opened.";
    return;
  }

  events.className = "internet-events";
  events.innerHTML = internet.events.slice(0, 8).map(event => {
    const time = new Date(event.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    return `<div class="internet-event ${escapeHtml(event.level)}">
      <time datetime="${escapeHtml(event.at)}">${escapeHtml(time)}</time>
      <span>${escapeHtml(event.message)}</span>
    </div>`;
  }).join("");
}

function renderResourceDrains(drains) {
  const list = $("#resource-drains");
  const signature = JSON.stringify(drains);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  if (!drains.length) {
    list.className = "resource-drains empty-state";
    list.textContent = "Collecting process samples…";
    return;
  }

  list.className = "resource-drains";
  list.innerHTML = drains.map(drain => {
    const count = drain.processCount > 1 ? ` · ${drain.processCount} processes` : "";
    return `<div class="resource-drain-row">
      <strong title="${escapeHtml(drain.name)}">${escapeHtml(drain.name)}${count}</strong>
      <span>${Number(drain.cpuPercent).toFixed(1)}% CPU · ${Math.round(drain.memoryMb)} MB</span>
      <small>${escapeHtml(drain.assessment)} ${escapeHtml(drain.recommendation)}</small>
    </div>`;
  }).join("");
}

function evaluateHeadroom() {
  if (!state.system?.current) return;
  const current = state.system.current;
  const maxLoad = Math.max(Number(current.cpuPercent) || 0, Number(current.gpuPercent) || 0);
  const headroom = Math.max(0, 100 - maxLoad);
  const renderMissed = Number(state.obs.renderSkippedPercent) || 0;
  const encoderMissed = Number(state.obs.outputSkippedPercent) || 0;
  const congestion = Number(state.obs.outputCongestion) || 0;
  const internetStatus = state.internet?.status || "checking";
  const internetOffline = internetStatus === "offline";
  const internetLimited = internetStatus === "slow" || internetStatus === "unstable";
  const actions = [...(state.system.warnings || [])];

  if (renderMissed >= 1) actions.push("OBS is missing render frames. Cap WoW's foreground FPS first, then reduce shadows or render scale.");
  else if (renderMissed >= .25) actions.push("OBS render misses are beginning; preserve more GPU headroom before the next pull.");
  if (encoderMissed >= 1) actions.push("The encoder is skipping frames. Keep NVENC enabled and close GPU-heavy background apps.");
  if (congestion >= .1) actions.push("Network congestion is affecting the stream. Reduce bitrate or pause other uploads.");
  if (internetOffline) actions.push("The internet connection check failed. Check the router or ISP before going live.");
  else if (internetLimited) actions.push(state.internet.detail);
  if (!actions.length && headroom < 15) actions.push("Headroom is limited. Cap WoW FPS a little below the rate your GPU can continuously hold.");

  setHeadroomSignal("#headroom-value", `${Math.round(headroom)}%`, headroom <= 5 ? "hot" : headroom < 15 ? "warn" : "");
  setHeadroomSignal("#render-health", !state.obs.connected ? "OBS offline" : renderMissed >= 1 ? `${renderMissed.toFixed(2)}% missed` : renderMissed >= .25 ? "Watch" : "Healthy", renderMissed >= 1 ? "hot" : renderMissed >= .25 ? "warn" : "");
  const internetLabel = internetOffline
    ? "Offline"
    : internetStatus === "unstable"
      ? "Unstable"
      : internetStatus === "slow"
        ? `${Math.round(state.internet.latencyMs)} ms`
        : state.internet?.latencyMs != null
          ? `${Math.round(state.internet.latencyMs)} ms`
          : "Checking";
  setHeadroomSignal("#network-health", congestion >= .1 ? "OBS congested" : internetLabel, internetOffline || congestion >= .1 ? "hot" : internetLimited || congestion > .02 ? "warn" : "");

  const severe = maxLoad >= 95 || renderMissed >= 1 || encoderMissed >= 1 || congestion >= .1 || internetOffline;
  const limited = maxLoad >= 85 || renderMissed >= .25 || congestion > .02 || internetLimited;
  $("#performance-state").textContent = severe ? "Action needed" : limited ? "Limited headroom" : "Healthy";
  const warning = $("#performance-warning");
  warning.textContent = actions.length ? actions.join(" ") : "CPU, GPU, internet latency, OBS rendering, and network output all have healthy headroom.";
  warning.classList.toggle("alert", severe);
  renderSimpleExperience();
}

function setHeadroomSignal(selector, text, level) {
  const element = $(selector);
  element.textContent = text;
  element.className = level;
}

function drawPerformanceChart(history) {
  const points = (key) => history.map((sample, index) => {
    const x = history.length <= 1 ? 0 : index / (history.length - 1) * 600;
    const y = 90 - Math.max(0, Math.min(100, sample[key] || 0)) / 100 * 86;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  $("#cpu-line").setAttribute("points", points("cpuPercent"));
  $("#gpu-line").setAttribute("points", points("gpuPercent"));
}

async function loadProfileAnalysis() {
  try {
    const analysis = await api("/api/obs/profile-analysis");
    renderProfileAnalysis(analysis);
    const channel = state.channelName || analysis.channelName;
    if (channel) loadChat(channel);
  } catch (error) {
    $("#optimizer-verdict").textContent = error.message;
  }
}

// --- Broadcast optimizer ---------------------------------------------------------------------

function renderProfileAnalysis(analysis) {
  $("#current-profile").textContent = analysis.found ? analysis.profileName : "Not found";
  $("#current-settings").textContent = analysis.found
    ? `${analysis.currentResolution || "?"} · ${analysis.currentFps || "?"} FPS · ${analysis.currentBitrateKbps || "?"} Kbps · ${analysis.currentEncoder || "unknown encoder"}`
    : "OBS profile could not be read";
  $("#optimizer-verdict").textContent = analysis.verdict;
  $("#apply-optimizer").dataset.profileFound = String(analysis.found);
  if (state.optimizer) renderOptimizerStatus();
}

async function refreshOptimizerStatus() {
  try {
    state.optimizer = await api("/api/obs/optimizer/status");
  } catch (error) {
    state.optimizer = { obsRunning: true, backupAvailable: false, error: error.message };
  }
  renderOptimizerStatus();
}

function renderOptimizerStatus(message) {
  const status = state.optimizer || {};
  const profileFound = $("#apply-optimizer").dataset.profileFound === "true";
  $("#apply-optimizer").disabled = state.optimizerBusy || status.obsRunning || !profileFound;
  $("#restore-optimizer").disabled = state.optimizerBusy || status.obsRunning || !status.backupAvailable;
  $("#optimizer-state").textContent = state.optimizerBusy ? "Working…" : status.obsRunning ? "Close OBS" : status.backupAvailable ? "Restore ready" : "Ready";
  $("#optimizer-action-message").textContent = message || status.error || (status.obsRunning
    ? "Close OBS before applying or restoring settings."
    : status.backupAvailable
      ? `The original ${status.backupProfileName} settings are saved and ready to restore.`
      : "Ready to apply. John's Twitch Handler will save the current profile first.");
}

async function runOptimizerAction(path) {
  state.optimizerBusy = true;
  renderOptimizerStatus();
  try {
    const result = await api(path, { method: "POST" });
    state.optimizer = result.status;
    renderProfileAnalysis(result.analysis);
    renderOptimizerStatus(result.message);
    toast(result.message);
  } catch (error) {
    await refreshOptimizerStatus();
    renderOptimizerStatus(error.message);
    toast(error.message, true);
  } finally {
    state.optimizerBusy = false;
    renderOptimizerStatus($("#optimizer-action-message").textContent);
  }
}

function loadChat(channelName) {
  const channel = String(channelName || "").trim().toLowerCase();
  if (!channel) return;
  if (channel !== state.channelName) state.twitchChatFeed = null;
  state.channelName = channel;
  localStorage.setItem("streamsidekick.channel", channel);
  $("#twitch-channel-name").value = channel;
  renderCombinedChat();
}

function extractYouTubeVideoId(value) {
  const text = String(value || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  try {
    const url = new URL(text);
    const candidate = url.hostname.includes("youtu.be")
      ? url.pathname.split("/").filter(Boolean)[0]
      : url.searchParams.get("v") || url.pathname.match(/\/(?:live|embed)\/([A-Za-z0-9_-]{11})/)?.[1];
    return /^[A-Za-z0-9_-]{11}$/.test(candidate || "") ? candidate : "";
  } catch {
    return "";
  }
}

function renderCombinedChat() {
  const channel = String(state.channelName || "").trim().toLowerCase();
  const youtube = state.youtubeVideoId;
  const parent = window.location.hostname;
  const wrap = $("#chat-frame-wrap");
  const twitchLink = $("#open-twitch-chat");
  twitchLink.hidden = !channel;
  if (channel) twitchLink.href = `https://www.twitch.tv/popout/${encodeURIComponent(channel)}/chat?popout=`;
  else twitchLink.removeAttribute("href");
  if (!channel && !youtube && !state.tikFinityEnabled) {
    $("#chat-heading").textContent = "Channel chat";
    wrap.className = "chat-frame-wrap empty-state";
    wrap.textContent = "Add Twitch, YouTube, or TikFinity chat in Settings.";
    return;
  }
  const chats = [];
  const chatNames = [];
  if (channel) {
    // A local message list avoids the header, leaderboards, and promotions inside Twitch's
    // cross-origin embed. The external link keeps Twitch's reply/moderation tools available.
    chats.push(`<div class="chat-column"><strong>TWITCH</strong><div class="twitch-chat-stream"><div id="twitch-chat-list" class="twitch-chat-list empty-state" role="log" aria-label="${escapeHtml(channel)} Twitch messages" aria-live="polite" aria-relevant="additions text">Loading Twitch messages…</div><p id="twitch-chat-status" class="chat-feed-status" role="status" hidden></p></div></div>`);
    chatNames.push("Twitch");
  }
  if (youtube) {
    const src = `https://www.youtube.com/live_chat?v=${encodeURIComponent(youtube)}&embed_domain=${encodeURIComponent(parent)}&dark_theme=1`;
    chats.push(`<div class="chat-column"><strong>YOUTUBE</strong><iframe title="YouTube live chat" src="${src}" allowfullscreen></iframe></div>`);
    chatNames.push("YouTube");
  }
  if (state.tikFinityEnabled) {
    chats.push('<div class="chat-column"><strong>TIKTOK VIA TIKFINITY</strong><div id="tikfinity-chat-list" class="tikfinity-chat-list empty-state">Waiting for TikTok chat…</div></div>');
    chatNames.push("TikTok");
  }
  $("#chat-heading").textContent = chatNames.length > 1 ? `${chatNames.join(" + ")} chat` : chatNames[0] === "Twitch" ? `${channel} chat` : `${chatNames[0]} live chat`;
  wrap.className = `chat-frame-wrap${chats.length > 1 ? ` multiplatform platform-count-${chats.length}` : ""}`;
  wrap.innerHTML = chats.join("");
  renderTwitchChat();
  renderTikFinity();
}

function renderTwitchChat() {
  const list = $("#twitch-chat-list");
  const status = $("#twitch-chat-status");
  if (!list || !status) return;
  const feed = state.twitchChatFeed;
  const rows = Array.isArray(feed?.messages) ? feed.messages.slice(-80) : [];
  status.hidden = !feed || feed.connected === true;
  status.textContent = status.hidden ? "" : "Twitch chat is disconnected. Reconnect Twitch in Settings.";
  const signature = JSON.stringify({ connected: feed?.connected, rows });
  if (list.dataset.signature === signature) return;
  const followNewest = !list.dataset.signature || list.scrollHeight - list.scrollTop - list.clientHeight < 32;
  const previousScrollTop = list.scrollTop;
  list.dataset.signature = signature;
  list.className = `twitch-chat-list${rows.length ? "" : " empty-state"}`;
  if (rows.length) {
    list.innerHTML = rows.map(message => `<div class="twitch-chat-message"><strong>${escapeHtml(message.userName)}</strong><span>${escapeHtml(message.text)}</span></div>`).join("");
  } else {
    list.textContent = !feed ? "Loading Twitch messages…"
      : feed.connected ? "Waiting for new Twitch messages. If chat stays empty, reconnect Twitch in Settings."
      : "Connect with Twitch in Settings to see messages here.";
  }
  // Follow live chat unless the streamer has deliberately scrolled back to read something.
  list.scrollTop = followNewest ? list.scrollHeight : previousScrollTop;
}

async function refreshTwitchChat() {
  const channel = state.channelName;
  const list = $("#twitch-chat-list");
  if (!channel || !list || !list.getClientRects().length || state.twitchChatBusy) return;
  state.twitchChatBusy = true;
  try {
    const feed = await api("/api/chat/messages", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (state.channelName !== channel) return;
    state.twitchChatFeed = feed;
    renderTwitchChat();
  } catch {
    if (state.channelName !== channel) return;
    state.twitchChatFeed = { connected: false, messages: state.twitchChatFeed?.messages || [] };
    renderTwitchChat();
    const status = $("#twitch-chat-status");
    if (status) status.textContent = "Chat is temporarily unavailable. Retrying…";
  } finally {
    state.twitchChatBusy = false;
  }
}

async function openGameChat() {
  const channel = String(state.channelName || "").trim().toLowerCase();
  const youtube = state.youtubeVideoId;
  if (!channel && !youtube) {
    toast("Add Twitch or YouTube chat in Settings first.", true);
    return;
  }

  const fallbackUrl = `/chat-popout.html?channel=${encodeURIComponent(channel)}&youtube=${encodeURIComponent(youtube)}`;
  if (!("documentPictureInPicture" in window)) {
    window.open(fallbackUrl, "johns-twitch-handler-chat", "popup,width=420,height=680");
    toast("Game Chat opened. Press Win+Ctrl+T with that window selected if you use PowerToys Always On Top.");
    return;
  }

  try {
    // Document Picture-in-Picture is a Chromium feature whose window remains above a borderless
    // game. The local Twitch view contains messages only and does not add capture load to OBS.
    const pipWindow = await documentPictureInPicture.requestWindow({ width: 420, height: 680 });
    const frames = [];
    if (channel) frames.push(`<section><span>TWITCH</span><iframe title="${escapeHtml(channel)} Twitch chat" src="/chat-overlay.html?limit=20"></iframe></section>`);
    if (youtube) frames.push(`<section><span>YOUTUBE</span><iframe title="YouTube live chat" src="https://www.youtube.com/live_chat?v=${encodeURIComponent(youtube)}&embed_domain=${encodeURIComponent(window.location.hostname)}&dark_theme=1"></iframe></section>`);
    pipWindow.document.head.innerHTML = `<title>Stream chat</title><style>
      *{box-sizing:border-box}body{display:grid;grid-template-rows:auto 1fr;height:100vh;margin:0;overflow:hidden;background:#0e1118;color:#f5f7fb;font:11px "Segoe UI",sans-serif}
      header{display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid #2a3040;background:#11141c}header strong{margin-right:auto}label{display:flex;gap:5px;align-items:center;color:#9aa3b5}input{width:72px;accent-color:#9867ff}.chats{display:grid;grid-template-rows:repeat(${frames.length},minmax(0,1fr));gap:1px;background:#2a3040;min-height:0}section{display:grid;grid-template-rows:22px 1fr;min-height:0;background:#0e1118}section span{display:flex;align-items:center;padding:0 7px;color:#9aa3b5;font-size:9px}iframe{width:100%;height:100%;border:0;opacity:.92}
    </style>`;
    pipWindow.document.body.innerHTML = `<header><strong>Stream chat</strong><label>Opacity <input id="chat-opacity" type="range" min="45" max="100" value="92"></label></header><div class="chats">${frames.join("")}</div>`;
    pipWindow.document.querySelector("#chat-opacity").addEventListener("input", event => {
      pipWindow.document.querySelectorAll("iframe").forEach(frame => { frame.style.opacity = String(Number(event.target.value) / 100); });
    });
  } catch (error) {
    window.open(fallbackUrl, "johns-twitch-handler-chat", "popup,width=420,height=680");
    toast(`Always-on-top chat was unavailable, so a compact chat window opened instead. ${error.message}`);
  }
}

// --- Twitch and Spotify integrations ----------------------------------------------------------

async function refreshAlerts() {
  try {
    const feed = await api("/api/alerts");
    $("#alerts-state").textContent = feed.connected ? "Connected" : "Not connected";
    $("#alerts-state").style.color = feed.connected ? "var(--green)" : "";
    const list = $("#alerts-list");
    const signature = JSON.stringify({ status: feed.status, alerts: feed.alerts || [] });
    if (list.dataset.signature === signature) {
      $("#alerts-warnings").textContent = feed.setupWarnings?.length ? `Permissions: ${feed.setupWarnings.join(" · ")}` : "";
      return;
    }
    list.dataset.signature = signature;
    if (!feed.alerts?.length) {
      list.className = "alerts-list empty-state";
      list.textContent = feed.status;
    } else {
      list.className = "alerts-list";
      list.innerHTML = feed.alerts.map(alert => `
        <div class="alert-row ${alertHighlightClass(alert.type)}">
          <span class="alert-icon">${alertIcon(alert.type)}</span>
          <div class="alert-copy"><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(alert.detail)}</small></div>
          <time class="alert-time">${formatAlertTime(alert.at)}</time>
        </div>`).join("");
    }
    $("#alerts-warnings").textContent = feed.setupWarnings?.length ? `Permissions: ${feed.setupWarnings.join(" · ")}` : "";
  } catch {
    $("#alerts-state").textContent = "Unavailable";
  }
}

async function refreshChatChime() {
  try {
    state.chatChime = await api("/api/chat-chime");
    const snapshot = state.chatChime;
    $("#chat-chime-enabled").checked = snapshot.enabled;
    $("#chat-chime-volume").value = snapshot.volumeDb;
    $("#chat-chime-volume-value").textContent = `${Number(snapshot.volumeDb).toFixed(0).replace("-", "−")} dB`;
    const status = $("#chat-chime-status");
    status.textContent = snapshot.status;
    status.classList.toggle("unsafe", snapshot.enabled && !snapshot.safeToPlay);
    $("#test-chat-chime").disabled = !snapshot.obsConnected || !snapshot.safeToPlay;
  } catch (error) {
    $("#chat-chime-status").textContent = error.message;
    $("#test-chat-chime").disabled = true;
  }
}

async function saveChatChime() {
  try {
    state.chatChime = await api("/api/chat-chime", {
      method: "PUT",
      body: JSON.stringify({
        enabled: $("#chat-chime-enabled").checked,
        volumeDb: Number($("#chat-chime-volume").value)
      })
    });
    await refreshChatChime();
  } catch (error) { toast(error.message, true); }
}

function alertIcon(type) {
  // Activity uses one restrained utility-style glyph set instead of mixed platform emoji.
  return ({ follow: "+", subscription: "S", gift: "G", resub: "R", cheer: "B", raid: "R", reward: "C", ad: "A", live: "●", offline: "■", test: "✓", warning: "!" })[type] || "•";
}

function alertHighlightClass(type) {
  // Follows, every kind of subscription, and Bits receive distinct high-contrast treatments.
  if (type === "follow") return "alert-follow alert-highlight";
  if (["subscription", "gift", "resub"].includes(type)) return "alert-subscription alert-highlight";
  if (type === "cheer") return "alert-bits alert-highlight";
  return "";
}

async function refreshSpotify() {
  if (!state.spotifyEnabled) {
    state.spotify = { connected: false, status: "Spotify is disabled on this computer.", queue: [], options: { rewardTitle: "Song Request", autoQueue: true, allowExplicit: true }, requests: [] };
    return;
  }
  try {
    state.spotify = await api("/api/spotify/status");
    renderSpotify();
  } catch (error) {
    state.spotify = { connected: false, status: error.message, queue: [], options: { rewardTitle: "Song Request", autoQueue: true, allowExplicit: true }, requests: [] };
    renderSpotify();
  }
}

function renderSpotifyPreflight(snapshot) {
  if (!state.spotifyEnabled) {
    setCheck("#check-spotify", true, "Skipped on this computer", "Skipped", "skipped");
    return;
  }
  const connected = Boolean(snapshot?.connected);
  const playback = snapshot?.playback;
  const ready = connected && Boolean(playback);
  const detail = ready
    ? `${playback.deviceName} ready for viewer requests`
    : connected
      ? "Connected. Open Spotify and start playback on a device."
      : "Connect Spotify to accept viewer song requests";
  setCheck("#check-spotify", ready, detail, ready ? "Ready" : connected ? "Device" : "Connect");
}

function renderMusicOverlayVisibility() {
  const known = typeof state.musicOverlayVisible === "boolean";
  const button = $("#toggle-music-overlay");
  button.disabled = state.musicOverlayBusy || !known;
  button.textContent = state.musicOverlayBusy ? "Saving…" : !known ? "Checking overlay…"
    : state.musicOverlayVisible ? "Hide overlay" : "Show overlay";
  button.setAttribute("aria-busy", String(state.musicOverlayBusy));
  $("#music-overlay-status").textContent = !known ? "Checking whether the overlay is shown."
    : state.musicOverlayVisible ? "Song and queue graphics are enabled in the OBS overlay."
    : "Song and queue graphics are hidden. Music and requests continue.";
}

$("#toggle-music-overlay").addEventListener("click", async () => {
  if (state.musicOverlayBusy || typeof state.musicOverlayVisible !== "boolean") return;
  state.musicOverlayBusy = true;
  renderMusicOverlayVisibility();
  try {
    const settings = await api("/api/overlay/music", {
      method: "PUT", body: JSON.stringify({ visible: !state.musicOverlayVisible })
    });
    if (typeof settings?.visible !== "boolean") throw new Error("Restart the Handler to load the updated overlay controls.");
    state.musicOverlayVisible = settings.visible;
    toast(settings.visible ? "Song overlay enabled. OBS will show it shortly." : "Song overlay hidden. Music and requests continue.");
  } catch (error) { toast(error.message, true); }
  finally {
    state.musicOverlayBusy = false;
    renderMusicOverlayVisibility();
  }
});

function renderSpotify() {
  const snapshot = state.spotify || {};
  const playback = snapshot.playback;
  const track = playback?.track;
  $("#spotify-state").textContent = snapshot.connected ? (playback?.isPlaying ? "Playing" : "Connected") : "Not connected";
  $("#spotify-track-title").textContent = track?.title || (snapshot.connected ? "No active playback" : "Connect Spotify to begin");
  $("#spotify-track-detail").textContent = track ? `${track.artist} · ${track.album}` : (snapshot.status || "Requests play through your active Spotify device.");
  $("#spotify-device").textContent = playback ? `${playback.deviceName} · ${playback.volumePercent}%` : "Not available";
  $("#spotify-play-state").textContent = playback?.isPlaying ? "▶" : "♪";
  const rewardInput = $("#spotify-reward-title");
  if (document.activeElement !== rewardInput) rewardInput.value = snapshot.options?.rewardTitle || "Song Request";
  $("#spotify-auto-queue").checked = Boolean(snapshot.options?.autoQueue);
  $("#spotify-allow-explicit").checked = Boolean(snapshot.options?.allowExplicit);
  $("#search-spotify").disabled = !snapshot.connected;
  $("#test-spotify-request").disabled = !snapshot.connected;
  $("#disconnect-spotify").disabled = !snapshot.connected;
  $("#skip-spotify").disabled = !snapshot.connected || !playback;
  renderSpotifyPreflight(snapshot);
  renderSpotifyQueue(snapshot.queue || []);
  renderSpotifyRequests(snapshot.requests || []);
  updateDashboardBorder();
}

function renderSpotifyQueue(queue) {
  const list = $("#spotify-up-next");
  $("#spotify-queue-count").textContent = queue.length ? `${queue.length} shown` : "Spotify queue";
  if (!queue.length) {
    list.className = "spotify-up-next empty-state";
    list.textContent = state.spotify?.connected ? "No upcoming tracks reported by Spotify." : "Connect Spotify to view the queue.";
    return;
  }
  list.className = "spotify-up-next";
  list.innerHTML = queue.map((item, index) => {
    const requester = item.viewerRequest ? `requested by ${item.requester}` : "from Spotify playback";
    return `<div class="spotify-queue-row"><span>${index + 1}</span><div><strong>${escapeHtml(item.track.title)}${item.track.explicit ? " · E" : ""}</strong><small>${escapeHtml(item.track.artist)} · ${escapeHtml(requester)}</small></div></div>`;
  }).join("");
}

function renderSpotifyRequests(requests) {
  const list = $("#spotify-request-list");
  if (!requests.length) {
    list.className = "spotify-request-list empty-state";
    list.textContent = "No song requests yet.";
    return;
  }
  list.className = "spotify-request-list";
  list.innerHTML = requests.map(request => {
    const track = request.track;
    const title = track?.title || request.sourceText || "Unmatched request";
    const detail = track ? `${track.artist} · requested by ${request.requester}` : `${request.requester} · ${request.note || "No match"}`;
    const actions = request.status === "pending"
      ? `<div class="request-buttons"><button class="secondary" data-spotify-approve="${escapeHtml(request.id)}">Queue</button><button class="text-button" data-spotify-reject="${escapeHtml(request.id)}">Reject</button></div>`
      : `<span class="request-status ${escapeHtml(request.status)}">${escapeHtml(request.status)}</span>`;
    return `<div class="spotify-request-row"><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}${request.note ? ` · ${escapeHtml(request.note)}` : ""}</small></div>${actions}</div>`;
  }).join("");
}

async function searchSpotify() {
  const query = $("#spotify-search").value.trim();
  if (query.length < 2) { toast("Enter a song or artist to search Spotify.", true); return; }
  try {
    $("#spotify-search-results").innerHTML = '<div class="empty-state">Searching Spotify…</div>';
    state.spotifyResults = await api(`/api/spotify/search?query=${encodeURIComponent(query)}`);
    $("#spotify-search-results").innerHTML = state.spotifyResults.length
      ? state.spotifyResults.map(track => `<div class="spotify-result"><div><strong>${escapeHtml(track.title)}${track.explicit ? " · E" : ""}</strong><small>${escapeHtml(track.artist)} · ${escapeHtml(track.album)}</small></div><button class="secondary" data-spotify-queue="${escapeHtml(track.uri)}">Queue</button></div>`).join("")
      : '<div class="empty-state">No Spotify tracks matched.</div>';
  } catch (error) {
    $("#spotify-search-results").textContent = error.message;
  }
}

function formatAlertTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "now" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const layoutStorageKey = "streamsidekick.panelOrder";
const collapsedPanelsStorageKey = "streamsidekick.collapsedPanels";
const panelSizesStorageKey = "streamsidekick.panelSizes";
const defaultLayoutStorageKey = "johns-handler.default-layout-v1";
let useRecommendedPanelLayout = false;
const floatingPanelsStorageKey = "streamsidekick.floatingPanels";
const panelTabGroupsStorageKey = "streamsidekick.panelTabGroups";
const themeStorageKey = "streamsidekick.theme";
const visualStyleStorageKey = "johns-handler.visual-style";
const workspaceStorageKey = "streamsidekick.workspacePage";
const panelPagesStorageKey = "streamsidekick.panelPages";
const userModeStorageKey = "streamsidekick.userMode";
const simpleFeatureStorageKey = "johns-handler.simple-features";
const simplePanelShortcutsStorageKey = "johns-handler.simple-panel-shortcuts";
const simpleFeatureDefinitions = [
  { id: "reminders", label: "Personal checklist", detail: "Show Get Coffee and other manual Preflight reminders.", defaultEnabled: true },
  { id: "health", label: "Stream Health", detail: "Show the plain-English computer and internet summary before streaming.", defaultEnabled: true },
  { id: "quick", label: "Stage shortcuts", detail: "Show the two most useful controls for the current stream stage.", defaultEnabled: true },
  { id: "chat", label: "Chat and activity", detail: "Pin a shortcut to combined chat and viewer activity.", defaultEnabled: false },
  { id: "spotify", label: "Song requests", detail: "Pin a shortcut to the Spotify queue and request controls.", defaultEnabled: false },
  { id: "ads", label: "Ad timer", detail: "Pin a shortcut to the ad-break timer.", defaultEnabled: false }
];
const simplePanelShortcutDefinitions = [
  { id: "scenes", label: "OBS scenes" },
  { id: "audio", label: "Audio mixer" },
  { id: "chat", label: "Chat" },
  { id: "alerts", label: "Activity feed" },
  { id: "clips", label: "Clip assistant" },
  { id: "ads", label: "Ad timer" },
  { id: "performance", label: "Performance" },
  { id: "commands", label: "Chat commands" },
  { id: "automations", label: "Automations" },
  { id: "raids", label: "Raid manager" },
  { id: "viewers", label: "Viewer notes" },
  { id: "spotify", label: "Spotify song requests" },
  { id: "tangia", label: "Tangia controls" },
  { id: "streamelements", label: "Multistream" },
  { id: "tikfinity", label: "TikTok chat" },
  { id: "optimizer", label: "Broadcast optimizer" },
  { id: "report", label: "Stream report" }
];
let simpleFeaturePreferences = loadSimpleFeaturePreferences();
let simplePanelShortcuts = loadSimplePanelShortcuts();
const defaultPanelOrder = HandlerPanelLayout.order;
let layoutSaveChain = Promise.resolve();
let panelTabGroups = [];
let floatingPanelZ = 200;
let draggedPanel = null;
let pendingTabTarget = null;

const workspacePages = {
  pre: {
    title: "Pre-stream",
    summary: "Complete the checklist and confirm your integrations before going live."
  },
  during: {
    title: "During stream",
    summary: "Keep live controls, chat, alerts, music, ads, and performance in reach."
  },
  after: {
    title: "After stream",
    summary: "Review the timeline, performance, clips, raids, and publishing checklist."
  }
};

function loadSimpleFeaturePreferences() {
  const defaults = Object.fromEntries(simpleFeatureDefinitions.map(feature => [feature.id, feature.defaultEnabled]));
  try {
    const saved = JSON.parse(localStorage.getItem(simpleFeatureStorageKey) || "{}");
    return Object.fromEntries(Object.entries(defaults).map(([id, enabled]) => [id, typeof saved?.[id] === "boolean" ? saved[id] : enabled]));
  } catch {
    return defaults;
  }
}

function saveSimpleFeaturePreferences() {
  localStorage.setItem(simpleFeatureStorageKey, JSON.stringify(simpleFeaturePreferences));
}

function loadSimplePanelShortcuts() {
  const allowed = new Set(simplePanelShortcutDefinitions.map(item => item.id));
  try {
    const saved = JSON.parse(localStorage.getItem(simplePanelShortcutsStorageKey) || "null");
    if (Array.isArray(saved)) return new Set(saved.filter(id => allowed.has(id)));
  } catch { /* Fall through to the older Simple preferences. */ }
  // Preserve the three shortcuts supported before panels gained their own Add to Simple button.
  return new Set(["chat", "spotify", "ads"].filter(id => simpleFeaturePreferences[id]));
}

function saveSimplePanelShortcuts() {
  localStorage.setItem(simplePanelShortcutsStorageKey, JSON.stringify([...simplePanelShortcuts]));
}

function setSimplePanelShortcut(panelId, enabled, announce = true) {
  const definition = simplePanelShortcutDefinitions.find(item => item.id === panelId);
  if (!definition) return;
  if (enabled) simplePanelShortcuts.add(panelId);
  else simplePanelShortcuts.delete(panelId);
  // Keep the original three Customize Simple choices compatible with the new panel buttons.
  if (["chat", "spotify", "ads"].includes(panelId)) {
    simpleFeaturePreferences[panelId] = enabled;
    saveSimpleFeaturePreferences();
  }
  saveSimplePanelShortcuts();
  updateSimplePanelShortcutButtons();
  renderSimpleExperience();
  if (announce) toast(`${definition.label} ${enabled ? "added to" : "removed from"} Simple mode.`);
}

function updateSimplePanelShortcutButtons() {
  $$(".dashboard-grid > .panel").forEach(panel => {
    panel.classList.toggle("simple-pinned", simplePanelShortcuts.has(panel.dataset.panelId));
  });
  $$('[data-simple-panel-shortcut]').forEach(button => {
    const enabled = simplePanelShortcuts.has(button.dataset.simplePanelShortcut);
    button.classList.toggle("active", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.textContent = enabled ? "In Simple ✓" : "Add to Simple";
  });
}

function initializeUserMode() {
  const saved = localStorage.getItem(userModeStorageKey);
  applyUserMode(saved === "advanced" ? "advanced" : "simple", false);
  $$('[data-user-mode]').forEach(button => button.addEventListener("click", () => {
    applyUserMode(button.dataset.userMode, true);
  }));
  $("#simple-details-toggle").addEventListener("click", () => {
    setSimpleDetails(!document.body.classList.contains("simple-details-open"));
  });
  $("#simple-primary-action").addEventListener("click", runSimplePrimaryAction);
  $("#live-status-fix").addEventListener("click", () => runSimpleTool("health"));
  $("#simple-stream-title").addEventListener("input", event => {
    $("#stream-title").value = event.target.value;
  });
  $("#stream-title").addEventListener("input", event => {
    $("#simple-stream-title").value = event.target.value;
  });
  $("#simple-summary").addEventListener("click", event => {
    const reminder = event.target.closest("[data-simple-manual-id]");
    if (reminder) {
      const item = state.manualPreflightItems.find(entry => entry.id === reminder.dataset.simpleManualId);
      if (!item) return;
      item.checked = !item.checked;
      saveManualPreflightItems();
      renderManualPreflightItems();
      return;
    }
    const button = event.target.closest("[data-simple-tool]");
    if (button) runSimpleTool(button.dataset.simpleTool);
  });
}

function applyUserMode(mode, persist) {
  const selected = mode === "advanced" ? "advanced" : "simple";
  document.body.dataset.userMode = selected;
  if (selected === "advanced") document.body.classList.remove("simple-details-open");
  $$('[data-user-mode]').forEach(button => {
    const active = button.dataset.userMode === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (persist) {
    localStorage.setItem(userModeStorageKey, selected);
    toast(`${selected === "simple" ? "Simple" : "Advanced"} mode selected.`);
  }
  if (panelTabGroups.length) renderPanelTabGroups();
  renderSimpleExperience();
}

function setSimpleDetails(open) {
  document.body.classList.toggle("simple-details-open", open);
  $("#simple-details-toggle").textContent = open ? "Hide details" : "Show details";
  if (!open) $("#simple-summary").scrollIntoView({ behavior: "smooth", block: "start" });
}

function simpleStatusItem(label, status, level = "ready") {
  const icon = level === "ready" ? "✓" : level === "critical" ? "!" : level === "warning" ? "!" : "…";
  return `<div class="simple-status-item ${level}"><i>${icon}</i><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(status)}</small></div></div>`;
}

function renderSimpleManualReminders() {
  const card = $("#simple-reminders-card");
  const list = $("#simple-reminder-list");
  if (!card || !list) return;
  const onPreStream = (document.body.dataset.workspacePage || "pre") === "pre";
  card.hidden = !onPreStream || !simpleFeaturePreferences.reminders;
  if (card.hidden) return;
  list.innerHTML = state.manualPreflightItems.length
    ? state.manualPreflightItems.map(item => `<button class="simple-reminder ${item.checked ? "done" : ""}" type="button" data-simple-manual-id="${escapeHtml(item.id)}" aria-pressed="${item.checked}">
        <span class="simple-reminder-check" aria-hidden="true">${item.checked ? "✓" : ""}</span>
        <span>${escapeHtml(item.label)}</span>
      </button>`).join("")
    : `<p class="muted">No personal reminders are enabled. You can add them under Details.</p>`;
  const complete = state.manualPreflightItems.length > 0 && state.manualPreflightItems.every(item => item.checked);
  $("#simple-reminders-state").textContent = complete ? "Complete" : "Not finished";
  card.className = `simple-feature-card ${complete ? "healthy" : "warning"}`;
}

function getSimpleHealthSummary() {
  if (state.performanceError) return {
    level: "warning", state: "Unavailable", title: "Stream health could not be refreshed",
    detail: state.performanceError
  };
  const current = state.system?.current;
  const internetStatus = state.internet?.status || "checking";
  if (!current || internetStatus === "checking") return {
    level: "neutral", state: "Checking", title: "Checking your computer",
    detail: "I am checking performance and internet health."
  };
  const highestLoad = Math.max(Number(current.cpuPercent) || 0, Number(current.gpuPercent) || 0);
  const renderMissed = Number(state.obs?.renderSkippedPercent) || 0;
  const encoderMissed = Number(state.obs?.outputSkippedPercent) || 0;
  if (internetStatus === "offline" || internetStatus === "unstable") return {
    level: "critical", state: "Needs attention", title: "Internet problem detected",
    detail: "Your computer is being monitored, but your connection is not healthy enough for a reliable stream."
  };
  if (highestLoad >= 95 || renderMissed >= 1 || encoderMissed >= 1) return {
    level: "critical", state: "Needs attention", title: "Performance pressure detected",
    detail: "Your stream computer or OBS is struggling. Open Stream Health for the safest next step."
  };
  if (highestLoad >= 85 || renderMissed >= .25 || internetStatus === "slow") return {
    level: "warning", state: "Watch closely", title: "Headroom is getting low",
    detail: "The stream should keep working, but John’s Twitch Handler found less room than usual."
  };
  return {
    level: "healthy", state: "Healthy", title: "Everything looks good",
    detail: state.obs?.connected
      ? "Your computer, OBS, and internet have healthy headroom."
      : "Your computer and internet have healthy headroom. OBS checks will appear after it connects."
  };
}

function renderSimpleTools(page) {
  const grid = document.querySelector(".simple-feature-grid");
  if (grid) grid.dataset.stage = page;
  renderSimpleManualReminders();
  const health = getSimpleHealthSummary();
  const healthCard = $("#simple-health-card");
  healthCard.hidden = page !== "pre" || !simpleFeaturePreferences.health;
  healthCard.className = `simple-feature-card ${health.level}`;
  $("#simple-health-state").textContent = health.state;
  $("#simple-health-title").textContent = health.title;
  $("#simple-health-detail").textContent = health.detail;

  const quickTools = page === "during"
    ? { title: "Live controls", detail: state.obs?.currentScene ? `Current scene: ${state.obs.currentScene}` : "Keep OBS scenes and important audio within easy reach.", primary: ["controls", "OBS controls"], secondary: ["audio", "Audio mixer"] }
    : page === "after"
      ? { title: "After-stream tools", detail: "Review the show and prepare the moments you want to share.", primary: ["report", "Review report"], secondary: ["clips", "Clip assistant"] }
      : { title: "Setup tools", detail: "Refresh the checks or open your saved connection settings.", primary: ["refresh", "Refresh status"], secondary: ["settings", "Connections"] };
  $("#simple-quick-title").textContent = quickTools.title;
  $("#simple-quick-detail").textContent = quickTools.detail;
  const primary = $("#simple-quick-primary");
  primary.dataset.simpleTool = quickTools.primary[0];
  primary.textContent = quickTools.primary[1];
  const secondary = $("#simple-quick-secondary");
  secondary.dataset.simpleTool = quickTools.secondary[0];
  secondary.textContent = quickTools.secondary[1];
  $("#simple-quick-card").hidden = !simpleFeaturePreferences.quick;

  const pinned = simplePanelShortcutDefinitions.filter(item => simplePanelShortcuts.has(item.id));
  const pinnedCard = $("#simple-pinned-card");
  pinnedCard.hidden = pinned.length === 0;
  $("#simple-pinned-count").textContent = `${pinned.length} selected`;
  $("#simple-pinned-actions").innerHTML = pinned.map(item =>
    `<button class="secondary" type="button" data-simple-tool="panel:${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>`).join("");
  if (grid) grid.hidden = [...grid.children].every(card => card.hidden);
}

function runSimpleTool(tool) {
  if (tool.startsWith("panel:")) {
    const panelId = tool.slice(6);
    const panel = document.querySelector(`[data-panel-id="${CSS.escape(panelId)}"]`);
    if (!panel) return;
    const pages = (panel.dataset.pages || "during").split(/\s+/);
    const currentPage = document.body.dataset.workspacePage || "pre";
    showPanel(panel, pages.includes(currentPage) ? currentPage : pages[0]);
    return;
  }
  if (tool === "refresh") $("#refresh-button").click();
  else if (tool === "settings") openSettings();
  else if (tool === "health") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="performance"]'), document.body.dataset.workspacePage || "pre"); }
  else if (tool === "chat") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="chat"]'), "during"); }
  else if (tool === "controls") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="scenes"]'), "during"); }
  else if (tool === "audio") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="audio"]'), "during"); }
  else if (tool === "spotify") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="spotify"]'), "during"); }
  else if (tool === "ads") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="ads"]'), "during"); }
  else if (tool === "report") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="report"]'), "after"); }
  else if (tool === "clips") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="clips"]'), "after"); }
}

function renderSimpleCustomization() {
  const extraPinned = simplePanelShortcutDefinitions
    .filter(item => simplePanelShortcuts.has(item.id) && !["chat", "spotify", "ads"].includes(item.id))
    .map(item => ({ id: `panel:${item.id}`, label: item.label, detail: "Shortcut added from Advanced mode.", defaultEnabled: false }));
  $("#simple-customize-list").innerHTML = [...simpleFeatureDefinitions, ...extraPinned].map(feature => `
    <label class="simple-customize-row">
      <input type="checkbox" data-simple-feature="${feature.id}" ${feature.id.startsWith("panel:") ? "checked" : simpleFeaturePreferences[feature.id] ? "checked" : ""}>
      <span><strong>${escapeHtml(feature.label)}</strong><small>${escapeHtml(feature.detail)}</small></span>
    </label>`).join("");
}

function setSimpleSummary(model) {
  const summary = $("#simple-summary");
  if (!summary) return;
  summary.className = `simple-summary ${model.level || "neutral"}`;
  $("#simple-summary-icon").textContent = model.icon || "…";
  $("#simple-summary-question").textContent = model.question;
  $("#simple-summary-title").textContent = model.title;
  $("#simple-summary-detail").textContent = model.detail;
  $("#simple-status-list").innerHTML = (model.items || []).map(item =>
    simpleStatusItem(item.label, item.status, item.level)).join("");
  $("#simple-title-row").hidden = model.showTitle !== true;
  const action = $("#simple-primary-action");
  action.hidden = false;
  action.textContent = model.actionLabel || "Show details";
  action.dataset.action = model.action || "show-details";
  action.disabled = model.action === "waiting";
}

function getSimplePreStreamModel() {
  const preflight = state.preflight;
  const readiness = getReadinessAssessment();
  const internetStatus = state.performanceError ? "unavailable" : state.internet?.status || "checking";
  const internetLevel = readiness.internetReady ? "ready" : internetStatus === "offline" ? "critical" : "warning";
  const items = [
    { label: "OBS", status: preflight?.obsConnected ? "Connected" : "Not connected", level: preflight?.obsConnected ? "ready" : "warning" },
    { label: "Twitch", status: preflight?.twitchRewardsReady ? "Connected" : "Needs attention", level: preflight?.twitchRewardsReady ? "ready" : "warning" },
    { label: "Microphone", status: preflight?.microphoneReady ? "Ready" : "Needs attention", level: preflight?.microphoneReady ? "ready" : "warning" },
    { label: "Internet", status: readiness.internetReady ? "Healthy" : internetStatus === "checking" ? "Checking" : internetStatus === "unavailable" ? "Unavailable" : "Needs attention", level: internetLevel }
  ];

  if (!preflight) return {
    level: "neutral", icon: "…", question: "AM I READY TO STREAM?", title: "Checking your setup",
    detail: "John's Twitch Handler is checking the essentials for you.", items, action: "waiting", actionLabel: "Checking…", showTitle: true
  };
  if (readiness.ready) return {
    level: "healthy", icon: "✓", question: "AM I READY TO STREAM?", title: "READY TO STREAM",
    detail: "Everything looks good.", items, action: "start-session", actionLabel: "Start session", showTitle: true
  };

  let detail = "A few things need attention before you go live.";
  let action = "show-preflight";
  let actionLabel = "Review setup";
  if (!preflight.obsConnected) {
    detail = "OBS is not connected yet. I can take you to the connection step.";
    action = "open-settings";
    actionLabel = "Connect OBS";
  } else if (!preflight.twitchRewardsReady) {
    detail = "Twitch needs to be connected so chat, alerts, and viewer actions can work.";
    action = "open-settings";
    actionLabel = "Connect Twitch";
  } else if (!preflight.microphoneReady) {
    detail = "Your microphone is not ready in OBS.";
    action = "check-microphone";
    actionLabel = "Check microphone";
  } else if (!preflight.nvidiaBroadcast?.running) {
    detail = "NVIDIA Broadcast is not running yet.";
    action = "launch-nvidia";
    actionLabel = "Open NVIDIA Broadcast";
  } else if (!readiness.internetReady) {
    detail = internetStatus === "checking" ? "Waiting for the first internet health check." : "Your internet connection needs attention before streaming.";
    action = internetStatus === "checking" ? "waiting" : "show-health";
    actionLabel = internetStatus === "checking" ? "Checking…" : "Review connection";
  }
  return { level: internetStatus === "offline" ? "critical" : "warning", icon: "!", question: "AM I READY TO STREAM?", title: "NOT READY YET", detail, items, action, actionLabel, showTitle: true };
}

function getSimpleDuringModel() {
  if (state.performanceError) return {
    level: "warning", icon: "!", question: "IS EVERYTHING OKAY?", title: "HEALTH UNAVAILABLE",
    detail: state.performanceError, items: [], action: "show-health", actionLabel: "Review connection"
  };
  const current = state.system?.current;
  if (!current) return {
    level: "neutral", icon: "…", question: "IS EVERYTHING OKAY?", title: "Checking stream health",
    detail: "I am collecting enough information to give you a clear answer.", items: [], action: "waiting", actionLabel: "Checking…"
  };
  const cpu = Number(current.cpuPercent) || 0;
  const gpu = Number(current.gpuPercent) || 0;
  const renderMissed = Number(state.obs?.renderSkippedPercent) || 0;
  const encoderMissed = Number(state.obs?.outputSkippedPercent) || 0;
  const congestion = Number(state.obs?.outputCongestion) || 0;
  const internetStatus = state.internet?.status || "checking";
  const internetProblem = internetStatus === "offline" || internetStatus === "unstable" || congestion >= .1;
  const microphoneReady = Boolean(state.preflight?.microphoneReady);
  const severe = !state.obs?.connected || Math.max(cpu, gpu) >= 95 || renderMissed >= 1 || encoderMissed >= 1 || internetProblem;
  const limited = severe || !microphoneReady || Math.max(cpu, gpu) >= 85 || renderMissed >= .25 || congestion > .02 || internetStatus === "slow";
  const obsHealthy = state.obs?.connected && renderMissed < .25 && encoderMissed < 1;
  const items = [
    { label: "OBS", status: !state.obs?.connected ? "Not connected" : obsHealthy ? "Healthy" : "Under pressure", level: !state.obs?.connected ? "warning" : obsHealthy ? "ready" : "warning" },
    { label: "Microphone", status: state.preflight?.microphoneReady ? "Ready" : "Needs attention", level: state.preflight?.microphoneReady ? "ready" : "warning" },
    { label: "Internet", status: internetStatus === "healthy" ? "Healthy" : internetStatus === "checking" ? "Checking" : "Needs attention", level: internetStatus === "healthy" ? "ready" : internetStatus === "offline" ? "critical" : "warning" },
    { label: "Computer", status: Math.max(cpu, gpu) < 85 ? "Healthy" : "Under pressure", level: Math.max(cpu, gpu) < 85 ? "ready" : severe ? "critical" : "warning" }
  ];
  if (!state.sessionActive) return {
    level: "neutral", icon: "■", question: "IS EVERYTHING OKAY?", title: "STREAM NOT ACTIVE",
    detail: "Start a tracked session when you are ready to go live.", items, action: "start-session", actionLabel: "Start session"
  };
  if (!limited) return {
    level: "healthy", icon: "✓", question: "IS EVERYTHING OKAY?", title: "STREAM HEALTHY",
    detail: "Everything looks good.", items, action: "show-chat", actionLabel: "Open chat & activity"
  };

  let detail = "OBS is beginning to struggle. Open the recommended fix to see what is causing it.";
  if (!state.obs?.connected) detail = "OBS isn't responding. Reconnect it before continuing the stream.";
  else if (!microphoneReady) detail = "Your microphone needs attention before you continue.";
  else if (internetProblem) detail = "Your connection appears to be the likely cause. Your computer is still rendering normally.";
  else if (gpu >= cpu && (gpu >= 85 || renderMissed >= .25)) detail = "Your GPU appears to be the likely cause of the rendering pressure.";
  else if (cpu >= 85) detail = "Your processor appears to be the likely cause of the performance pressure.";
  else if (encoderMissed >= 1) detail = "OBS is having trouble encoding frames, but your current stream remains connected.";
  return {
    level: severe ? "critical" : "warning", icon: "!", question: "IS EVERYTHING OKAY?",
    title: severe ? "STREAM PERFORMANCE NEEDS ATTENTION" : "PERFORMANCE PRESSURE DETECTED",
    detail, items, action: "show-health", actionLabel: "Fix it"
  };
}

function getSimpleAfterModel() {
  const report = state.report;
  if (!report) return {
    level: "neutral", icon: "…", question: "HOW DID MY STREAM GO?", title: "No stream report yet",
    detail: "End a tracked session or load your latest report to see the plain-English summary.", items: [], action: "load-report", actionLabel: "Load latest report"
  };
  const issues = (report.timeline || []).filter(item => item.severity === "warning" || item.severity === "critical");
  const healthy = issues.length === 0;
  const items = [
    { label: "Stream time", status: `${Math.round(report.durationMinutes || 0)} minutes`, level: "ready" },
    { label: "Highlights", status: `${report.highlightCount || 0} saved`, level: "ready" },
    { label: "Issues", status: issues.length ? `${issues.length} detected` : "None detected", level: healthy ? "ready" : "warning" },
    { label: "Scenes", status: `${report.sceneChangeCount || 0} changes`, level: "ready" }
  ];
  return {
    level: healthy ? "healthy" : "warning", icon: healthy ? "✓" : "!", question: "HOW DID MY STREAM GO?",
    title: healthy ? "YOUR STREAM LOOKED GOOD" : `YOU HAD ${issues.length} ${issues.length === 1 ? "ISSUE" : "ISSUES"}`,
    detail: report.performanceSummary || (healthy ? "Everything looked good." : "Review the recommendation before your next stream."),
    items, action: "show-report", actionLabel: "Review report"
  };
}

function renderSimpleExperience() {
  const page = document.body.dataset.workspacePage || "pre";
  const model = page === "during" ? getSimpleDuringModel() : page === "after" ? getSimpleAfterModel() : getSimplePreStreamModel();
  setSimpleSummary(model);
  $("#simple-primary-action").hidden = page === "during" && model.action === "show-health";
  renderSimpleTools(page);
  renderDuringStatusStrip(page, model);
}

function renderDuringStatusStrip(page, model = getSimpleDuringModel()) {
  const strip = $("#live-status-strip");
  if (!strip) return;
  strip.hidden = page !== "during";
  if (page !== "during") return;
  const level = model.level === "critical" ? "critical" : model.level === "warning" ? "warning" : model.level === "healthy" ? "healthy" : "neutral";
  const title = model.title === "HEALTH UNAVAILABLE" ? "HEALTH UNAVAILABLE" : level === "critical" ? "STREAM AT RISK" : level === "warning" ? "PERFORMANCE PRESSURE" : level === "healthy" ? "STREAM HEALTHY" : model.title === "STREAM NOT ACTIVE" ? "STREAM NOT ACTIVE" : "CHECKING STREAM";
  strip.className = `live-status-strip ${level}`;
  $("#live-status-symbol").textContent = level === "critical" || level === "warning" ? "▲" : level === "healthy" ? "●" : "■";
  $("#live-status-title").textContent = title;
  $("#live-status-detail").textContent = model.detail || "Checking OBS, system load, and internet.";
  const startedAt = state.report?.startedAt ? new Date(state.report.startedAt).valueOf() : NaN;
  $("#live-status-time").textContent = state.sessionActive && Number.isFinite(startedAt)
    ? formatOffset(Math.max(0, (Date.now() - startedAt) / 1000))
    : state.sessionActive ? "TRACKING" : "NOT TRACKING";
  $("#live-status-fix").textContent = model.title === "HEALTH UNAVAILABLE" ? "Review connection" : "Fix It";
  $("#live-status-fix").hidden = level !== "critical" && level !== "warning";
}

async function runSimplePrimaryAction() {
  const action = $("#simple-primary-action").dataset.action;
  if (action === "open-settings") openSettings();
  else if (action === "check-microphone") $("#unmute-microphone").click();
  else if (action === "launch-nvidia") $("#launch-nvidia").click();
  else if (action === "start-session") $("#session-toggle").click();
  else if (action === "load-report") { await refreshReport(true); renderSimpleExperience(); }
  else if (action === "show-report") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="report"]'), "after"); }
  else if (action === "show-controls") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="scenes"]'), "during"); }
  else if (action === "show-chat") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="chat"]'), "during"); }
  else if (action === "show-health") { setSimpleDetails(true); showPanel(document.querySelector('[data-panel-id="performance"]'), document.body.dataset.workspacePage || "during"); }
  else if (action === "show-preflight" || action === "show-details") setSimpleDetails(true);
}

function initializeWorkspaceNavigation() {
  const saved = localStorage.getItem(workspaceStorageKey);
  setActiveWorkspace(Object.hasOwn(workspacePages, saved) ? saved : "pre", { persist: false });
  $$('[data-workspace-page]').forEach(button => button.addEventListener("click", () => {
    setActiveWorkspace(button.dataset.workspacePage, { focus: true, announce: true });
  }));
}

function captureDefaultPanelPages() {
  $$(".dashboard-grid > .panel").forEach(panel => {
    panel.dataset.defaultPages = panel.dataset.pages || "during";
  });
}

function applyPanelPages(savedPages = {}) {
  $$(".dashboard-grid > .panel").forEach(panel => {
    const configured = Array.isArray(savedPages?.[panel.dataset.panelId])
      ? savedPages[panel.dataset.panelId].filter(page => Object.hasOwn(workspacePages, page))
      : [];
    panel.dataset.pages = (configured.length ? configured : panel.dataset.defaultPages.split(/\s+/)).join(" ");
  });
}

function currentPanelPages() {
  return Object.fromEntries($$(".dashboard-grid > .panel").map(panel => [
    panel.dataset.panelId,
    (panel.dataset.pages || panel.dataset.defaultPages || "during").split(/\s+/).filter(Boolean)
  ]));
}

function renderPageAssignmentList() {
  const list = $("#page-assignment-list");
  const labels = { pre: "Pre-stream", during: "During stream", after: "After stream" };
  list.innerHTML = $$(".dashboard-grid > .panel:not([hidden])").map(panel => {
    const panelName = panel.querySelector(".panel-heading h3")?.textContent || panel.dataset.panelId;
    const assigned = new Set((panel.dataset.pages || "during").split(/\s+/));
    const choices = Object.keys(labels).map(page => `<label title="Show ${escapeHtml(panelName)} on ${labels[page]}">
      <input type="checkbox" data-panel-page-id="${escapeHtml(panel.dataset.panelId)}" data-panel-page="${page}" ${assigned.has(page) ? "checked" : ""} aria-label="${escapeHtml(panelName)} on ${labels[page]}">
    </label>`).join("");
    return `<div class="page-assignment-row"><strong title="${escapeHtml(panelName)}">${escapeHtml(panelName)}</strong>${choices}</div>`;
  }).join("");
}

function setActiveWorkspace(page, options = {}) {
  const selected = Object.hasOwn(workspacePages, page) ? page : "pre";
  const definition = workspacePages[selected];
  document.body.dataset.workspacePage = selected;
  applyDefaultPanelSizes(selected);

  $$('[data-workspace-page]').forEach(button => {
    const active = button.dataset.workspacePage === selected;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  $("#workspace-page-title").textContent = definition.title;
  $("#workspace-page-summary").textContent = definition.summary;
  $("#broadcast-command-strip").hidden = selected !== "during";
  $(".preflight-strip").hidden = selected !== "pre";
  $$(".dashboard-grid > .panel").forEach(panel => {
    const pages = (panel.dataset.pages || "during").split(/\s+/);
    panel.classList.toggle("workspace-hidden", !pages.includes(selected));
  });
  renderPanelTabGroups();
  clearDropIndicators();

  if (options.persist !== false) localStorage.setItem(workspaceStorageKey, selected);
  if (options.focus) $("#workspace-main").focus({ preventScroll: true });
  if (options.announce) toast(`${definition.title} workspace opened.`);
  if (document.body.dataset.userMode === "simple") {
    document.body.classList.remove("simple-details-open");
    $("#simple-details-toggle").textContent = "Show details";
  }
  renderSimpleExperience();
}

function showPanel(panel, preferredPage = null) {
  if (!panel) return;
  if (panel.classList.contains("workspace-hidden")) {
    const pages = (panel.dataset.pages || "during").split(/\s+/);
    setActiveWorkspace(pages.includes(preferredPage) ? preferredPage : pages[0], { persist: true });
  }
  // A control may target a panel that is currently behind another panel in a docked tab stack.
  // Bring that panel forward before scrolling so the action always reveals what it promised.
  const tabGroup = panelTabGroups.find(group => group.panels.includes(panel.dataset.panelId));
  if (tabGroup) {
    tabGroup.active = panel.dataset.panelId;
    savePanelTabGroups();
    renderPanelTabGroups();
  }
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
}

const themes = {
  midnight: "#090b10",
  ocean: "#061017",
  forest: "#07100c",
  ember: "#120a08",
  slate: "#0b0e12"
};
const themeLabels = {
  midnight: "Midnight",
  ocean: "Ocean",
  forest: "Forest",
  ember: "Ember",
  slate: "Slate"
};
const visualStyleLabels = {
  broadcast: "Broadcast",
  vibe: "Vibe",
  tactical: "Tactical"
};

function renderAppearanceControls() {
  const visualStyle = Object.hasOwn(visualStyleLabels, document.body.dataset.visualStyle)
    ? document.body.dataset.visualStyle
    : "broadcast";
  const selectedTheme = Object.hasOwn(themes, document.documentElement.dataset.theme)
    ? document.documentElement.dataset.theme
    : "ocean";
  $("#appearance-button").textContent = `Appearance · ${visualStyleLabels[visualStyle]}`;
  $$('[data-visual-style-option]').forEach(button => {
    const active = button.dataset.visualStyleOption === visualStyle;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $$('[data-theme-option]').forEach(button => {
    const active = button.dataset.themeOption === selectedTheme;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function initializeVisualStyle() {
  const saved = localStorage.getItem(visualStyleStorageKey);
  applyVisualStyle(Object.hasOwn(visualStyleLabels, saved) ? saved : "broadcast", false);
  $("#appearance-button").addEventListener("click", () => {
    renderAppearanceControls();
    $("#appearance-dialog").showModal();
  });
  $$('[data-visual-style-option]').forEach(button => button.addEventListener("click", () => {
    applyVisualStyle(button.dataset.visualStyleOption, true);
  }));
}

function applyVisualStyle(style, persist) {
  const selected = Object.hasOwn(visualStyleLabels, style) ? style : "broadcast";
  document.body.dataset.visualStyle = selected;
  renderAppearanceControls();
  if (persist) {
    localStorage.setItem(visualStyleStorageKey, selected);
    toast(`${visualStyleLabels[selected]} ${selected === "vibe" ? "Dashboard" : "Console"} selected.`);
  }
}

function initializeTheme() {
  const saved = localStorage.getItem(themeStorageKey);
  applyTheme(Object.hasOwn(themes, saved) ? saved : "ocean", false);
  $$('[data-theme-option]').forEach(button => button.addEventListener("click", () => {
    applyTheme(button.dataset.themeOption, true);
  }));
}

function applyTheme(theme, persist) {
  const selected = Object.hasOwn(themes, theme) ? theme : "ocean";
  document.documentElement.dataset.theme = selected;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themes[selected]);
  renderAppearanceControls();
  if (persist) {
    localStorage.setItem(themeStorageKey, selected);
    toast(`${themeLabels[selected]} theme selected.`);
  }
}

// --- Movable dashboard cards -----------------------------------------------------------------

async function initializeMovablePanels() {
  const grid = $(".dashboard-grid");
  captureDefaultPanelPages();
  const savedLayout = await readSavedDashboardLayout();
  let savedOrder = savedLayout.panelOrder;
  const collapsedPanels = readCollapsedPanels();
  const panelSizes = readPanelSizes();
  const floatingPanels = readFloatingPanels();
  const hasSavedLayout = savedOrder.length > 0 || Object.keys(savedLayout.panelPages).length > 0
    || Object.keys(panelSizes).length > 0 || Object.keys(floatingPanels).length > 0
    || collapsedPanels.size > 0 || localStorage.getItem(panelTabGroupsStorageKey) !== null;
  // Existing installations opt in with Reset layout; an update must not rearrange a working desk.
  useRecommendedPanelLayout = localStorage.getItem(defaultLayoutStorageKey) === "true" || !hasSavedLayout;
  if (useRecommendedPanelLayout) localStorage.setItem(defaultLayoutStorageKey, "true");
  if (savedOrder.length && !savedOrder.includes("audio")) {
    const scenesIndex = savedOrder.indexOf("scenes");
    savedOrder.splice(scenesIndex >= 0 ? scenesIndex + 1 : savedOrder.length, 0, "audio");
  }
  applyPanelOrder(savedOrder.length ? savedOrder : defaultPanelOrder);
  applyPanelPages(savedLayout.panelPages);
  // Migrate browser-only layouts and page assignments into the durable app store.
  savePanelOrder();

  applyDefaultPanelSizes(document.body.dataset.workspacePage || "pre");
  $$(".dashboard-grid > .panel").forEach(panel => {
    const heading = panel.querySelector(".panel-heading");
    const panelName = heading.querySelector("h3")?.textContent || "dashboard card";
    // Keep every existing heading control together so the collapse button can be added consistently
    // without changing the markup or behavior of each individual dashboard card.
    let headingActions = heading.querySelector(":scope > .panel-heading-actions");
    if (!headingActions) {
      headingActions = document.createElement("div");
      headingActions.className = "panel-heading-actions";
      [...heading.children].slice(1).forEach(child => headingActions.append(child));
      heading.append(headingActions);
    }
    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.className = "panel-collapse-button";
    const simpleShortcut = simplePanelShortcutDefinitions.find(item => item.id === panel.dataset.panelId);
    const simpleButton = simpleShortcut ? document.createElement("button") : null;
    if (simpleButton) {
      simpleButton.type = "button";
      simpleButton.className = "panel-simple-button";
      simpleButton.dataset.simplePanelShortcut = panel.dataset.panelId;
      simpleButton.title = `Show ${simpleShortcut.label} in Simple mode`;
      headingActions.append(simpleButton);
    }
    const floatButton = document.createElement("button");
    floatButton.type = "button";
    floatButton.className = "panel-float-button";
    headingActions.append(floatButton);
    headingActions.append(collapseButton);
    setPanelCollapsed(panel, collapsedPanels.has(panel.dataset.panelId), collapseButton, panelName);
    applyPanelSize(panel, panelSizes[panel.dataset.panelId]);
    addPanelResizeHandle(panel, panelName, grid);
    setPanelFloating(panel, Boolean(floatingPanels[panel.dataset.panelId]), floatButton, panelName, floatingPanels[panel.dataset.panelId]);

    simpleButton?.addEventListener("click", event => {
      event.stopPropagation();
      setSimplePanelShortcut(panel.dataset.panelId, !simplePanelShortcuts.has(panel.dataset.panelId));
    });

    collapseButton.addEventListener("click", event => {
      event.stopPropagation();
      const collapsed = !panel.classList.contains("collapsed");
      setPanelCollapsed(panel, collapsed, collapseButton, panelName);
      saveCollapsedPanels();
      toast(`${panelName} ${collapsed ? "collapsed" : "expanded"}.`);
    });

    floatButton.addEventListener("click", event => {
      event.stopPropagation();
      const floating = !panel.classList.contains("floating");
      if (floating) removePanelFromTabGroup(panel.dataset.panelId);
      setPanelFloating(panel, floating, floatButton, panelName);
      saveFloatingPanels();
      toast(`${panelName} ${floating ? "is floating. Drag its heading to move it." : "redocked in the workspace."}`);
    });

    panel.draggable = !panel.classList.contains("floating");
    heading.tabIndex = 0;
    heading.setAttribute("role", "button");
    heading.setAttribute("aria-label", `Move ${panelName}`);
    heading.title = "Drag to rearrange. Drop over another panel's center to stack as tabs.";

    heading.addEventListener("pointerdown", event => {
      if (panel.classList.contains("floating") && !event.target.closest("button, a, input, label")) {
        panel.dataset.dragArmed = "false";
        startFloatingPanelDrag(event, panel);
        return;
      }
      panel.dataset.dragArmed = event.target.closest("button, a, input, label") ? "false" : "true";
    });

    heading.addEventListener("keydown", event => {
      if (!event.altKey || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      if (panel.classList.contains("floating")) {
        const step = event.shiftKey ? 40 : 10;
        const left = Number.parseFloat(panel.style.left) || 8;
        const top = Number.parseFloat(panel.style.top) || 8;
        panel.style.left = `${Math.max(8, left + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0))}px`;
        panel.style.top = `${Math.max(8, top + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0))}px`;
        saveFloatingPanels();
        return;
      }
      const panels = $$(".dashboard-grid > .panel:not(.workspace-hidden):not(.game-profile-hidden)");
      const target = nearestPanelInDirection(panel, panels, event.key);
      if (!target) return;
      // Swap the two cards rather than inserting across the intervening items. This preserves both
      // positions when cards have different saved widths and heights.
      const marker = document.createComment("dashboard-card-swap");
      panel.replaceWith(marker);
      target.replaceWith(panel);
      marker.replaceWith(target);
      savePanelOrder();
      heading.focus();
      toast(`Moved ${heading.querySelector("h3")?.textContent || "card"} ${event.key.replace("Arrow", "").toLowerCase()}.`);
    });

    panel.addEventListener("dragstart", event => {
      if (event.target.closest("[data-panel-tab]")) return;
      if (document.body.dataset.userMode === "simple" && !document.body.classList.contains("simple-details-open")) {
        event.preventDefault();
        return;
      }
      if (panel.dataset.dragArmed !== "true") {
        event.preventDefault();
        return;
      }
      draggedPanel = panel;
      panel.classList.add("dragging");
      panel.setAttribute("aria-grabbed", "true");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", panel.dataset.panelId);
    });

    panel.addEventListener("dragend", event => {
      if (event.target.closest("[data-panel-tab]")) return;
      panel.classList.remove("dragging");
      panel.setAttribute("aria-grabbed", "false");
      panel.dataset.dragArmed = "false";
      pendingTabTarget = null;
      clearDropIndicators();
      if (draggedPanel) savePanelOrder();
      draggedPanel = null;
    });
  });

  updateSimplePanelShortcutButtons();
  initializePanelTabGroups();

  grid.addEventListener("dragover", event => {
    if (!draggedPanel) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const target = event.target.closest(".panel");
    if (!target || !grid.contains(target)) {
      pendingTabTarget = null;
      clearDropIndicators();
      return;
    }
    if (target === draggedPanel) return;
    // Floating panels are intentionally outside the dock grid. They must be docked before another
    // panel can be placed beside or behind them, otherwise the result would look successful but
    // have no visible tab stack.
    if (target.classList.contains("floating")) {
      pendingTabTarget = null;
      clearDropIndicators();
      return;
    }
    const rect = target.getBoundingClientRect();
    // Heading-to-heading is the natural OBS gesture, so nearly the entire panel is a stack target.
    // Only the thin outer edge remains reserved for ordinary before/after rearranging.
    const overTabZone = event.clientX > rect.left + Math.min(44, rect.width * .12)
      && event.clientX < rect.right - Math.min(44, rect.width * .12)
      && event.clientY > rect.top + 12
      && event.clientY < rect.bottom - 12;
    if (overTabZone && canStackPanels(draggedPanel, target)) {
      clearDropIndicators();
      pendingTabTarget = target;
      target.classList.add("drop-stack");
      return;
    }
    pendingTabTarget = null;
    const after = event.clientY > rect.top + rect.height / 2;
    clearDropIndicators();
    target.classList.add(after ? "drop-after" : "drop-before");
    if (after) target.after(draggedPanel);
    else target.before(draggedPanel);
  });

  grid.addEventListener("drop", event => {
    if (!draggedPanel) return;
    event.preventDefault();
    const panel = draggedPanel;
    if (pendingTabTarget && pendingTabTarget !== panel) {
      stackPanelsAsTabs(panel, pendingTabTarget);
      pendingTabTarget = null;
    }
    savePanelOrder();
    clearDropIndicators();
  });

  $("#reset-layout").addEventListener("click", () => $("#reset-layout-dialog").showModal());
  $("#confirm-reset-layout").addEventListener("click", async () => {
    const button = $("#confirm-reset-layout");
    button.disabled = true;
    try {
      const saved = await restoreDefaultPanelLayout();
      $("#reset-layout-dialog").close();
      toast(saved === false
        ? "Defaults restored in this browser, but the Handler could not save the layout. Please try Reset layout again."
        : "Default panel positions, sizes, and spacing restored. Your connections and settings are unchanged.", saved === false);
    } finally { button.disabled = false; }
  });

  window.addEventListener("pagehide", () => {
    const panelOrder = currentPanelOrder();
    const panelPages = currentPanelPages();
    localStorage.setItem(layoutStorageKey, JSON.stringify(panelOrder));
    localStorage.setItem(panelPagesStorageKey, JSON.stringify(panelPages));
    saveFloatingPanels();
    savePanelTabGroups();
    (window.HandlerConnection?.fetch || fetch)("/api/dashboard-layout", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ panelOrder, panelPages }),
      keepalive: true
    }).catch(() => {});
  });
}

function applyDefaultPanelSizes(page) {
  const grid = $(".dashboard-grid");
  grid.classList.toggle("recommended-layout", useRecommendedPanelLayout);
  if (!useRecommendedPanelLayout) return;
  $$(".dashboard-grid > .panel").forEach(panel => HandlerPanelLayout.applySize(panel, page));
}

function restoreDefaultPanelLayout() {
  useRecommendedPanelLayout = true;
  localStorage.setItem(defaultLayoutStorageKey, "true");
  applyPanelOrder(defaultPanelOrder);
  applyPanelPages({});
  $$(".dashboard-grid > .panel").forEach(panel => {
    const heading = panel.querySelector(".panel-heading");
    const name = heading.querySelector("h3")?.textContent || "dashboard card";
    setPanelCollapsed(panel, false, heading.querySelector(".panel-collapse-button"), name);
    panel.removeAttribute("data-panel-span");
    panel.removeAttribute("data-panel-height");
    panel.style.removeProperty("--panel-span");
    panel.style.removeProperty("--panel-height");
    setPanelFloating(panel, false, heading.querySelector(".panel-float-button"), name);
  });
  panelTabGroups = [];
  [collapsedPanelsStorageKey, panelSizesStorageKey, floatingPanelsStorageKey, panelTabGroupsStorageKey]
    .forEach(key => localStorage.removeItem(key));
  // Reapply page visibility after restoring assignments, including optional panels that stay disabled.
  setActiveWorkspace(document.body.dataset.workspacePage || "pre", { persist: false });
  return savePanelOrder();
}

function nearestPanelInDirection(panel, panels, key) {
  const source = panel.getBoundingClientRect();
  const sourceX = source.left + source.width / 2;
  const sourceY = source.top + source.height / 2;
  const vertical = key === "ArrowUp" || key === "ArrowDown";
  const sign = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
  return panels
    .filter(candidate => candidate !== panel)
    .map(candidate => {
      const rect = candidate.getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - sourceX;
      const dy = rect.top + rect.height / 2 - sourceY;
      const primary = vertical ? dy : dx;
      const secondary = vertical ? dx : dy;
      return { candidate, primary, score: Math.abs(primary) + Math.abs(secondary) * .35 };
    })
    .filter(item => Math.sign(item.primary) === sign && Math.abs(item.primary) > 8)
    .sort((left, right) => left.score - right.score)[0]?.candidate || null;
}

function readFloatingPanels() {
  try {
    const value = JSON.parse(localStorage.getItem(floatingPanelsStorageKey) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function saveFloatingPanels() {
  const floating = {};
  $$(".dashboard-grid > .panel.floating").forEach(panel => {
    const rect = panel.getBoundingClientRect();
    floating[panel.dataset.panelId] = {
      left: Math.round(rect.left), top: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height)
    };
  });
  localStorage.setItem(floatingPanelsStorageKey, JSON.stringify(floating));
}

function setPanelFloating(panel, floating, button, panelName, saved = null) {
  panel.classList.toggle("floating", floating);
  panel.draggable = !floating;
  button.textContent = floating ? "Dock" : "Float";
  button.setAttribute("aria-label", `${floating ? "Redock" : "Float"} ${panelName}`);
  button.title = floating ? "Return this panel to the workspace" : "Undock this panel into a movable window";
  if (!floating) {
    ["left", "top", "width", "height", "zIndex"].forEach(property => panel.style.removeProperty(property.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)));
    return;
  }

  const fallbackWidth = Math.min(620, Math.max(360, window.innerWidth * .42));
  const fallbackHeight = Math.min(620, Math.max(260, window.innerHeight * .55));
  const width = Math.min(window.innerWidth - 16, Math.max(320, Number(saved?.width) || fallbackWidth));
  const height = Math.min(window.innerHeight - 16, Math.max(220, Number(saved?.height) || fallbackHeight));
  panel.style.width = `${width}px`;
  panel.style.height = `${height}px`;
  panel.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, Number(saved?.left) || 80))}px`;
  panel.style.top = `${Math.min(window.innerHeight - height - 8, Math.max(8, Number(saved?.top) || 90))}px`;
  bringFloatingPanelToFront(panel);
}

function bringFloatingPanelToFront(panel) {
  floatingPanelZ += 1;
  panel.style.zIndex = String(floatingPanelZ);
}

function startFloatingPanelDrag(event, panel) {
  if (event.button !== 0) return;
  event.preventDefault();
  bringFloatingPanelToFront(panel);
  const rect = panel.getBoundingClientRect();
  const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, pointerId: event.pointerId };
  const heading = event.currentTarget;
  heading.setPointerCapture(event.pointerId);

  const move = moveEvent => {
    if (moveEvent.pointerId !== start.pointerId) return;
    const maxLeft = Math.max(8, window.innerWidth - panel.getBoundingClientRect().width - 8);
    const maxTop = Math.max(8, window.innerHeight - 46);
    panel.style.left = `${Math.min(maxLeft, Math.max(8, start.left + moveEvent.clientX - start.x))}px`;
    panel.style.top = `${Math.min(maxTop, Math.max(8, start.top + moveEvent.clientY - start.y))}px`;
  };
  const finish = finishEvent => {
    if (finishEvent.pointerId !== start.pointerId) return;
    heading.removeEventListener("pointermove", move);
    heading.removeEventListener("pointerup", finish);
    heading.removeEventListener("pointercancel", finish);
    saveFloatingPanels();
  };
  heading.addEventListener("pointermove", move);
  heading.addEventListener("pointerup", finish);
  heading.addEventListener("pointercancel", finish);
}

function readPanelTabGroups() {
  try {
    const value = JSON.parse(localStorage.getItem(panelTabGroupsStorageKey) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function savePanelTabGroups() {
  localStorage.setItem(panelTabGroupsStorageKey, JSON.stringify(panelTabGroups));
}

function initializePanelTabGroups() {
  const known = new Set($$(".dashboard-grid > .panel").map(panel => panel.dataset.panelId));
  panelTabGroups = readPanelTabGroups().map(group => ({
    id: typeof group.id === "string" ? group.id : `tabs-${Date.now()}`,
    panels: [...new Set((group.panels || []).filter(id => known.has(id)))],
    active: known.has(group.active) ? group.active : null
  })).filter(group => group.panels.length >= 2);
  renderPanelTabGroups();
}

function removePanelFromTabGroup(panelId) {
  let changed = false;
  panelTabGroups = panelTabGroups.flatMap(group => {
    if (!group.panels.includes(panelId)) return [group];
    changed = true;
    const panels = group.panels.filter(id => id !== panelId);
    return panels.length >= 2 ? [{ ...group, panels, active: group.active === panelId ? panels[0] : group.active }] : [];
  });
  if (changed) {
    renderPanelTabGroups();
    savePanelTabGroups();
  }
}

function canStackPanels(source, target) {
  if (!source?.dataset.panelId || !target?.dataset.panelId || source === target) return false;
  if (source.classList.contains("floating") || target.classList.contains("floating")) return false;
  if (source.classList.contains("workspace-hidden") || target.classList.contains("workspace-hidden")) return false;
  if (panelTabGroups.some(group => group.panels.includes(source.dataset.panelId) && group.panels.includes(target.dataset.panelId))) return false;
  const page = document.body.dataset.workspacePage || "pre";
  const sourcePages = (source.dataset.pages || "during").split(/\s+/);
  const targetPages = (target.dataset.pages || "during").split(/\s+/);
  return sourcePages.includes(page) && targetPages.includes(page);
}

function detachPanelFromTabStack(panel, floatAfterDetach) {
  const panelId = panel?.dataset.panelId;
  if (!panelId || !panelTabGroups.some(group => group.panels.includes(panelId))) return false;
  removePanelFromTabGroup(panelId);
  if (floatAfterDetach) {
    const heading = panel.querySelector(".panel-heading");
    setPanelFloating(
      panel,
      true,
      heading.querySelector(".panel-float-button"),
      heading.querySelector("h3")?.textContent || "dashboard panel"
    );
    saveFloatingPanels();
  }
  flashPanelConfirmation(panel, "unstack-confirmed");
  savePanelOrder();
  toast(floatAfterDetach ? "Tab unstacked into a floating panel." : "Tab unstacked into its own panel.");
  return true;
}

function addTabPullGesture(button, panelId) {
  button.addEventListener("pointerdown", downEvent => {
    if (downEvent.button !== 0) return;
    const panel = document.querySelector(`[data-panel-id="${CSS.escape(panelId)}"]`);
    if (!panel || !panelTabGroups.some(group => group.panels.includes(panelId))) return;
    const grid = $(".dashboard-grid");
    const pull = { pointerId: downEvent.pointerId, x: downEvent.clientX, y: downEvent.clientY, moved: false, ghost: null };
    button.setPointerCapture(downEvent.pointerId);

    const move = event => {
      if (event.pointerId !== pull.pointerId) return;
      if (!pull.moved && Math.hypot(event.clientX - pull.x, event.clientY - pull.y) < 10) return;
      event.preventDefault();
      pull.moved = true;
      if (!pull.ghost) {
        pull.ghost = document.createElement("div");
        pull.ghost.className = "panel-tab-drag-ghost";
        pull.ghost.textContent = button.textContent;
        document.body.append(pull.ghost);
      }
      pull.ghost.style.left = `${event.clientX + 12}px`;
      pull.ghost.style.top = `${event.clientY + 12}px`;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const target = hit?.closest(".panel");
      clearDropIndicators();
      if (target && canStackPanels(panel, target)) target.classList.add("drop-stack");
      else grid.classList.add("drop-unstack");
    };

    const cleanup = () => {
      button.removeEventListener("pointermove", move);
      button.removeEventListener("pointerup", finish);
      button.removeEventListener("pointercancel", cancel);
      pull.ghost?.remove();
      clearDropIndicators();
    };
    const finish = event => {
      if (event.pointerId !== pull.pointerId) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const target = hit?.closest(".panel");
      const floatAfterDetach = !grid.contains(hit);
      cleanup();
      if (!pull.moved) return;
      event.preventDefault();
      if (target && canStackPanels(panel, target)) stackPanelsAsTabs(panel, target);
      else detachPanelFromTabStack(panel, floatAfterDetach);
    };
    const cancel = event => {
      if (event.pointerId === pull.pointerId) cleanup();
    };
    button.addEventListener("pointermove", move);
    button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", cancel);
  });
}

function stackPanelsAsTabs(source, target) {
  if (!canStackPanels(source, target)) return false;
  const sourceId = source.dataset.panelId;
  const targetId = target.dataset.panelId;

  // A panel belongs to one tab stack at a time. Pulling it into a new stack leaves any remaining
  // panels in their existing group and keeps their selected tab intact.
  panelTabGroups = panelTabGroups.flatMap(group => {
    if (!group.panels.includes(sourceId)) return [group];
    const panels = group.panels.filter(id => id !== sourceId);
    return panels.length >= 2 ? [{ ...group, panels, active: group.active === sourceId ? panels[0] : group.active }] : [];
  });
  let group = panelTabGroups.find(candidate => candidate.panels.includes(targetId));
  if (group) {
    group.panels = [...group.panels.filter(id => id !== sourceId), sourceId];
    group.active = sourceId;
  } else {
    group = { id: `tabs-${Date.now()}-${Math.random().toString(16).slice(2)}`, panels: [targetId, sourceId], active: sourceId };
    panelTabGroups.push(group);
  }
  target.after(source);
  renderPanelTabGroups();
  savePanelTabGroups();
  flashPanelConfirmation(source, "stack-confirmed");
  toast("Stack created. Use the tabs at the top to switch panels.");
  return true;
}

function flashPanelConfirmation(panel, className) {
  panel.classList.remove("stack-confirmed", "unstack-confirmed");
  // Restart the short confirmation animation even when panels are stacked repeatedly.
  window.requestAnimationFrame(() => {
    panel.classList.add(className);
    window.setTimeout(() => panel.classList.remove(className), 1800);
  });
}

function renderPanelTabGroups() {
  $$(".panel-tab-bar").forEach(bar => bar.remove());
  $$(".dashboard-grid > .panel").forEach(panel => {
    panel.classList.remove("tab-hidden");
    delete panel.dataset.tabGroup;
  });
  const page = document.body.dataset.workspacePage || localStorage.getItem(workspaceStorageKey) || "pre";
  panelTabGroups.forEach(group => {
    const panels = group.panels
      .map(id => document.querySelector(`[data-panel-id="${CSS.escape(id)}"]`))
      .filter(panel => panel && !panel.classList.contains("floating"));
    panels.forEach(panel => { panel.dataset.tabGroup = group.id; });
    const visible = panels.filter(panel => (panel.dataset.pages || "during").split(/\s+/).includes(page));
    if (visible.length < 2) return;
    const simplePinned = document.body.dataset.userMode === "simple" && !document.body.classList.contains("simple-details-open")
      ? visible.find(panel => panel.classList.contains("simple-pinned"))
      : null;
    const active = simplePinned || visible.find(panel => panel.dataset.panelId === group.active) || visible[0];
    group.active = active.dataset.panelId;
    visible.forEach(panel => panel.classList.toggle("tab-hidden", panel !== active));

    const bar = document.createElement("div");
    bar.className = "panel-tab-bar";
    bar.setAttribute("role", "tablist");
    bar.setAttribute("aria-label", "Stacked dashboard panels");
    bar.innerHTML = visible.map(panel => {
      const name = panel.querySelector(".panel-heading h3")?.textContent || panel.dataset.panelId;
      const selected = panel === active;
      return `<button type="button" role="tab" data-panel-tab="${escapeHtml(panel.dataset.panelId)}" aria-selected="${selected}" class="${selected ? "active" : ""}" title="Select this tab, or drag it away to unstack it">${escapeHtml(name)}</button>`;
    }).join("") + `<button type="button" class="panel-unstack-button" data-unstack-panel="${escapeHtml(active.dataset.panelId)}" title="Move this tab back into its own panel">Unstack</button>`;
    bar.addEventListener("click", event => {
      const unstack = event.target.closest("[data-unstack-panel]");
      if (unstack) {
        const panel = document.querySelector(`[data-panel-id="${CSS.escape(unstack.dataset.unstackPanel)}"]`);
        detachPanelFromTabStack(panel, false);
        return;
      }
      const button = event.target.closest("[data-panel-tab]");
      if (!button) return;
      group.active = button.dataset.panelTab;
      renderPanelTabGroups();
      savePanelTabGroups();
    });
    bar.querySelectorAll("[data-panel-tab]").forEach(button => addTabPullGesture(button, button.dataset.panelTab));
    active.prepend(bar);
  });
}

function addPanelResizeHandle(panel, panelName, grid) {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "panel-resize-handle";
  handle.textContent = "◢";
  handle.setAttribute("aria-label", `Resize ${panelName}`);
  handle.title = "Drag to resize. Arrow keys resize while this handle is focused.";
  panel.append(handle);

  let resize = null;
  handle.addEventListener("pointerdown", event => {
    if ((window.innerWidth <= 800 && !panel.classList.contains("floating")) || panel.classList.contains("collapsed")) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = panel.getBoundingClientRect();
    if (panel.classList.contains("floating")) {
      bringFloatingPanelToFront(panel);
      resize = { mode: "floating", pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
      panel.classList.add("resizing");
      handle.setPointerCapture(event.pointerId);
      return;
    }
    const gridStyle = getComputedStyle(grid);
    const gap = Number.parseFloat(gridStyle.columnGap) || 0;
    const columnWidth = (grid.getBoundingClientRect().width - gap * 11) / 12;
    resize = { mode: "docked", pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, gap, columnWidth };
    panel.classList.add("resizing");
    panel.draggable = false;
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener("pointermove", event => {
    if (!resize || event.pointerId !== resize.pointerId) return;
    if (resize.mode === "floating") {
      panel.style.width = `${Math.min(window.innerWidth - panel.getBoundingClientRect().left - 8, Math.max(320, resize.width + event.clientX - resize.x))}px`;
      panel.style.height = `${Math.min(window.innerHeight - panel.getBoundingClientRect().top - 8, Math.max(220, resize.height + event.clientY - resize.y))}px`;
      return;
    }
    const width = Math.max(resize.columnWidth * 3, resize.width + event.clientX - resize.x);
    const span = Math.max(3, Math.min(12, Math.round((width + resize.gap) / (resize.columnWidth + resize.gap))));
    const height = Math.max(180, Math.round(resize.height + event.clientY - resize.y));
    setPanelSize(panel, span, height);
  });

  const finishResize = event => {
    if (!resize || event.pointerId !== resize.pointerId) return;
    const mode = resize.mode;
    resize = null;
    panel.classList.remove("resizing");
    panel.draggable = !panel.classList.contains("floating");
    if (mode === "floating") saveFloatingPanels();
    else savePanelSizes();
  };
  handle.addEventListener("pointerup", finishResize);
  handle.addEventListener("pointercancel", finishResize);
  handle.addEventListener("keydown", event => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    if (panel.classList.contains("floating")) {
      const rect = panel.getBoundingClientRect();
      panel.style.width = `${Math.max(320, rect.width + (event.key === "ArrowRight" ? 30 : event.key === "ArrowLeft" ? -30 : 0))}px`;
      panel.style.height = `${Math.max(220, rect.height + (event.key === "ArrowDown" ? 30 : event.key === "ArrowUp" ? -30 : 0))}px`;
      saveFloatingPanels();
      return;
    }
    const span = Number(panel.dataset.panelSpan || panel.dataset.panelDefaultSpan || 6);
    const height = Number(panel.dataset.panelHeight || Math.round(panel.getBoundingClientRect().height));
    setPanelSize(
      panel,
      Math.max(3, Math.min(12, span + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0))),
      Math.max(180, height + (event.key === "ArrowDown" ? 40 : event.key === "ArrowUp" ? -40 : 0))
    );
    savePanelSizes();
  });
}

function setPanelSize(panel, span, height) {
  panel.dataset.panelSpan = String(span);
  panel.dataset.panelHeight = String(height);
  panel.style.setProperty("--panel-span", span);
  panel.style.setProperty("--panel-height", `${height}px`);
}

function applyPanelSize(panel, size) {
  if (!size) return;
  const span = Math.max(3, Math.min(12, Number(size.span) || 6));
  const height = Math.max(180, Math.min(2400, Number(size.height) || 180));
  setPanelSize(panel, span, height);
}

function readPanelSizes() {
  try {
    const sizes = JSON.parse(localStorage.getItem(panelSizesStorageKey) || "{}");
    return sizes && typeof sizes === "object" && !Array.isArray(sizes) ? sizes : {};
  } catch {
    return {};
  }
}

function savePanelSizes() {
  const sizes = {};
  $$(".dashboard-grid > .panel").forEach(panel => {
    if (!panel.dataset.panelSpan || !panel.dataset.panelHeight) return;
    sizes[panel.dataset.panelId] = {
      span: Number(panel.dataset.panelSpan),
      height: Number(panel.dataset.panelHeight)
    };
  });
  localStorage.setItem(panelSizesStorageKey, JSON.stringify(sizes));
}

function readCollapsedPanels() {
  try {
    const value = JSON.parse(localStorage.getItem(collapsedPanelsStorageKey) || "[]");
    return new Set(Array.isArray(value) ? value.filter(id => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedPanels() {
  // Collapse preferences are specific to this browser display, unlike the shared durable card order.
  const collapsed = $$(".dashboard-grid > .panel.collapsed").map(panel => panel.dataset.panelId);
  localStorage.setItem(collapsedPanelsStorageKey, JSON.stringify(collapsed));
}

function setPanelCollapsed(panel, collapsed, button, panelName) {
  panel.classList.toggle("collapsed", collapsed);
  button.textContent = collapsed ? "+" : "−";
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${panelName}`);
  button.title = `${collapsed ? "Expand" : "Collapse"} ${panelName}`;
}

function readLocalPanelOrder() {
  try {
    const value = JSON.parse(localStorage.getItem(layoutStorageKey) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function readLocalPanelPages() {
  try {
    const value = JSON.parse(localStorage.getItem(panelPagesStorageKey) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function readSavedDashboardLayout() {
  const localOrder = readLocalPanelOrder();
  const localPages = readLocalPanelPages();
  try {
    const saved = await api("/api/dashboard-layout");
    const panelOrder = Array.isArray(saved?.panelOrder) && saved.panelOrder.length
      ? saved.panelOrder
      : localOrder;
    const panelPages = saved?.panelPages && Object.keys(saved.panelPages).length
      ? saved.panelPages
      : localPages;
    return { panelOrder, panelPages };
  } catch {
    return { panelOrder: localOrder, panelPages: localPages };
  }
}

function applyPanelOrder(order) {
  const grid = $(".dashboard-grid");
  const panels = new Map($$(".dashboard-grid > .panel").map(panel => [panel.dataset.panelId, panel]));
  order.forEach(id => { if (panels.has(id)) grid.append(panels.get(id)); });
  defaultPanelOrder.forEach(id => { if (panels.has(id) && !order.includes(id)) grid.append(panels.get(id)); });
}

function savePanelOrder() {
  const order = currentPanelOrder();
  const panelPages = currentPanelPages();
  localStorage.setItem(layoutStorageKey, JSON.stringify(order));
  localStorage.setItem(panelPagesStorageKey, JSON.stringify(panelPages));
  // Serialize writes so rapid keyboard/drag moves cannot arrive at the server out of order.
  layoutSaveChain = layoutSaveChain
    .catch(() => {})
    .then(() => api("/api/dashboard-layout", {
      method: "PUT",
      body: JSON.stringify({ panelOrder: order, panelPages })
    }))
    .catch(error => {
      console.warn("Dashboard layout could not be saved to the app store.", error);
      return false;
    });
  return layoutSaveChain;
}

function currentPanelOrder() {
  return $$(".dashboard-grid > .panel").map(panel => panel.dataset.panelId);
}

function clearDropIndicators() {
  $$(".dashboard-grid > .panel").forEach(panel => panel.classList.remove("drop-before", "drop-after", "drop-stack"));
  $(".dashboard-grid")?.classList.remove("drop-unstack");
}

async function loadWowAddons(refresh = false) {
  try {
    state.wow = await api(`/api/wow/addons${refresh ? "?refresh=true" : ""}`);
    const select = $("#wow-edition");
    select.innerHTML = state.wow.editions.map(edition =>
      `<option value="${escapeHtml(edition.id)}">${escapeHtml(edition.name)}</option>`
    ).join("");
    if (!state.wow.editions.some(edition => edition.id === state.wowEditionId)) {
      state.wowEditionId = state.wow.editions[0]?.id || "";
    }
    select.value = state.wowEditionId;
    renderWowEdition();
  } catch (error) {
    $("#wow-addon-list").className = "wow-addon-list empty-state";
    $("#wow-addon-list").textContent = error.message;
  }
}

// --- World of Warcraft addon and encounter tools --------------------------------------------

async function loadAddonPresets() {
  try {
    state.wowPresets = await api("/api/wow/addon-presets");
    renderAddonPresets();
  } catch (error) {
    state.wowPresets = [];
    toast(error.message, true);
  }
}

function renderAddonPresets() {
  const select = $("#wow-addon-preset");
  const presets = (state.wowPresets || []).filter(preset => preset.editionId === state.wowEditionId);
  const previous = select.value;
  select.innerHTML = presets.length
    ? presets.map(preset => `<option value="${escapeHtml(preset.name)}">${escapeHtml(preset.name)} · ${preset.enabledCount} on</option>`).join("")
    : '<option value="">No saved presets</option>';
  if (presets.some(preset => preset.name === previous)) select.value = previous;
  const available = Boolean(select.value && state.wowProfileId);
  $("#apply-addon-preset").disabled = !available || Boolean(state.wow?.gameRunning);
  $("#delete-addon-preset").disabled = !select.value;
  $("#save-addon-preset").disabled = !state.wowProfileId;
}

function renderWowEdition() {
  const edition = state.wow?.editions?.find(item => item.id === state.wowEditionId);
  if (!edition) {
    $("#wow-addon-list").textContent = "No WoW AddOns folder was found.";
    return;
  }

  $("#wow-addon-count").textContent = edition.addonFolderCount;
  $("#wow-addon-size").textContent = `${Math.round(edition.totalAddonSizeMb)} MB`;
  $("#wow-profile-age").textContent = edition.profileCapturedAt ? timeAgo(edition.profileCapturedAt) : "No data";
  $("#install-wow-profiler").textContent = edition.profilerInstalled ? "Update profiler addon" : "Install profiler addon";
  const hasRuntimeData = edition.addons.some(addon => addon.recentAverageMs != null);
  $("#addon-metric-heading").textContent = hasRuntimeData ? "Recent / peak CPU" : "Disk / saved data";
  $("#wow-profiler-help").textContent = hasRuntimeData
    ? "Profiler data is ranked by recent average execution time. A large peak or repeated 10ms+ spikes is more suspicious than folder size."
    : "Install the companion, play normally, then type /ssp followed by /reload. John's Twitch Handler will rank addons by recent and peak execution time.";

  const profileSelect = $("#wow-character-profile");
  profileSelect.innerHTML = edition.characterProfiles?.length
    ? edition.characterProfiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.character)} · ${escapeHtml(profile.realm)} (${profile.enabledCount} on)</option>`).join("")
    : '<option value="">No character profiles found</option>';
  if (!edition.characterProfiles?.some(profile => profile.id === state.wowProfileId)) {
    state.wowProfileId = edition.characterProfiles?.[0]?.id || "";
  }
  profileSelect.value = state.wowProfileId;
  profileSelect.disabled = !edition.characterProfiles?.length;
  const selectedProfile = edition.characterProfiles?.find(profile => profile.id === state.wowProfileId);
  renderAddonPresets();

  const relevantInsights = (state.wow.insights || []).filter(insight => insight.startsWith(`${edition.name}:`));
  $("#wow-insights").innerHTML = relevantInsights.map(insight =>
    `<div class="wow-insight">${escapeHtml(insight.replace(`${edition.name}: `, ""))}</div>`
  ).join("");

  const addons = edition.addons.slice(0, 16);
  const list = $("#wow-addon-list");
  list.className = "wow-addon-list";
  list.innerHTML = addons.map(addon => {
    const runtime = addon.recentAverageMs != null;
    const recent = Number(addon.recentAverageMs || 0);
    const costClass = runtime ? (recent >= 2 ? "hot" : recent >= .5 ? "warn" : "") : "";
    const primary = runtime ? `${recent.toFixed(3)} ms` : `${Number(addon.folderSizeMb).toFixed(1)} MB`;
    const secondary = runtime
      ? `peak ${Number(addon.peakMs || 0).toFixed(1)} ms · ${addon.spikesOver10Ms || 0} spikes >10ms`
      : `${Number(addon.savedVariablesSizeMb).toFixed(1)} MB saved data`;
    const enabled = selectedProfile?.addonStates?.[addon.folderName];
    const toggle = selectedProfile
      ? `<button class="addon-toggle ${enabled === false ? "disabled" : "enabled"}" data-addon-toggle="${escapeHtml(addon.folderName)}" data-enabled="${enabled !== false}" ${state.wow.gameRunning ? "disabled" : ""}>${enabled === false ? "Disabled" : "Enabled"}</button>`
      : "";
    return `<div class="addon-row">
      <div class="addon-copy"><strong>${escapeHtml(addon.title)}</strong><small>${escapeHtml(addon.folderName)}${addon.version ? ` · ${escapeHtml(addon.version)}` : ""}</small></div>
      <div class="addon-cost ${costClass}"><strong>${primary}</strong><small>${secondary}</small></div>
      ${toggle}
    </div>`;
  }).join("");
}

async function refreshWowEvents() {
  try {
    state.wowEvents = await api("/api/wow/events");
    renderWowEvents();
  } catch (error) {
    $("#wow-events-state").textContent = "Unavailable";
    $("#wow-events-status").textContent = error.message;
  }
}

function renderWowEvents() {
  const snapshot = state.wowEvents;
  if (!snapshot) return;
  $("#wow-events-state").textContent = snapshot.combatLogFound ? "Watching" : "Setup needed";
  $("#auto-mark-bosses").checked = snapshot.autoMarkBossKills;
  $("#auto-save-boss-replay").checked = snapshot.autoSaveReplay;
  $("#auto-tangia-boss-focus").checked = snapshot.autoTangiaBossFocus;
  $("#auto-save-boss-replay").disabled = !snapshot.autoMarkBossKills;
  const status = $("#wow-events-status");
  status.textContent = snapshot.status;
  status.classList.toggle("alert", !snapshot.combatLogFound);
  const verification = $("#boss-focus-verification");
  verification.textContent = snapshot.bossFocusTestStatus;
  verification.classList.toggle("alert", /failed/i.test(snapshot.bossFocusTestStatus));
  verification.classList.toggle("success", snapshot.bossFocusTestsRemaining === 0 && !/failed/i.test(snapshot.bossFocusTestStatus));
  const list = $("#wow-event-list");
  if (!snapshot.recentEvents?.length) {
    list.className = "wow-event-list empty-state";
    list.textContent = "Boss pulls and victories will appear here.";
    return;
  }
  list.className = "wow-event-list";
  list.innerHTML = snapshot.recentEvents.map(event => {
    const victory = event.type === "encounter-end" && event.success === true;
    const result = event.type === "encounter-start" ? "Pull started" : victory ? "Victory marked" : "Encounter ended";
    return `<div class="wow-event-row"><span class="wow-event-icon">${victory ? "✓" : event.type === "encounter-start" ? "▶" : "×"}</span><div><strong>${escapeHtml(event.title)}</strong><small>${result}</small></div><time>${formatAlertTime(event.at)}</time></div>`;
  }).join("");
}

async function saveWowEventOptions() {
  try {
    state.wowEvents = await api("/api/wow/events", {
      method: "PUT",
      body: JSON.stringify({
        autoMarkBossKills: $("#auto-mark-bosses").checked,
        autoSaveReplay: $("#auto-save-boss-replay").checked,
        autoTangiaBossFocus: $("#auto-tangia-boss-focus").checked
      })
    });
    renderWowEvents();
  } catch (error) { toast(error.message, true); }
}

function timeAgo(value) {
  const seconds = Math.max(0, (Date.now() - new Date(value).valueOf()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function switchScene(sceneName) {
  try {
    await api("/api/obs/scene", { method: "POST", body: JSON.stringify({ sceneName }) });
    state.obs.currentScene = sceneName;
    renderObs();
    toast(`Switched to ${sceneName}`);
  } catch (error) { toast(error.message, true); }
}

async function addMarker(title = null, kind = "clip", options = {}) {
  const markerTitle = title || $("#marker-title").value.trim() || "Highlight";
  try {
    const result = await api("/api/markers", {
      method: "POST",
      body: JSON.stringify({
        title: markerTitle,
        kind,
        saveReplay: options.saveReplay ?? $("#save-replay").checked,
        createTwitchClip: options.createTwitchClip ?? $("#create-twitch-clip").checked
      })
    });
    $("#marker-title").value = "";
    const suffix = result.warnings?.length ? ` ${result.warnings.join(" ")}` : "";
    const message = result.marker.twitchClipId
      ? `Clip created: ${result.marker.title}. It is ready for StreamLadder.`
      : `Marked: ${result.marker.title}.`;
    toast(`${message}${suffix}`, result.warnings?.length > 0);
    await refreshReport(false);
    await refreshPreflight();
  } catch (error) { toast(error.message, true); }
}

async function addFpsMarker(eventType) {
  if (state.gameProfile !== "fps") return;
  if (!state.sessionActive) {
    toast("Start a tracked session before marking kills or deaths.", true);
    return;
  }
  const isKill = eventType === "kill";
  const kind = isKill ? "fps-kill" : "fps-death";
  const existingCount = (state.report?.markers || []).filter(marker => marker.kind === kind).length;
  await addMarker(`${isKill ? "Kill" : "Death"} #${existingCount + 1}`, kind);
}

async function toggleSession() {
  try {
    if (state.sessionActive) {
      await endTrackedSession(false);
      return;
    } else {
      await refreshPreflight();
      const missing = [];
      if (!state.preflight.obsConnected) missing.push("OBS is not connected");
      if (!state.preflight.microphoneReady) missing.push("the OBS microphone is not ready");
      if (!state.preflight.nvidiaBroadcast.running) missing.push("NVIDIA Broadcast is not running");
      const uncheckedManualItems = state.manualPreflightItems.filter(item => !item.checked).map(item => item.label);
      if (uncheckedManualItems.length) missing.push(`manual reminders are not checked: ${uncheckedManualItems.join(", ")}`);
      if (missing.length && !window.confirm(`${missing.join(" and ")}. Start the session anyway?`)) return;
      const session = await api("/api/session/start", {
        method: "POST",
        body: JSON.stringify({ title: $("#stream-title").value.trim() })
      });
      state.sessionActive = true;
      state.report = { id: session.id, title: session.title, startedAt: session.startedAt, durationMinutes: 0, highlightCount: 0, sceneChangeCount: 0, markers: [], wardogs: session.wardogs || null };
      // Starting a show moves the interface from setup tools to the live control workspace.
      setActiveWorkspace("during", { persist: true });
      toast("Session tracking started.");
    }
    renderSession();
    await refreshPreflight();
  } catch (error) { toast(error.message, true); }
}

async function endTrackedSession(automatic) {
  if (state.autoEndingSession || !state.sessionActive) return;
  state.autoEndingSession = true;
  try {
    const report = await api("/api/session/end", { method: "POST" });
    state.sessionActive = false;
    // Manual reminders are reusable definitions, but completion belongs to one show. Reset them
    // after the report is created so the next stream cannot inherit stale green checkmarks.
    state.manualPreflightItems = state.manualPreflightItems.map(item => ({ ...item, checked: false }));
    saveManualPreflightItems();
    renderManualPreflightItems();
    renderReport(report);
    await refreshStreamHistory();
    renderSession();
    await refreshPreflight();
    toast(automatic ? "OBS ended the stream. Your post-stream report is ready." : "Session finished. Your report is ready.");
    // Ending a session should immediately surface the review workflow even if the report card
    // was previously collapsed or moved farther down the dashboard.
    window.setTimeout(revealPostStreamReport, 100);
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.autoEndingSession = false;
  }
}

async function refreshReport(latest = false) {
  try {
    const report = await api(latest ? "/api/reports/latest" : "/api/session");
    if (report) renderReport(report);
  } catch (error) {
    if (!latest) return;
    toast(error.message, true);
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}
function formatOffset(seconds) {
  const whole = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

// --- Chat commands, raids, and viewer notes -------------------------------------------------

async function refreshChatCommands() {
  try {
    state.chatCommands = await api("/api/chat-commands");
    renderChatCommands();
  } catch (error) {
    $("#commands-state").textContent = "Unavailable";
    $("#command-list").textContent = error.message;
  }
}

function renderChatCommands() {
  const list = $("#command-list");
  const connection = state.preflight?.twitchConnected ? "ready" : "Twitch offline";
  $("#commands-state").textContent = `${state.chatCommands.length} custom + 2 built-in · ${connection}`;
  if (!state.chatCommands.length) {
    list.className = "managed-list empty-state";
    list.textContent = "No custom commands yet. !song and !playing are already available.";
    return;
  }
  list.className = "managed-list";
  list.innerHTML = state.chatCommands.map(command => `
    <div class="managed-row ${command.enabled ? "" : "disabled"}">
      <div><strong>${escapeHtml(command.command)}</strong><small>${escapeHtml(command.response)} · ${command.cooldownSeconds}s cooldown</small></div>
      <div class="row-actions"><button class="text-button" data-command-edit="${escapeHtml(command.command)}">Edit</button><button class="text-button danger" data-command-delete="${escapeHtml(command.command)}">Delete</button></div>
    </div>`).join("");
}

function resetCommandEditor() {
  $("#command-name").value = "";
  $("#command-name").disabled = false;
  $("#command-response").value = "";
  $("#command-cooldown").value = "15";
  $("#command-enabled").checked = true;
  $("#cancel-command-edit").hidden = true;
}

async function saveChatCommand() {
  try {
    await api("/api/chat-commands", {
      method: "PUT",
      body: JSON.stringify({
        command: $("#command-name").value.trim(),
        response: $("#command-response").value.trim(),
        enabled: $("#command-enabled").checked,
        cooldownSeconds: Number($("#command-cooldown").value)
      })
    });
    resetCommandEditor();
    await refreshChatCommands();
    toast("Chat command saved.");
  } catch (error) { toast(error.message, true); }
}

async function refreshAutomations() {
  try {
    state.automations = await api("/api/automations");
    renderAutomations();
  } catch (error) {
    $("#automations-state").textContent = "Unavailable";
    $("#automation-list").textContent = error.message;
  }
}

function automationActionLabel(action) {
  return ({ "chat-message": "Twitch message", "switch-scene": "OBS scene", marker: "Stream marker" })[action] || action;
}

function renderAutomations() {
  const list = $("#automation-list");
  const enabled = state.automations.filter(item => item.enabled).length;
  $("#automations-state").textContent = `${enabled} enabled · local only`;
  if (!state.automations.length) {
    list.className = "managed-list empty-state";
    list.textContent = "No automations yet. Add a manual action or repeating session reminder.";
    return;
  }
  list.className = "managed-list";
  list.innerHTML = state.automations.map(item => {
    const trigger = item.triggerType === "interval" ? `Every ${item.intervalMinutes} minutes during a session` : "Manual trigger";
    const lastRun = item.lastRunAt ? `${timeAgo(item.lastRunAt)} · ${item.lastResult}` : item.lastResult;
    return `<div class="managed-row ${item.enabled ? "" : "disabled"}">
      <div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(trigger)} · ${escapeHtml(automationActionLabel(item.actionType))}</small><small>${escapeHtml(lastRun || "Not run yet")}</small></div>
      <div class="row-actions"><button class="secondary" data-automation-run="${item.id}">Run</button><button class="text-button" data-automation-edit="${item.id}">Edit</button><button class="text-button danger" data-automation-delete="${item.id}">Delete</button></div>
    </div>`;
  }).join("");
}

function resetAutomationEditor() {
  $("#automation-id").value = "";
  $("#automation-name").value = "";
  $("#automation-trigger").value = "manual";
  $("#automation-interval").value = "30";
  $("#automation-action").value = "chat-message";
  $("#automation-value").value = "";
  $("#automation-enabled").checked = true;
  $("#automation-interval-label").hidden = true;
  $("#cancel-automation-edit").hidden = true;
}

async function saveAutomation() {
  try {
    const id = $("#automation-id").value;
    await api("/api/automations", {
      method: "PUT",
      body: JSON.stringify({
        id: id || null,
        name: $("#automation-name").value.trim(),
        enabled: $("#automation-enabled").checked,
        triggerType: $("#automation-trigger").value,
        intervalMinutes: Number($("#automation-interval").value),
        actionType: $("#automation-action").value,
        value: $("#automation-value").value.trim()
      })
    });
    resetAutomationEditor();
    await refreshAutomations();
    toast("Automation saved locally.");
  } catch (error) { toast(error.message, true); }
}

async function refreshRaids(refresh = false) {
  try {
    state.raids = await api(`/api/raids?refresh=${refresh}&days=${state.raidDays}`);
    renderRaids();
  } catch (error) {
    state.raids = { channels: [], history: [], warning: error.message };
    renderRaids();
  }
}

function renderRaids() {
  const list = $("#raid-list");
  const warning = $("#raid-warning");
  warning.hidden = !state.raids.warning;
  warning.textContent = state.raids.warning || "";
  const channels = state.raids.channels || [];
  const timeline = $("#raid-timeline");
  const history = state.raids.history || [];
  $("#raid-timeline-summary").textContent = `${history.length} event${history.length === 1 ? "" : "s"} in ${state.raidDays === 7 ? "1 week" : state.raidDays === 14 ? "2 weeks" : "1 month"}`;
  if (!history.length) {
    timeline.className = "raid-timeline empty-state";
    timeline.textContent = "No raids recorded in this period.";
  } else {
    timeline.className = "raid-timeline";
    timeline.innerHTML = history.map(event => `<div class="raid-event ${escapeHtml(event.direction)}">
      <span class="raid-event-icon">${event.direction === "incoming" ? "↓" : "↑"}</span>
      <div><strong>${event.direction === "incoming" ? `${escapeHtml(event.displayName)} raided you` : `You raided ${escapeHtml(event.displayName)}`}</strong>${event.detail ? `<small>${escapeHtml(event.detail)}</small>` : ""}</div>
      <time>${formatAlertTime(event.at)}<br>${new Date(event.at).toLocaleDateString()}</time>
    </div>`).join("");
  }
  if (!channels.length) {
    list.className = "managed-list empty-state";
    list.textContent = "Add channels you may want to raid. Incoming raiders will also appear automatically.";
    return;
  }
  list.className = "managed-list";
  list.innerHTML = channels.map(channel => {
    const relationship = [
      channel.lastRaidedAt ? `You raided ${timeAgo(channel.lastRaidedAt)}` : null,
      channel.lastRaidedYouAt ? `Raided you ${timeAgo(channel.lastRaidedYouAt)}` : null
    ].filter(Boolean).join(" · ") || "No raid history yet";
    const liveDetail = channel.isLive
      ? `${channel.gameName || "Live"} · ${channel.viewerCount ?? 0} viewers${channel.streamTitle ? ` · ${channel.streamTitle}` : ""}`
      : relationship;
    return `<div class="managed-row raid-row ${channel.isLive ? "live" : ""}">
      <span class="live-dot" aria-label="${channel.isLive ? "Live" : "Offline"}"></span>
      <div><strong><a href="https://twitch.tv/${encodeURIComponent(channel.channelName)}" target="_blank" rel="noreferrer">${escapeHtml(channel.displayName || channel.channelName)} ↗</a></strong><small>${escapeHtml(liveDetail)}</small>${channel.isLive ? `<small>${escapeHtml(relationship)}</small>` : ""}</div>
      <div class="row-actions"><button class="secondary" data-raid-mark="${escapeHtml(channel.channelName)}">Mark raided</button><button class="text-button danger" data-raid-delete="${escapeHtml(channel.channelName)}">Remove</button></div>
    </div>`;
  }).join("");
}

async function refreshViewerNotes() {
  try {
    state.viewerNotes = await api("/api/viewer-notes");
    renderViewerNotes();
  } catch (error) {
    $("#viewer-note-list").textContent = error.message;
  }
}

function renderViewerNotes() {
  const list = $("#viewer-note-list");
  $("#viewers-state").textContent = `${state.viewerNotes.length} remembered · local only`;
  if (!state.viewerNotes.length) {
    list.className = "managed-list empty-state";
    list.textContent = "Regular viewers will appear here as they chat or interact.";
    return;
  }
  list.className = "managed-list";
  list.innerHTML = state.viewerNotes.map(viewer => `
    <div class="managed-row viewer-row">
      <div><strong>${escapeHtml(viewer.userName)}</strong><small>${escapeHtml(viewer.note || "No private note yet")}</small><small>Last seen ${timeAgo(viewer.lastSeenAt)} · ${escapeHtml(viewer.lastActivity)} · ${viewer.activityCount} interaction${viewer.activityCount === 1 ? "" : "s"}</small></div>
      <div class="row-actions"><button class="text-button" data-viewer-edit="${escapeHtml(viewer.userName)}">Edit</button><button class="text-button danger" data-viewer-delete="${escapeHtml(viewer.userName)}">Delete</button></div>
    </div>`).join("");
}

function resetViewerEditor() {
  $("#viewer-name").value = "";
  $("#viewer-name").disabled = false;
  $("#viewer-note").value = "";
  $("#cancel-viewer-edit").hidden = true;
}

async function saveViewerNote() {
  try {
    await api("/api/viewer-notes", {
      method: "PUT",
      body: JSON.stringify({ userName: $("#viewer-name").value.trim(), note: $("#viewer-note").value.trim() })
    });
    resetViewerEditor();
    await refreshViewerNotes();
    toast("Viewer note saved locally.");
  } catch (error) { toast(error.message, true); }
}

// --- User actions ----------------------------------------------------------------------------

async function refreshConnectionDiagnostics() {
  const list = $("#connection-diagnostics-list");
  try {
    const entries = await api("/api/diagnostics/connections");
    list.innerHTML = entries.length ? entries.map(entry => `
      <div class="connection-log-row ${escapeHtml(entry.level)}">
        <time>${escapeHtml(formatAlertTime(entry.at))}</time>
        <strong>${escapeHtml(entry.service)}</strong>
        <span>${escapeHtml(entry.message)}</span>
      </div>`).join("") : "No connection attempts have been logged yet.";
  } catch (error) {
    list.textContent = error.message;
  }
}

function openSettings() {
  $("#settings-dialog").showModal();
  refreshConnectionDiagnostics();
}

$("#settings-button").addEventListener("click", openSettings);
$("#explore-without-setup").addEventListener("click", () => {
  localStorage.setItem("streamsidekick.setupSeen", "true");
  $("#settings-dialog").close();
});
$$('[data-open-settings]').forEach(button => button.addEventListener("click", openSettings));
$("#customize-simple").addEventListener("click", () => {
  renderSimpleCustomization();
  $("#simple-customize-dialog").showModal();
});
$("#simple-customize-list").addEventListener("change", event => {
  const checkbox = event.target.closest("[data-simple-feature]");
  if (!checkbox) return;
  const featureId = checkbox.dataset.simpleFeature;
  if (featureId.startsWith("panel:")) {
    setSimplePanelShortcut(featureId.slice(6), checkbox.checked, false);
    renderSimpleCustomization();
    return;
  }
  simpleFeaturePreferences[featureId] = checkbox.checked;
  saveSimpleFeaturePreferences();
  if (["chat", "spotify", "ads"].includes(featureId)) setSimplePanelShortcut(featureId, checkbox.checked, false);
  renderSimpleExperience();
});
$("#reset-simple-customization").addEventListener("click", () => {
  simpleFeaturePreferences = Object.fromEntries(simpleFeatureDefinitions.map(feature => [feature.id, feature.defaultEnabled]));
  simplePanelShortcuts = new Set();
  saveSimpleFeaturePreferences();
  saveSimplePanelShortcuts();
  updateSimplePanelShortcutButtons();
  renderSimpleCustomization();
  renderSimpleExperience();
  toast("Recommended Simple mode restored.");
});
$("#customize-pages").addEventListener("click", () => {
  renderPageAssignmentList();
  $("#page-assignment-dialog").showModal();
});
$("#page-assignment-list").addEventListener("change", event => {
  const checkbox = event.target.closest("[data-panel-page-id]");
  if (!checkbox) return;
  const panelId = checkbox.dataset.panelPageId;
  const panel = document.querySelector(`[data-panel-id="${CSS.escape(panelId)}"]`);
  if (!panel) return;
  const checked = $$(`[data-panel-page-id="${CSS.escape(panelId)}"]:checked`);
  if (!checked.length) {
    checkbox.checked = true;
    toast("Every card must stay on at least one page.", true);
    return;
  }
  panel.dataset.pages = checked.map(input => input.dataset.panelPage).join(" ");
  savePanelOrder();
  setActiveWorkspace(document.body.dataset.workspacePage || "pre", { persist: false });
});
$("#reset-page-assignments").addEventListener("click", () => {
  applyPanelPages({});
  renderPageAssignmentList();
  savePanelOrder();
  setActiveWorkspace(document.body.dataset.workspacePage || "pre", { persist: false });
  toast("Recommended page assignments restored.");
});
$("#add-manual-preflight").addEventListener("click", addManualPreflightItem);
$("#manual-preflight-name").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); addManualPreflightItem(); }
});
$("#manual-preflight-items").addEventListener("change", event => {
  const checkbox = event.target.closest(".manual-preflight-checkbox");
  if (!checkbox) return;
  const row = checkbox.closest("[data-manual-preflight-id]");
  const item = state.manualPreflightItems.find(entry => entry.id === row?.dataset.manualPreflightId);
  if (!item) return;
  item.checked = checkbox.checked;
  saveManualPreflightItems();
  renderManualPreflightItems();
});
$("#manual-preflight-items").addEventListener("click", event => {
  const remove = event.target.closest(".manual-preflight-remove");
  if (!remove) return;
  event.preventDefault();
  event.stopPropagation();
  const row = remove.closest("[data-manual-preflight-id]");
  const item = state.manualPreflightItems.find(entry => entry.id === row?.dataset.manualPreflightId);
  state.manualPreflightItems = state.manualPreflightItems.filter(entry => entry.id !== row?.dataset.manualPreflightId);
  saveManualPreflightItems();
  renderManualPreflightItems();
  if (item) toast(`Removed “${item.label}” from Preflight.`);
});
$("#manage-preflight-visibility").addEventListener("click", () => {
  renderPreflightVisibilityList();
  $("#preflight-visibility-dialog").showModal();
});
$("#preflight-visibility-list").addEventListener("change", event => {
  const checkbox = event.target.closest("[data-preflight-visible]");
  if (!checkbox) return;
  if (checkbox.checked) hiddenPreflightRows.delete(checkbox.dataset.preflightVisible);
  else hiddenPreflightRows.add(checkbox.dataset.preflightVisible);
  savePreflightVisibility();
});
$("#reset-preflight-visibility").addEventListener("click", () => {
  hiddenPreflightRows.clear();
  savePreflightVisibility();
  renderPreflightVisibilityList();
  toast("All built-in Preflight fields are visible.");
});
$$('[data-integration-choice]').forEach(button => button.addEventListener("click", () =>
  setOptionalIntegration(button.dataset.integrationChoice, button.dataset.enabled === "true")));
$("#refresh-button").addEventListener("click", async () => { await Promise.all([refreshPreflight(), refreshObs(), refreshSpotify(), refreshTangia(), refreshStreamElements(), refreshTikFinity(), refreshAds()]); });
$$('[data-multistream-destination]').forEach(input => input.addEventListener("change", () => {
  const destinations = readMultistreamDestinations();
  destinations[input.dataset.multistreamDestination] = input.checked;
  localStorage.setItem(multistreamDestinationsKey, JSON.stringify(destinations));
  renderMultistreamPlan();
}));
$("#multistream-bitrate").addEventListener("change", event => {
  localStorage.setItem(multistreamBitrateKey, event.target.value);
  renderMultistreamPlan();
});
$("#streamelements-confirmed").addEventListener("change", async event => {
  state.streamElementsConfirmed = event.target.checked;
  localStorage.setItem("streamsidekick.streamElementsConfirmed", String(state.streamElementsConfirmed));
  renderStreamElements();
  await refreshPreflight();
});
$("#chat-popout").addEventListener("click", openGameChat);
$("#copy-chat-overlay").addEventListener("click", async () => {
  const url = `${window.HandlerConnection?.helperOrigin || window.location.origin}/chat-overlay.html`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Messages-only OBS chat URL copied.");
  } catch {
    window.prompt("Copy this OBS Browser Source URL:", url);
  }
});
$("#chat-chime-enabled").addEventListener("change", saveChatChime);
$("#chat-chime-volume").addEventListener("input", event => {
  $("#chat-chime-volume-value").textContent = `${Number(event.target.value).toFixed(0).replace("-", "−")} dB`;
});
$("#chat-chime-volume").addEventListener("change", saveChatChime);
$("#test-chat-chime").addEventListener("click", async () => {
  try {
    state.chatChime = await api("/api/chat-chime/test", { method: "POST" });
    await refreshChatChime();
    toast(state.chatChime.status, !state.chatChime.safeToPlay);
  } catch (error) { toast(error.message, true); }
});
$$("[data-scroll-panel]").forEach(button => button.addEventListener("click", () => {
  const panel = document.querySelector(`[data-panel-id="${CSS.escape(button.dataset.scrollPanel)}"]`);
  if (document.body.dataset.userMode === "simple") setSimpleDetails(true);
  showPanel(panel, "pre");
}));
$("#session-toggle").addEventListener("click", toggleSession);
$("#add-marker").addEventListener("click", () => addMarker());
$("#create-social-clip").addEventListener("click", () => addMarker(null, "clip", { createTwitchClip: true }));
$("#marker-title").addEventListener("keydown", event => { if (event.key === "Enter") addMarker(); });
$$('[data-marker]').forEach(button => button.addEventListener("click", () => addMarker(button.dataset.marker, button.dataset.kind)));
$$('[data-fps-marker]').forEach(button => button.addEventListener("click", () => addFpsMarker(button.dataset.fpsMarker)));
$("#save-wardogs-settings").addEventListener("click", saveWardogsSettings);
$("#capture-wardogs-baseline").addEventListener("click", captureWardogsBaseline);
$("#fetch-wardogs-results").addEventListener("click", fetchWardogsResults);
$("#unmute-microphone").addEventListener("click", async () => {
  const microphone = state.preflight?.microphone;
  if (!microphone?.connected) {
    openSettings();
    return;
  }
  if (!microphone.found) {
    showPanel(document.querySelector('[data-panel-id="audio"]'), "during");
    toast("No OBS microphone was recognized. Name the source Mic/Aux or include Mic in its name.", true);
    return;
  }
  try {
    await api("/api/obs/microphone/unmute", { method: "POST" });
    await Promise.all([refreshAudio(true), refreshPreflight()]);
    toast(`${microphone.sourceName || "Microphone"} unmuted in OBS.`);
  } catch (error) { toast(error.message, true); }
});
$("#load-latest").addEventListener("click", () => refreshReport(true));
$("#stream-history").addEventListener("click", event => {
  const button = event.target.closest("[data-open-report]");
  if (button) openSavedReport(button.dataset.openReport);
});
$("#post-stream-checklist").addEventListener("change", event => {
  if (!event.target.matches("[data-post-task]")) return;
  const key = event.currentTarget.dataset.storageKey;
  if (!key) return;
  const completed = [...event.currentTarget.querySelectorAll("[data-post-task]:checked")].map(input => input.dataset.postTask);
  localStorage.setItem(key, JSON.stringify(completed));
});
$("#clip-publishing-queue").addEventListener("change", event => {
  const input = event.target.closest("[data-clip-platform]");
  if (!input) return;
  const publishing = readClipPublishingState();
  publishing[input.dataset.clipId] = {
    ...(publishing[input.dataset.clipId] || {}),
    [input.dataset.clipPlatform]: input.checked
  };
  localStorage.setItem(clipPublishingStorageKey, JSON.stringify(publishing));
});
$("#clip-publishing-queue").addEventListener("click", async event => {
  const button = event.target.closest("[data-open-streamladder]");
  if (!button) return;
  const clipUrl = button.dataset.openStreamladder;
  // StreamLadder does not publish a direct integration API. Open its supported import workflow and
  // put the public Twitch clip URL on the clipboard so the only remaining step is Paste.
  window.open("https://app.streamladder.com/", "_blank", "noopener,noreferrer");
  try {
    await navigator.clipboard.writeText(clipUrl);
    toast("Clip link copied. Paste it into StreamLadder, then publish to TikTok or YouTube from its Content Publisher.");
  } catch {
    window.prompt("Copy this Twitch clip URL into StreamLadder:", clipUrl);
  }
});
$("#save-command").addEventListener("click", saveChatCommand);
$("#cancel-command-edit").addEventListener("click", resetCommandEditor);
$("#command-list").addEventListener("click", async event => {
  const edit = event.target.closest("[data-command-edit]");
  const remove = event.target.closest("[data-command-delete]");
  if (edit) {
    const command = state.chatCommands.find(item => item.command === edit.dataset.commandEdit);
    if (!command) return;
    $("#command-name").value = command.command;
    $("#command-name").disabled = true;
    $("#command-response").value = command.response;
    $("#command-cooldown").value = command.cooldownSeconds;
    $("#command-enabled").checked = command.enabled;
    $("#cancel-command-edit").hidden = false;
  } else if (remove && window.confirm(`Delete ${remove.dataset.commandDelete}?`)) {
    try {
      await api(`/api/chat-commands/${encodeURIComponent(remove.dataset.commandDelete)}`, { method: "DELETE" });
      await refreshChatCommands();
      toast("Chat command deleted.");
    } catch (error) { toast(error.message, true); }
  }
});
$("#automation-trigger").addEventListener("change", event => {
  $("#automation-interval-label").hidden = event.target.value !== "interval";
});
$("#save-automation").addEventListener("click", saveAutomation);
$("#cancel-automation-edit").addEventListener("click", resetAutomationEditor);
$("#automation-list").addEventListener("click", async event => {
  const run = event.target.closest("[data-automation-run]");
  const edit = event.target.closest("[data-automation-edit]");
  const remove = event.target.closest("[data-automation-delete]");
  const id = run?.dataset.automationRun || edit?.dataset.automationEdit || remove?.dataset.automationDelete;
  const item = state.automations.find(candidate => candidate.id === id);
  if (!item) return;
  if (edit) {
    $("#automation-id").value = item.id;
    $("#automation-name").value = item.name;
    $("#automation-trigger").value = item.triggerType;
    $("#automation-interval").value = item.intervalMinutes || 30;
    $("#automation-action").value = item.actionType;
    $("#automation-value").value = item.value;
    $("#automation-enabled").checked = item.enabled;
    $("#automation-interval-label").hidden = item.triggerType !== "interval";
    $("#cancel-automation-edit").hidden = false;
  } else if (run) {
    try {
      const result = await api(`/api/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
      await refreshAutomations();
      toast(`${item.name}: ${result.lastResult}`);
    } catch (error) { toast(error.message, true); }
  } else if (remove && window.confirm(`Delete ${item.name}?`)) {
    try {
      await api(`/api/automations/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refreshAutomations();
      toast("Automation deleted.");
    } catch (error) { toast(error.message, true); }
  }
});
$("#add-raid-channel").addEventListener("click", async () => {
  try {
    await api("/api/raids/suggested", { method: "POST", body: JSON.stringify({ channelName: $("#raid-channel").value.trim() }) });
    $("#raid-channel").value = "";
    await refreshRaids(true);
    toast("Raid channel added.");
  } catch (error) { toast(error.message, true); }
});
$("#refresh-raids").addEventListener("click", () => refreshRaids(true));
$("#raid-range").addEventListener("change", event => {
  state.raidDays = Number(event.target.value);
  localStorage.setItem("streamsidekick.raidDays", String(state.raidDays));
  refreshRaids(false);
});
$("#raid-list").addEventListener("click", async event => {
  const mark = event.target.closest("[data-raid-mark]");
  const remove = event.target.closest("[data-raid-delete]");
  try {
    if (mark) {
      await api("/api/raids/mark", { method: "POST", body: JSON.stringify({ channelName: mark.dataset.raidMark }) });
      await refreshRaids(false);
      toast(`Recorded raid to ${mark.dataset.raidMark}.`);
    } else if (remove && window.confirm(`Remove ${remove.dataset.raidDelete} from Raid Manager?`)) {
      await api(`/api/raids/${encodeURIComponent(remove.dataset.raidDelete)}`, { method: "DELETE" });
      await refreshRaids(false);
      toast("Raid channel removed.");
    }
  } catch (error) { toast(error.message, true); }
});
$("#save-viewer-note").addEventListener("click", saveViewerNote);
$("#cancel-viewer-edit").addEventListener("click", resetViewerEditor);
$("#viewer-note-list").addEventListener("click", async event => {
  const edit = event.target.closest("[data-viewer-edit]");
  const remove = event.target.closest("[data-viewer-delete]");
  if (edit) {
    const viewer = state.viewerNotes.find(item => item.userName === edit.dataset.viewerEdit);
    if (!viewer) return;
    $("#viewer-name").value = viewer.userName;
    $("#viewer-name").disabled = true;
    $("#viewer-note").value = viewer.note || "";
    $("#cancel-viewer-edit").hidden = false;
  } else if (remove && window.confirm(`Delete the local note for ${remove.dataset.viewerDelete}?`)) {
    try {
      await api(`/api/viewer-notes/${encodeURIComponent(remove.dataset.viewerDelete)}`, { method: "DELETE" });
      await refreshViewerNotes();
      toast("Viewer note deleted.");
    } catch (error) { toast(error.message, true); }
  }
});
$("#apply-optimizer").addEventListener("click", () => runOptimizerAction("/api/obs/optimizer/apply"));
$("#restore-optimizer").addEventListener("click", () => runOptimizerAction("/api/obs/optimizer/restore"));
$("#save-replay-only").addEventListener("click", async () => {
  try { await api("/api/obs/replay/save", { method: "POST" }); toast("Replay buffer saved."); }
  catch (error) { toast(error.message, true); }
});
document.querySelector('[data-console-action="replay"]').addEventListener("click", () => $("#save-replay-only").click());
$("#audio-mixer").addEventListener("pointerdown", event => {
  if (event.target.matches("[data-audio-volume]")) state.audioInteracting = true;
});
document.addEventListener("pointerup", () => { state.audioInteracting = false; });
$("#audio-mixer").addEventListener("input", event => {
  const slider = event.target.closest("[data-audio-volume]");
  if (!slider) return;
  const volume = Number(slider.value);
  slider.style.setProperty("--fader", `${((volume + 60) / 66 * 100).toFixed(1)}%`);
  slider.nextElementSibling.textContent = formatAudioDb(volume);
});
$("#audio-mixer").addEventListener("change", async event => {
  const slider = event.target.closest("[data-audio-volume]");
  if (!slider) return;
  try {
    await api("/api/obs/audio/volume", {
      method: "POST",
      body: JSON.stringify({ inputName: slider.dataset.audioVolume, volumeDb: Number(slider.value) })
    });
    await refreshAudio(true);
  } catch (error) { toast(error.message, true); }
});
$("#audio-mixer").addEventListener("click", async event => {
  const button = event.target.closest("[data-audio-mute]");
  if (!button) return;
  try {
    button.disabled = true;
    await api("/api/obs/audio/mute", {
      method: "POST",
      body: JSON.stringify({ inputName: button.dataset.audioMute, muted: button.dataset.muted !== "true" })
    });
    await refreshAudio(true);
  } catch (error) { button.disabled = false; toast(error.message, true); }
});
$("#tangia-visibility").addEventListener("click", () => updateTangia(
  "/api/tangia/visibility",
  { visible: state.tangia?.visible === false },
  state.tangia?.visible === false ? "Tangia is visible in the current scene." : "Tangia is hidden in the current scene."));
$("#tangia-mute").addEventListener("click", () => updateTangia(
  "/api/tangia/mute",
  { muted: !state.tangia?.muted },
  state.tangia?.muted ? "Tangia unmuted." : "Tangia muted."));
$("#tangia-reload").addEventListener("click", () => updateTangia("/api/tangia/reload", null, "Tangia Browser Source reloaded."));
$("#tangia-boss-focus").addEventListener("click", () => updateTangia(
  "/api/tangia/boss-focus",
  { enabled: !state.tangia?.bossFocusActive },
  state.tangia?.bossFocusActive ? "Boss Focus ended; Tangia audio restored." : "Boss Focus enabled; Tangia is muted."));
$("#tangia-volume").addEventListener("input", event => {
  $("#tangia-volume-value").textContent = formatAudioDb(event.target.value);
});
$("#tangia-volume").addEventListener("change", event => updateTangia(
  "/api/tangia/volume",
  { volumeDb: Number(event.target.value) }));
$("#log-tangia-interaction").addEventListener("click", async () => {
  try {
    const description = $("#tangia-interaction-note").value.trim();
    await api("/api/tangia/interactions", { method: "POST", body: JSON.stringify({ description }) });
    $("#tangia-interaction-note").value = "";
    await refreshReport(false);
    toast("Tangia interaction timestamp added to this session.");
  } catch (error) { toast(error.message, true); }
});
$("#start-twitch-ad").addEventListener("click", () => startAdBreak(true));
$("#start-ad-timer").addEventListener("click", () => startAdBreak(false));
$("#ad-announce-in-chat").addEventListener("change", event => saveAdOptions(event.target.checked));
$("#edit-ad-messages").addEventListener("click", editAdMessages);
$("#ad-messages-form").addEventListener("submit", saveAdMessages);
$("#cancel-ad-messages").addEventListener("click", () => $("#ad-messages-dialog").close());
$("#launch-nvidia").addEventListener("click", async () => {
  try {
    await api("/api/nvidia-broadcast/launch", { method: "POST" });
    toast("NVIDIA Broadcast launched.");
    setTimeout(refreshPreflight, 1800);
  } catch (error) { toast(error.message, true); }
});
$("#copy-music-overlay-url").addEventListener("click", async () => {
  const url = `${window.HandlerConnection?.helperOrigin || window.location.origin}/music-overlay.html`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Music overlay URL copied. Paste it into an OBS Browser Source.");
  } catch {
    window.prompt("Copy this OBS Browser Source URL:", url);
  }
});
$("#connect-obs").addEventListener("click", async () => {
  const message = $("#obs-connection-message");
  const button = $("#connect-obs");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Connecting to OBS…";
  try {
    message.textContent = "Connecting…";
    state.obs = await api("/api/obs/connect", {
      method: "POST",
      body: JSON.stringify({ url: $("#obs-url").value, password: $("#obs-password").value })
    });
    message.textContent = "OBS connected.";
    $("#obs-password").value = "";
    renderObs();
    await refreshAudio(true);
    await refreshPreflight();
  } catch (error) { message.textContent = `OBS: ${error.message}`; }
  finally {
    button.disabled = false;
    button.textContent = "Connect OBS";
    await refreshConnectionDiagnostics();
  }
});
$("#connect-twitch").addEventListener("click", async () => {
  const message = $("#settings-message");
  try {
    const result = await api("/api/twitch/configure", {
      method: "POST",
      body: JSON.stringify({
        clientId: $("#twitch-client-id").value,
        accessToken: $("#twitch-token").value,
        broadcasterId: $("#twitch-broadcaster-id").value,
        channelName: $("#twitch-channel-name").value
      })
    });
    loadChat($("#twitch-channel-name").value);
    message.textContent = result.alertError
      ? `Twitch connected, but live events need attention: ${result.alertError}`
      : "Twitch connected. Alerts, song requests, and chat feedback will reconnect automatically.";
    await refreshPreflight();
    await refreshAlerts();
  } catch (error) { message.textContent = error.message; }
  finally { await refreshConnectionDiagnostics(); }
});

let twitchAuthorizationTimer = null;
async function pollTwitchAuthorization() {
  try {
    const status = await api("/api/twitch/status");
    $("#settings-message").textContent = status.status;
    if (status.configured && status.renewable) {
      clearTimeout(twitchAuthorizationTimer);
      twitchAuthorizationTimer = null;
      $("#connect-twitch-oauth").disabled = false;
      if (status.channelName) loadChat(status.channelName);
      await refreshPreflight();
      await refreshAlerts();
      await refreshConnectionDiagnostics();
      toast("Twitch connected. Automatic token renewal is enabled.");
      return;
    }
    twitchAuthorizationTimer = setTimeout(pollTwitchAuthorization, 2000);
  } catch (error) {
    $("#settings-message").textContent = `Twitch: ${error.message}`;
    $("#connect-twitch-oauth").disabled = false;
  }
}

$("#connect-twitch-oauth").addEventListener("click", async () => {
  const clientId = $("#twitch-client-id").value.trim();
  if (clientId) localStorage.setItem("streamsidekick.twitchClientId", clientId);
  const button = $("#connect-twitch-oauth");
  try {
    button.disabled = true;
    const result = await api("/api/twitch/auth/start", {
      method: "POST",
      body: JSON.stringify({ clientId: clientId || null })
    });
    $("#settings-message").textContent = result.message;
    clearTimeout(twitchAuthorizationTimer);
    twitchAuthorizationTimer = setTimeout(pollTwitchAuthorization, 2000);
  } catch (error) {
    button.disabled = false;
    $("#settings-message").textContent = `Twitch: ${error.message}`;
    await refreshConnectionDiagnostics();
  }
});

$("#disconnect-twitch").addEventListener("click", async () => {
  try {
    clearTimeout(twitchAuthorizationTimer);
    twitchAuthorizationTimer = null;
    await api("/api/twitch/configure", { method: "DELETE" });
    $("#connect-twitch-oauth").disabled = false;
    $("#settings-message").textContent = "Twitch disconnected. Saved Twitch tokens were removed.";
    await refreshPreflight();
    await refreshConnectionDiagnostics();
  } catch (error) { $("#settings-message").textContent = error.message; }
});

$("#show-youtube-chat").addEventListener("click", () => {
  const videoId = extractYouTubeVideoId($("#youtube-live-url").value);
  if (!videoId) {
    $("#settings-message").textContent = "YouTube: Paste a livestream URL containing a valid 11-character video ID.";
    return;
  }
  state.youtubeVideoId = videoId;
  localStorage.setItem("streamsidekick.youtubeVideoId", videoId);
  renderCombinedChat();
  $("#settings-message").textContent = "YouTube live chat added. Automated messages remain Twitch-only.";
  toast("YouTube chat added beside Twitch.");
});
$("#clear-youtube-chat").addEventListener("click", () => {
  state.youtubeVideoId = "";
  localStorage.removeItem("streamsidekick.youtubeVideoId");
  $("#youtube-live-url").value = "";
  renderCombinedChat();
  $("#settings-message").textContent = "YouTube live chat removed from this computer.";
});

$("#test-alert").addEventListener("click", async () => {
  try {
    await api("/api/alerts/test", { method: "POST" });
    await refreshAlerts();
  } catch (error) { toast(error.message, true); }
});

$("#connect-spotify").addEventListener("click", async () => {
  const clientId = $("#spotify-client-id").value.trim();
  if (clientId) localStorage.setItem("streamsidekick.spotifyClientId", clientId);
  if (!state.spotifyEnabled) {
    state.spotifyEnabled = true;
    localStorage.setItem("streamsidekick.spotifyEnabled", "true");
    applyOptionalIntegrationState();
  }
  const button = $("#connect-spotify");
  try {
    button.disabled = true;
    const result = await api("/api/spotify/auth/open", {
      method: "POST",
      body: JSON.stringify({ clientId: clientId || null })
    });
    $("#settings-message").textContent = result.message;
  } catch (error) {
    $("#settings-message").textContent = `Spotify: ${error.message}`;
  } finally {
    button.disabled = false;
    await refreshConnectionDiagnostics();
  }
});
$("#disconnect-spotify").addEventListener("click", async () => {
  try {
    await api("/api/spotify/disconnect", { method: "POST" });
    await refreshSpotify();
    $("#settings-message").textContent = "Spotify disconnected. No token was saved.";
  } catch (error) { $("#settings-message").textContent = error.message; }
});
window.addEventListener("message", async event => {
  if (event.origin !== window.location.origin || event.data?.type !== "streamsidekick-spotify-connected") return;
  await refreshSpotify();
  $("#settings-message").textContent = "Spotify connected.";
  toast("Spotify connected. Start playback on a device to accept song requests.");
  await refreshConnectionDiagnostics();
});
$("#search-spotify").addEventListener("click", searchSpotify);
$("#spotify-search").addEventListener("keydown", event => { if (event.key === "Enter") searchSpotify(); });
$("#skip-spotify").addEventListener("click", async () => {
  const button = $("#skip-spotify");
  try {
    button.disabled = true;
    const result = await api("/api/spotify/skip", { method: "POST" });
    toast(result.message);
    window.setTimeout(refreshSpotify, 700);
  } catch (error) {
    toast(error.message, true);
  } finally {
    window.setTimeout(() => { button.disabled = !state.spotify?.connected || !state.spotify?.playback; }, 800);
  }
});
$("#spotify-search-results").addEventListener("click", async event => {
  const button = event.target.closest("[data-spotify-queue]");
  if (!button) return;
  try {
    button.disabled = true;
    await api("/api/spotify/queue", {
      method: "POST",
      body: JSON.stringify({ uri: button.dataset.spotifyQueue, requester: "Streamer", sourceText: $("#spotify-search").value.trim() })
    });
    await refreshSpotify();
    toast("Song added to the active Spotify queue.");
  } catch (error) { button.disabled = false; toast(error.message, true); }
});
$("#spotify-request-list").addEventListener("click", async event => {
  const approve = event.target.closest("[data-spotify-approve]");
  const reject = event.target.closest("[data-spotify-reject]");
  if (!approve && !reject) return;
  try {
    const requestId = (approve || reject).dataset[approve ? "spotifyApprove" : "spotifyReject"];
    await api(approve ? "/api/spotify/requests/approve" : "/api/spotify/requests/reject", {
      method: "POST",
      body: JSON.stringify({ requestId })
    });
    await refreshSpotify();
    toast(approve ? "Song request added to Spotify." : "Song request rejected.");
  } catch (error) { toast(error.message, true); }
});
$("#save-spotify-options").addEventListener("click", async () => {
  try {
    const options = await api("/api/spotify/options", {
      method: "PUT",
      body: JSON.stringify({
        rewardTitle: $("#spotify-reward-title").value.trim(),
        autoQueue: $("#spotify-auto-queue").checked,
        allowExplicit: $("#spotify-allow-explicit").checked
      })
    });
    state.spotify.options = options;
    renderSpotify();
    toast("Spotify request settings saved for this app session.");
  } catch (error) { toast(error.message, true); }
});
$("#test-spotify-request").addEventListener("click", async () => {
  const query = $("#spotify-search").value.trim();
  if (query.length < 2) { toast("Enter a song first, then test it as a viewer request.", true); return; }
  try {
    state.spotify = await api("/api/spotify/requests/test", {
      method: "POST",
      body: JSON.stringify({ query, requester: "Test viewer" })
    });
    renderSpotify();
    toast(state.spotify.options.autoQueue ? "Test request sent to Spotify." : "Test request added for approval.");
  } catch (error) { toast(error.message, true); }
});

$("#wow-edition").addEventListener("change", event => {
  state.wowEditionId = event.target.value;
  localStorage.setItem("streamsidekick.wowEdition", state.wowEditionId);
  renderWowEdition();
});
$("#wow-character-profile").addEventListener("change", event => {
  state.wowProfileId = event.target.value;
  localStorage.setItem("streamsidekick.wowProfile", state.wowProfileId);
  renderWowEdition();
});
$("#wow-addon-preset").addEventListener("change", renderAddonPresets);
$("#save-addon-preset").addEventListener("click", async () => {
  const name = $("#addon-preset-name").value.trim();
  if (!name) { toast("Enter a name for the addon preset.", true); return; }
  try {
    state.wowPresets = await api("/api/wow/addon-presets", {
      method: "POST",
      body: JSON.stringify({ editionId: state.wowEditionId, profileId: state.wowProfileId, name })
    });
    $("#addon-preset-name").value = "";
    renderAddonPresets();
    $("#wow-addon-preset").value = name;
    renderAddonPresets();
    toast(`Saved addon preset: ${name}.`);
  } catch (error) { toast(error.message, true); }
});
$("#apply-addon-preset").addEventListener("click", async () => {
  const name = $("#wow-addon-preset").value;
  if (!name || !window.confirm(`Apply “${name}” to the selected character? John's Twitch Handler will back up AddOns.txt first.`)) return;
  try {
    state.wow = await api("/api/wow/addon-presets/apply", {
      method: "POST",
      body: JSON.stringify({ editionId: state.wowEditionId, profileId: state.wowProfileId, name })
    });
    renderWowEdition();
    toast(`Applied addon preset: ${name}.`);
  } catch (error) { toast(error.message, true); }
});
$("#delete-addon-preset").addEventListener("click", async () => {
  const name = $("#wow-addon-preset").value;
  if (!name || !window.confirm(`Delete the saved preset “${name}”?`)) return;
  try {
    state.wowPresets = await api("/api/wow/addon-presets/delete", {
      method: "POST",
      body: JSON.stringify({ editionId: state.wowEditionId, name })
    });
    renderAddonPresets();
    toast(`Deleted addon preset: ${name}.`);
  } catch (error) { toast(error.message, true); }
});
$("#wow-addon-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-addon-toggle]");
  if (!button) return;
  try {
    button.disabled = true;
    state.wow = await api("/api/wow/addons/toggle", {
      method: "POST",
      body: JSON.stringify({
        editionId: state.wowEditionId,
        profileId: state.wowProfileId,
        addonName: button.dataset.addonToggle,
        enabled: button.dataset.enabled !== "true"
      })
    });
    renderWowEdition();
    toast(`${button.dataset.addonToggle} ${button.dataset.enabled === "true" ? "disabled" : "enabled"} for the selected character.`);
  } catch (error) { button.disabled = false; toast(error.message, true); }
});
$("#refresh-wow").addEventListener("click", () => loadWowAddons(true));
$("#install-wow-profiler").addEventListener("click", async () => {
  try {
    state.wow = await api("/api/wow/profiler/install", { method: "POST" });
    renderWowEdition();
    toast("John's Twitch Handler Profiler installed for detected WoW editions. Enable it in WoW's AddOns screen.");
  } catch (error) { toast(error.message, true); }
});
$("#auto-mark-bosses").addEventListener("change", saveWowEventOptions);
$("#auto-save-boss-replay").addEventListener("change", saveWowEventOptions);
$("#auto-tangia-boss-focus").addEventListener("change", saveWowEventOptions);
$("#test-wow-event").addEventListener("click", async () => {
  try {
    state.wowEvents = await api("/api/wow/events/test", { method: "POST" });
    renderWowEvents();
    await refreshReport(false);
    toast(state.sessionActive ? "Test boss victory processed." : "Test event received. Start a session to create automatic markers.");
  } catch (error) { toast(error.message, true); }
});

$("#demo-primary-action").addEventListener("click", advanceGuidedDemo);
$("#demo-simulate-gpu").addEventListener("click", () => runDemoIncident("gpu"));
$("#demo-simulate-network").addEventListener("click", () => runDemoIncident("network"));
$("#demo-fix-it").addEventListener("click", fixDemoIncident);
$("#demo-exit").addEventListener("click", () => resetGuidedDemo(false));

document.addEventListener("keydown", event => {
  if (!event.altKey || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (event.key.toLowerCase() === "m") { event.preventDefault(); addMarker(); }
  if (event.key.toLowerCase() === "r") { event.preventDefault(); $("#save-replay-only").click(); }
  if (state.gameProfile === "fps" && event.shiftKey && event.key.toLowerCase() === "k") { event.preventDefault(); addFpsMarker("kill"); }
  if (state.gameProfile === "fps" && event.shiftKey && event.key.toLowerCase() === "d") { event.preventDefault(); addFpsMarker("death"); }
});

// Suspend browser polling while hidden. The Windows services keep monitoring;
// returning to the dashboard refreshes once without overlapping an existing read.
const dashboardPolling = HandlerDashboardRuntime.createPoller({
  setTimeout: (task, delay) => window.setTimeout(task, delay),
  clearTimeout: timer => window.clearTimeout(timer),
  paused: document.hidden,
  onError: error => console.debug("Background dashboard refresh failed.", error)
});
document.addEventListener("visibilitychange", () => dashboardPolling.setPaused(document.hidden));
function startPolling(task, delayMs, panelId = null, visibleOnly = false) {
  return dashboardPolling.add(task, delayMs, () => {
    const panel = panelId ? document.querySelector(`[data-panel-id="${CSS.escape(panelId)}"]`) : null;
    if (panelId && !panel) return false;
    return !panel?.classList.contains("collapsed")
      && !panel?.classList.contains("workspace-hidden")
      && !panel?.classList.contains("game-profile-hidden")
      && !panel?.classList.contains("tab-hidden")
      && (!visibleOnly || Boolean(panel?.getClientRects().length));
  });
}

let startupInProgress = false;
let dashboardPollingStarted = false;
let dashboardInitialized = false;
function showStartupMessage(message, retry = false) {
  $("#dashboard-startup").hidden = !message;
  $("#dashboard-startup").classList.toggle("warning", retry);
  $("#startup-message").textContent = message || "";
  $("#retry-startup").hidden = !retry;
}

function startDashboardPolling() {
  if (dashboardPollingStarted) return;
  dashboardPollingStarted = true;
  startPolling(refreshObs, 5000);
  startPolling(refreshAudio, 1000, "audio", true);
  // Simple mode needs current health even when raw performance panels are hidden.
  startPolling(refreshPerformance, 3000);
  startPolling(refreshAlerts, 4000, "alerts");
  startPolling(refreshChatChime, 8000, "chat");
  startPolling(refreshTwitchChat, 1200, "chat");
  startPolling(refreshPreflight, 8000);
  startPolling(refreshOptimizerStatus, 5000, "optimizer");
  if (state.setup.wowToolsEnabled === true) startPolling(refreshWowEvents, 2000, "wow-events");
  startPolling(refreshSpotify, 5000);
  startPolling(refreshTangia, 5000);
  startPolling(refreshStreamElements, 60000, "streamelements");
  startPolling(refreshTikFinity, 2500, "tikfinity");
  startPolling(refreshAds, 4000, "ads");
  startPolling(() => refreshReport(false), 15000, "report");
  startPolling(refreshViewerNotes, 30000, "viewers");
  startPolling(refreshAutomations, 15000, "automations");
  // Countdown repaint stays browser-local and skips work in a hidden tab.
  window.setInterval(() => { if (!document.hidden) renderAds(); }, 1000);
  window.setInterval(() => { if (!document.hidden) renderDuringStatusStrip(document.body.dataset.workspacePage || "pre"); }, 1000);
}

async function boot() {
  if (startupInProgress) return;
  startupInProgress = true;
  showStartupMessage("Connecting to your Handler and checking saved settings…");
  try {
    loadManualPreflightItems();
    renderManualPreflightItems();
    loadPreflightVisibility();
    if (state.channelName) loadChat(state.channelName);
    else renderCombinedChat();
    $("#twitch-client-id").value = localStorage.getItem("streamsidekick.twitchClientId") || "";
    $("#spotify-client-id").value = localStorage.getItem("streamsidekick.spotifyClientId") || "";
    $("#youtube-live-url").value = state.youtubeVideoId ? `https://www.youtube.com/watch?v=${state.youtubeVideoId}` : "";
    $("#raid-range").value = String([7, 14, 31].includes(state.raidDays) ? state.raidDays : 31);
    await loadSetupConfiguration();
    const startupTasks = [
      refreshPreflight(), refreshObs(), refreshAudio(), refreshReport(false), refreshStreamHistory(),
      refreshPerformance(), loadProfileAnalysis(), refreshOptimizerStatus(), refreshAlerts(),
      refreshChatChime(), refreshSpotify(), refreshTangia(), refreshStreamElements(), refreshTikFinity(),
      refreshAds(), refreshChatCommands(), refreshAutomations(), refreshRaids(true), refreshViewerNotes(), refreshWardogsStatus()
    ];
    if (state.setup.wowToolsEnabled === true) startupTasks.push(loadWowAddons(), loadAddonPresets(), refreshWowEvents());
    const results = await Promise.allSettled(startupTasks);
    // OBS is the first setup step. Twitch is optional; an active stream should
    // never be interrupted by an automatic setup dialog.
    if (!localStorage.getItem("streamsidekick.setupSeen") && !state.preflight?.obsConnected && !state.sessionActive) {
      localStorage.setItem("streamsidekick.setupSeen", "true");
      openSettings();
    }
    startDashboardPolling();
    const incomplete = results.some(result => result.status === "rejected");
    showStartupMessage(incomplete
      ? "Some tools could not refresh yet. You can try again; your connected tools are still available." : null, incomplete);
  } catch (error) {
    showStartupMessage(error.message || "The dashboard could not finish opening. Try again.", true);
  } finally {
    startupInProgress = false;
  }
}
$("#retry-startup").addEventListener("click", () => {
  if (dashboardInitialized) boot(); else window.location.reload();
});
async function startDashboard() {
  initializeVisualStyle();
  initializeTheme();
  initializeUserMode();
  initializeGameProfile();
  renderGuidedDemo();
  await initializeMovablePanels();
  initializeWorkspaceNavigation();
  dashboardInitialized = true;
  await boot();
  // If the app restarts during an active show, return directly to the live controls.
  if (state.sessionActive) setActiveWorkspace("during", { persist: true });
}
startDashboard().catch(error => showStartupMessage(error.message || "The dashboard could not open. Try again.", true));
