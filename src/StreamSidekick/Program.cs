using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using StreamSidekick;
using StreamSidekick.Services;

var builder = WebApplication.CreateBuilder(args);

// A desktop user may not have permission to write Windows Event Log sources. Console logging is
// redirected by the launcher into readable local files and cannot crash startup on an access error.
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(options => options.SingleLine = true);

var credentialKeyDirectory = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
    "StreamSidekick",
    "credential-keys");
// The legacy protection name must stay stable so the rename does not invalidate John's saved logins.
var dataProtection = builder.Services.AddDataProtection()
    .SetApplicationName("StreamSidekick")
    .PersistKeysToFileSystem(new DirectoryInfo(credentialKeyDirectory));
if (OperatingSystem.IsWindows()) dataProtection.ProtectKeysWithDpapi();

// Services are singletons because each represents one local stream session or one external connection.
builder.Services.AddSingleton<SecureConnectionStore>();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<WebsiteBridge>();
builder.Services.AddSingleton<ConnectionDiagnosticsLog>();
builder.Services.AddSingleton<DashboardLayoutStore>();
builder.Services.AddSingleton<ObsWebSocketClient>();
builder.Services.AddSingleton<SessionStore>();
builder.Services.AddSingleton<WardogsService>();
builder.Services.AddSingleton<StreamSessionLifecycleService>();
builder.Services.AddSingleton<TwitchClient>();
builder.Services.AddSingleton<TwitchEventSubService>();
builder.Services.AddSingleton<NvidiaBroadcastService>();
builder.Services.AddSingleton<ObsProfileAnalyzer>();
builder.Services.AddSingleton<SystemMonitorService>();
builder.Services.AddSingleton<InternetMonitorService>();
builder.Services.AddSingleton<WowAddonService>();
builder.Services.AddSingleton<WowEventMonitorService>();
builder.Services.AddSingleton<SpotifyService>();
builder.Services.AddSingleton<MusicOverlaySettingsStore>();
builder.Services.AddSingleton<AdBreakService>();
builder.Services.AddSingleton<PrivateChatChimeService>();
builder.Services.AddSingleton<StreamElementsService>();
builder.Services.AddSingleton<TikFinityChatService>();
builder.Services.AddSingleton<ConnectionSupervisor>();
builder.Services.AddSingleton<ChatCommandService>();
builder.Services.AddSingleton<AutomationService>();
builder.Services.AddSingleton<RaidManagerService>();
builder.Services.AddSingleton<ViewerNoteService>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<SystemMonitorService>());
builder.Services.AddHostedService(provider => provider.GetRequiredService<StreamSessionLifecycleService>());
builder.Services.AddHostedService(provider => provider.GetRequiredService<InternetMonitorService>());
builder.Services.AddHostedService(provider => provider.GetRequiredService<WowEventMonitorService>());
builder.Services.AddHostedService(provider => provider.GetRequiredService<ConnectionSupervisor>());
builder.Services.AddHostedService(provider => provider.GetRequiredService<AutomationService>());
builder.Services.AddHostedService(provider => provider.GetRequiredService<TikFinityChatService>());
builder.Services.AddHttpClient();

var app = builder.Build();
app.UseWebsiteBridge();
app.MapWebsiteBridge();

// The dashboard always lives at the same bookmark. Revalidation prevents an older browser-cached
// interface from surviving after an approved build is installed and the Handler is restarted.
var dashboardStaticFiles = new StaticFileOptions
{
    OnPrepareResponse = context =>
    {
        context.Context.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
        context.Context.Response.Headers.Pragma = "no-cache";
        context.Context.Response.Headers.Expires = "0";
    }
};
app.UseDefaultFiles();
app.UseStaticFiles(dashboardStaticFiles);

var obs = app.Services.GetRequiredService<ObsWebSocketClient>();
var sessions = app.Services.GetRequiredService<SessionStore>();
var wardogs = app.Services.GetRequiredService<WardogsService>();
var twitch = app.Services.GetRequiredService<TwitchClient>();
var twitchEvents = app.Services.GetRequiredService<TwitchEventSubService>();
var nvidiaBroadcast = app.Services.GetRequiredService<NvidiaBroadcastService>();
var systemMonitor = app.Services.GetRequiredService<SystemMonitorService>();
var internetMonitor = app.Services.GetRequiredService<InternetMonitorService>();
var profileAnalyzer = app.Services.GetRequiredService<ObsProfileAnalyzer>();
var wowAddons = app.Services.GetRequiredService<WowAddonService>();
var wowEvents = app.Services.GetRequiredService<WowEventMonitorService>();
var spotify = app.Services.GetRequiredService<SpotifyService>();
var musicOverlaySettings = app.Services.GetRequiredService<MusicOverlaySettingsStore>();
var connectionLog = app.Services.GetRequiredService<ConnectionDiagnosticsLog>();
var dashboardLayout = app.Services.GetRequiredService<DashboardLayoutStore>();
var adBreaks = app.Services.GetRequiredService<AdBreakService>();
var chatChime = app.Services.GetRequiredService<PrivateChatChimeService>();
var streamElements = app.Services.GetRequiredService<StreamElementsService>();
var tikFinity = app.Services.GetRequiredService<TikFinityChatService>();
var chatCommands = app.Services.GetRequiredService<ChatCommandService>();
var automations = app.Services.GetRequiredService<AutomationService>();
var raidManager = app.Services.GetRequiredService<RaidManagerService>();
var viewerNotes = app.Services.GetRequiredService<ViewerNoteService>();
var startingSceneMicGate = new SemaphoreSlim(1, 1);
bool? micMuteStateBeforeStarting = null;

// External event callbacks are synchronous delegates. Route their asynchronous work through one
// observer so failures are logged instead of becoming silent, unobserved background exceptions.
obs.EventReceived += (eventType, data) =>
{
    if (eventType == "CurrentProgramSceneChanged"
        && data.TryGetProperty("sceneName", out var sceneName))
    {
        var name = sceneName.GetString() ?? "Unknown scene";
        RunEventTask(() => HandleObsSceneChangedAsync(name), "handle an OBS scene change");
    }
};

wowEvents.EventDetected += gameEvent => RunEventTask(() => HandleWowEventAsync(gameEvent), "handle a WoW event");
twitchEvents.RewardRedeemed += redemption => RunEventTask(() => HandleSpotifyRewardAsync(redemption), "handle a Twitch reward");
twitchEvents.AdBreakStarted += adBreak => RunEventTask(
    () => adBreaks.BeginAsync(
        adBreak.DurationSeconds,
        adBreak.Automatic ? "Twitch automatic ad" : "Twitch ad",
        adBreak.StartedAt),
    "track a Twitch ad break");
twitchEvents.ChatMessageReceived += message => RunEventTask(
    () => chatChime.NotifyAsync(message),
    "play the private Twitch chat chime");
twitchEvents.ChatCommandReceived += message =>
{
    viewerNotes.Observe(message.UserName, "Appeared in chat");
    RunEventTask(async () =>
    {
        await sessions.AddChatMessageAsync(message);
        await HandleChatCommandAsync(message);
    }, "record Twitch chat and handle a command");
};
twitchEvents.AlertReceived += alert => RunEventTask(async () =>
{
    // Twitch events become durable timeline entries only while a session is active.
    // AdBreakService records both start and completion, so avoid a duplicate start from EventSub.
    if (alert.Type != "ad")
        await sessions.AddActivityAsync(alert.Type, $"{alert.Title}. {alert.Detail}");
    if (!string.IsNullOrWhiteSpace(alert.UserName)
        && alert.Type is "follow" or "subscription" or "resub" or "gift" or "cheer" or "raid" or "reward")
        viewerNotes.Observe(alert.UserName, $"{alert.Title}. {alert.Detail}", important: true);
    if (alert.Type == "raid" && !string.IsNullOrWhiteSpace(alert.UserName))
        raidManager.RecordIncoming(alert.UserName, alert.Detail);
}, "record a Twitch event");

void RunEventTask(Func<Task> action, string operation) => _ = ObserveEventTaskAsync(action, operation);

async Task ObserveEventTaskAsync(Func<Task> action, string operation)
{
    try { await action(); }
    catch (Exception exception) { app.Logger.LogWarning(exception, "Could not {Operation}.", operation); }
}

async Task HandleObsSceneChangedAsync(string sceneName)
{
    await sessions.AddActivityAsync("scene", sceneName);

    // Mic/Aux is an OBS global audio device rather than a scene item. Remember its existing state,
    // mute it while STARTING is active, and restore that exact state on the next scene. This avoids
    // rebuilding the microphone as separate per-scene sources or accidentally unmuting a manual mute.
    await startingSceneMicGate.WaitAsync();
    try
    {
        if (sceneName.Equals("STARTING", StringComparison.OrdinalIgnoreCase))
        {
            var mute = await obs.RequestAsync("GetInputMute", new { inputName = "Mic/Aux" });
            var currentlyMuted = mute.GetProperty("inputMuted").GetBoolean();
            micMuteStateBeforeStarting ??= currentlyMuted;
            if (!currentlyMuted)
                await obs.SetInputMuteAsync("Mic/Aux", true);
        }
        else if (micMuteStateBeforeStarting.HasValue)
        {
            await obs.SetInputMuteAsync("Mic/Aux", micMuteStateBeforeStarting.Value);
            micMuteStateBeforeStarting = null;
        }
    }
    finally
    {
        startingSceneMicGate.Release();
    }
}

async Task HandleSpotifyRewardAsync(TwitchRewardRedemption redemption)
{
    var result = await spotify.ReceiveRewardAsync(redemption);
    if (result is null) return;

    // Successful song requests update the queue and receive a chat confirmation only. Do not feed
    // them into the on-stream alert path, which could create an unwanted confirmation sound.
    if (!result.Success)
    {
        twitchEvents.AddLocalAlert(
            "warning",
            "Song request failed",
            result.Message,
            result.UserName);
    }
    try
    {
        await twitch.SendChatMessageAsync(result.Message);
    }
    catch (Exception exception)
    {
        app.Logger.LogWarning(exception, "Could not post the song-request result to Twitch chat.");
        twitchEvents.AddLocalAlert(
            "warning",
            "Chat confirmation was not sent",
            "Reconnect Twitch with a user token that includes user:write:chat.",
            result.UserName);
    }
}

async Task HandleChatCommandAsync(TwitchChatMessage message)
{
    var command = ChatCommandService.FirstCommand(message.Text);
    if (command is null) return;
    string? response = null;
    if (command is "!song" or "!playing")
    {
        if (!chatCommands.TryAcquireBuiltInCooldown("!song", message)) return;
        try
        {
            var playback = await spotify.GetNowPlayingAsync();
            if (playback?.Track is null)
            {
                response = "John's Twitch Handler: Spotify is connected, but nothing is playing right now.";
            }
            else
            {
                var track = playback.Track;
                var link = string.IsNullOrWhiteSpace(track.SpotifyUrl)
                    ? $"https://open.spotify.com/track/{track.Id}"
                    : track.SpotifyUrl;
                var stateText = playback.IsPlaying ? "Now playing" : "Currently paused on";
                response = $"John's Twitch Handler: {stateText} “{track.Title}” by {track.Artist}. Listen on Spotify: {link}";
            }
        }
        catch (Exception exception)
        {
            app.Logger.LogWarning(exception, "Could not answer the Spotify chat command.");
            response = "John's Twitch Handler: I could not read Spotify right now. John may need to open Spotify or reconnect it.";
        }
    }
    else
    {
        var customResponse = chatCommands.TryCreateResponse(message);
        if (customResponse is not null) response = $"John's Twitch Handler: {customResponse}";
    }

    if (response is null) return;
    try { await twitch.SendChatMessageAsync(response); }
    catch (Exception exception)
    {
        app.Logger.LogWarning(exception, "Could not send a chat-command response.");
        twitchEvents.AddLocalAlert("warning", "Chat command response failed", exception.GetBaseException().Message, message.UserName);
    }
}

async Task HandleWowEventAsync(WowGameEvent gameEvent)
{
    // Boss Focus operates independently of session reporting so Tangia cannot interrupt an active
    // pull simply because the local tracking session was not started.
    if (wowEvents.AutoTangiaBossFocus
        && gameEvent.Type is "encounter-start" or "encounter-end")
    {
        var starting = gameEvent.Type == "encounter-start";
        var realEncounter = !gameEvent.EditionId.Equals("test", StringComparison.OrdinalIgnoreCase);
        try
        {
            var result = await obs.SetTangiaBossFocusAsync(starting);
            if (realEncounter)
            {
                var passed = starting
                    ? result.BossFocusActive && result.Muted
                    : !result.BossFocusActive;
                var feedback = wowEvents.RecordBossFocusVerification(
                    starting ? "start" : "end",
                    passed,
                    result.Status);
                if (feedback is not null)
                {
                    twitchEvents.AddLocalAlert(
                        feedback.Passed ? "info" : "warning",
                        $"Boss Focus check {feedback.TestNumber}/3",
                        feedback.Message,
                        "John's Twitch Handler");
                }

                // Announce only after OBS confirms the state change. This prevents chat from saying
                // Tangia is muted when the Browser Source was missing or OBS was disconnected.
                var chatMessage = starting
                    ? "John's Twitch Handler: Boss Focus is active. Tangia is muted until this boss fight ends."
                    : "John's Twitch Handler: Boss Focus ended. Tangia interactions are available again.";
                try { await twitch.SendChatMessageAsync(chatMessage); }
                catch (Exception exception)
                {
                    app.Logger.LogWarning(exception, "Could not post the Tangia Boss Focus update to Twitch chat.");
                    twitchEvents.AddLocalAlert(
                        "warning",
                        "Boss Focus chat notice was not sent",
                        "Tangia changed correctly, but Twitch chat is disconnected.",
                        "John's Twitch Handler");
                }
            }
        }
        catch (Exception exception)
        {
            app.Logger.LogWarning(exception, "Could not update Tangia Boss Focus for the WoW encounter.");
            if (realEncounter)
            {
                var feedback = wowEvents.RecordBossFocusVerification(
                    starting ? "start" : "end",
                    false,
                    exception.Message);
                twitchEvents.AddLocalAlert(
                    "warning",
                    feedback is null ? "Boss Focus failed" : $"Boss Focus check {feedback.TestNumber}/3 failed",
                    $"Tangia could not be {(starting ? "muted" : "restored")}: {exception.Message}",
                    "John's Twitch Handler");
            }
        }
    }

    if (!sessions.HasActiveSession) return;
    var detail = gameEvent.Type == "encounter-start"
        ? $"Encounter started: {gameEvent.Title}"
        : gameEvent.Success == true ? $"Boss defeated: {gameEvent.Title}" : $"Encounter ended: {gameEvent.Title}";
    await sessions.AddActivityAsync("wow", detail);
    if (gameEvent.Type != "encounter-end" || gameEvent.Success != true || !wowEvents.AutoMarkBossKills) return;

    var replaySaved = false;
    string? note = "Created automatically from the WoW combat log.";
    if (wowEvents.AutoSaveReplay)
    {
        try
        {
            await obs.SaveReplayBufferAsync();
            replaySaved = true;
        }
        catch (Exception exception)
        {
            note += $" Replay was not saved: {exception.Message}";
        }
    }
    await sessions.AddMarkerAsync($"{gameEvent.Title} defeated", "wow-boss", replaySaved, note);
}

// --- Readiness and system diagnostics ---------------------------------------------------------

app.MapGet("/api/health", () => Results.Ok(new
{
    ok = true,
    app = "John's Twitch Handler",
    channel = builder.Configuration["Release:Channel"] ?? "Local",
    version = builder.Configuration["Release:Version"] ?? "development"
}));

// The browser needs only capability flags, never the packaged public IDs themselves. These flags
// let first-run setup hide developer-only fields and honor optional integrations per computer.
app.MapGet("/api/setup", () => Results.Ok(new
{
    releaseChannel = builder.Configuration["Release:Channel"] ?? "Local",
    releaseLabel = builder.Configuration["Release:Label"] ?? "Owner build",
    releaseVersion = builder.Configuration["Release:Version"] ?? "development",
    wowToolsEnabled = builder.Configuration.GetValue("Features:WowTools", false),
    twitchApplicationConfigured = twitch.GetStatus().ApplicationConfigured,
    spotifyApplicationConfigured = spotify.ApplicationConfigured,
    spotifyEnabledByDefault = builder.Configuration.GetValue("Integrations:Spotify:EnabledByDefault", true),
    tangiaEnabledByDefault = builder.Configuration.GetValue("Integrations:Tangia:EnabledByDefault", true),
    streamElementsEnabledByDefault = builder.Configuration.GetValue("Integrations:StreamElements:EnabledByDefault", true),
    tikFinityEnabledByDefault = builder.Configuration.GetValue("Integrations:TikFinity:EnabledByDefault", false)
}));

// OBS Browser Sources poll this lightweight endpoint for the Boss Focus banner. It never queries
// OBS, Spotify, Twitch, or Tangia, so the on-stream display has negligible performance impact.
app.MapGet("/api/overlay/status", () => Results.Ok(new
{
    musicOverlayVisible = musicOverlaySettings.Get().Visible,
    tangiaBossFocusActive = obs.TangiaBossFocusActive
}));

app.MapPut("/api/overlay/music", (MusicOverlaySettings settings) =>
{
    try { return Results.Ok(musicOverlaySettings.Set(settings)); }
    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
    {
        app.Logger.LogWarning(exception, "Could not save music overlay visibility.");
        return Results.Json(new { error = "Could not save the overlay setting. Check free disk space and folder permissions, then try again." }, statusCode: 500);
    }
});

app.MapGet("/api/preflight", async (bool? spotifyEnabled, bool? tangiaEnabled, bool? streamElementsEnabled, bool? streamElementsConfirmed, bool? tikFinityEnabled, CancellationToken cancellationToken) =>
{
    var twitchSnapshot = twitchEvents.GetSnapshot();
    // Disabled optional integrations should create no OBS inspection traffic and should not keep a
    // tester's readiness border yellow.
    var musicOverlayTask = spotifyEnabled == false
        ? Task.FromResult(new ObsBrowserSourceCheck(true, "Spotify is not used on this computer."))
        : obs.GetMusicOverlayStatusAsync(cancellationToken);
    var tangiaTask = tangiaEnabled == false
        ? Task.FromResult(new TangiaSourceSnapshot(obs.IsConnected, true, "Tangia is not used on this computer."))
        : obs.GetTangiaStatusAsync(cancellationToken);
    var microphoneTask = obs.GetMicrophoneStatusAsync(cancellationToken);
    await Task.WhenAll(musicOverlayTask, tangiaTask, microphoneTask);
    var musicOverlay = await musicOverlayTask;
    var tangia = await tangiaTask;
    var microphone = await microphoneTask;
    var streamElementsStatus = streamElements.GetStatus();
    var tikFinityStatus = tikFinity.GetSnapshot();
    var rewardsReady = twitch.IsConfigured
        && twitchSnapshot.Connected
        && !twitchSnapshot.SetupWarnings.Any(warning =>
            warning.StartsWith("Channel point rewards:", StringComparison.OrdinalIgnoreCase)
            || warning.StartsWith("Channel chat:", StringComparison.OrdinalIgnoreCase));
    return Results.Ok(new
    {
        obsConnected = obs.IsConnected,
        microphoneReady = microphone.Found && !microphone.Muted,
        microphone,
        streamElementsReady = streamElementsEnabled == false || (streamElementsStatus.Installed && streamElementsConfirmed == true),
        streamElements = streamElementsStatus,
        tikFinityReady = tikFinityEnabled == false || tikFinityStatus.Connected,
        tikFinity = tikFinityStatus,
        nvidiaBroadcast = nvidiaBroadcast.GetStatus(),
        twitchConfigured = twitch.IsConfigured,
        twitchConnected = twitchSnapshot.Connected,
        twitchRewardsReady = rewardsReady,
        twitchStatus = twitchSnapshot.Status,
        musicOverlayConfigured = musicOverlay.Found,
        musicOverlayVisible = musicOverlaySettings.Get().Visible,
        musicOverlayStatus = musicOverlay.Status,
        musicOverlaySourceName = musicOverlay.SourceName,
        tangiaConfigured = tangia.Found,
        tangiaStatus = tangia.Status,
        tangiaSourceName = tangia.SourceName,
        sessionActive = sessions.HasActiveSession
    });
});

app.MapGet("/api/system/status", () => Results.Ok(systemMonitor.GetSnapshot()));
app.MapGet("/api/internet/status", () => Results.Ok(internetMonitor.GetSnapshot()));
app.MapGet("/api/streamelements/status", () => Results.Ok(streamElements.GetStatus()));
app.MapGet("/api/tikfinity/status", () => Results.Ok(tikFinity.GetSnapshot()));
app.MapPut("/api/tikfinity/enabled", (TikFinityEnabledRequest request) =>
    Results.Ok(tikFinity.SetEnabled(request.Enabled)));
app.MapGet("/api/dashboard-layout", () => Results.Ok(new
{
    panelOrder = dashboardLayout.Read(),
    panelPages = dashboardLayout.ReadPages()
}));
app.MapPut("/api/dashboard-layout", (DashboardLayoutRequest request) =>
{
    try
    {
        var panelOrder = dashboardLayout.Save(request.PanelOrder);
        var panelPages = request.PanelPages is null
            ? dashboardLayout.ReadPages()
            : dashboardLayout.SavePages(request.PanelPages);
        return Results.Ok(new { panelOrder, panelPages });
    }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});

// --- Streamer relationship tools -------------------------------------------------------------

app.MapGet("/api/chat-commands", () => Results.Ok(chatCommands.GetAll()));
app.MapPut("/api/chat-commands", (ChatCommandUpsertRequest request) =>
{
    try { return Results.Ok(chatCommands.Upsert(request)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapDelete("/api/chat-commands/{command}", (string command) =>
    chatCommands.Delete(command)
        ? Results.Ok(new { deleted = true })
        : Results.NotFound(new { error = "Chat command not found." }));

app.MapGet("/api/automations", () => Results.Ok(automations.GetAll()));
app.MapPut("/api/automations", (AutomationUpsertRequest request) =>
{
    try { return Results.Ok(automations.Upsert(request)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapDelete("/api/automations/{id:guid}", (Guid id) =>
    automations.Delete(id)
        ? Results.Ok(new { deleted = true })
        : Results.NotFound(new { error = "Automation not found." }));
app.MapPost("/api/automations/{id:guid}/run", async (Guid id, CancellationToken cancellationToken) =>
{
    try { return Results.Ok(await automations.RunAsync(id, cancellationToken)); }
    catch (KeyNotFoundException exception) { return Results.NotFound(new { error = exception.Message }); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.GetBaseException().Message }); }
});

app.MapGet("/api/raids", (bool? refresh, int? days, CancellationToken cancellationToken) =>
    raidManager.GetSnapshotAsync(refresh == true, days ?? 31, cancellationToken));
app.MapPost("/api/raids/suggested", (RaidChannelRequest request) =>
{
    try { return Results.Ok(raidManager.AddSuggested(request.ChannelName)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/raids/mark", (RaidChannelRequest request) =>
{
    try { return Results.Ok(raidManager.MarkRaided(request.ChannelName)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapDelete("/api/raids/{channelName}", (string channelName) =>
    raidManager.Remove(channelName)
        ? Results.Ok(new { deleted = true })
        : Results.NotFound(new { error = "Raid channel not found." }));

app.MapGet("/api/viewer-notes", () => Results.Ok(viewerNotes.GetAll()));
app.MapPut("/api/viewer-notes", (ViewerNoteRequest request) =>
{
    try { return Results.Ok(viewerNotes.SetNote(request)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapDelete("/api/viewer-notes/{userName}", (string userName) =>
    viewerNotes.Delete(userName)
        ? Results.Ok(new { deleted = true })
        : Results.NotFound(new { error = "Viewer note not found." }));
app.MapGet("/api/diagnostics/connections", () => Results.Ok(connectionLog.GetRecent()));
app.MapGet("/api/diagnostics/export", () =>
{
    // Keep the support file useful but intentionally omit channel names, IDs, tokens, passwords,
    // viewer requests, track names, scene names, and OBS Browser Source URLs.
    var twitchStatus = twitch.GetStatus();
    var alertStatus = twitchEvents.GetSnapshot();
    var safeConnections = connectionLog.GetRecent(60)
        .Where(entry => !entry.Message.Contains("request", StringComparison.OrdinalIgnoreCase)
            && !entry.Message.Contains("queued", StringComparison.OrdinalIgnoreCase))
        .Select(entry => new { entry.At, entry.Service, entry.Level, entry.Message });
    var report = new
    {
        generatedAt = DateTimeOffset.UtcNow,
        application = "John's Twitch Handler",
        applicationVersion = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version?.ToString(),
        operatingSystem = RuntimeInformation.OSDescription,
        runtime = RuntimeInformation.FrameworkDescription,
        connections = new
        {
            obs = new { connected = obs.IsConnected, saved = obs.HasSavedConnection, hasError = !string.IsNullOrWhiteSpace(obs.LastError) },
            twitch = new { twitchStatus.Configured, twitchStatus.Renewable, alertsConnected = alertStatus.Connected, twitchStatus.ApplicationConfigured },
            spotify = new { connected = spotify.IsConnected, applicationConfigured = spotify.ApplicationConfigured }
        },
        recentConnectionEvents = safeConnections
    };
    var bytes = JsonSerializer.SerializeToUtf8Bytes(report, new JsonSerializerOptions { WriteIndented = true });
    var name = $"johns-twitch-handler-diagnostics-{DateTime.UtcNow:yyyyMMdd-HHmmss}.json";
    return Results.File(bytes, "application/json", name);
});
app.MapGet("/api/obs/profile-analysis", () => Results.Ok(profileAnalyzer.Analyze()));
app.MapGet("/api/obs/optimizer/status", () => Results.Ok(profileAnalyzer.GetOptimizerStatus()));
app.MapPost("/api/obs/optimizer/apply", () =>
{
    try
    {
        return Results.Ok(profileAnalyzer.ApplyRecommendation());
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message, status = profileAnalyzer.GetOptimizerStatus() });
    }
});
app.MapPost("/api/obs/optimizer/restore", () =>
{
    try
    {
        return Results.Ok(profileAnalyzer.RestorePreviousSettings());
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message, status = profileAnalyzer.GetOptimizerStatus() });
    }
});
app.MapGet("/api/wow/addons", (bool? refresh) => Results.Ok(wowAddons.GetOverview(refresh == true)));
app.MapPost("/api/wow/profiler/install", () =>
{
    try
    {
        return Results.Ok(wowAddons.InstallProfiler());
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});
app.MapPost("/api/wow/addons/toggle", (WowAddonToggleRequest request) =>
{
    try
    {
        return Results.Ok(wowAddons.SetAddonEnabled(request));
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});
app.MapGet("/api/wow/addon-presets", () => Results.Ok(wowAddons.GetPresets()));
app.MapPost("/api/wow/addon-presets", (WowAddonPresetRequest request) =>
{
    try { return Results.Ok(wowAddons.SavePreset(request)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/wow/addon-presets/apply", (WowAddonPresetApplyRequest request) =>
{
    try { return Results.Ok(wowAddons.ApplyPreset(request)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/wow/addon-presets/delete", (WowAddonPresetDeleteRequest request) =>
{
    try { return Results.Ok(wowAddons.DeletePreset(request)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapGet("/api/wow/events", () => Results.Ok(wowEvents.GetSnapshot()));
app.MapPut("/api/wow/events", (WowEventMonitorOptions options) => Results.Ok(wowEvents.SetOptions(options)));
app.MapPost("/api/wow/events/test", () => Results.Ok(wowEvents.AddTestEvent()));

// Chat chimes are played by OBS, never by the dashboard browser. This lets OBS enforce Monitor
// Only routing and block playback when Desktop Audio could leak the sound to viewers.
app.MapGet("/api/chat-chime", (CancellationToken cancellationToken) =>
    chatChime.GetSnapshotAsync(cancellationToken));
app.MapPut("/api/chat-chime", (PrivateChatChimeOptions options, CancellationToken cancellationToken) =>
    chatChime.SetOptionsAsync(options, cancellationToken));
app.MapPost("/api/chat-chime/test", (CancellationToken cancellationToken) =>
    chatChime.TestAsync(cancellationToken));

// --- Spotify OAuth, playback, and viewer-request endpoints -----------------------------------

app.MapGet("/api/spotify/auth/start", (string? clientId) =>
{
    try { return Results.Redirect(spotify.BeginAuthorization(clientId)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/spotify/auth/open", (SpotifyAuthorizationRequest request) =>
{
    try
    {
        var authorizationUrl = spotify.BeginAuthorization(request.ClientId);
        Process.Start(new ProcessStartInfo(authorizationUrl) { UseShellExecute = true });
        connectionLog.Record("Spotify", "info", "Opened Spotify authorization in the default browser.");
        return Results.Ok(new { message = "Spotify sign-in opened in your default browser. Complete it there, then return to John's Twitch Handler." });
    }
    catch (Exception exception)
    {
        var message = $"Could not open Spotify sign-in: {exception.GetBaseException().Message}";
        connectionLog.Record("Spotify", "error", message);
        return Results.BadRequest(new { error = $"{message} Confirm the Client ID is from your Spotify developer app." });
    }
});
app.MapGet("/api/spotify/callback", async (string? code, string? state, string? error, CancellationToken cancellationToken) =>
{
    if (!string.IsNullOrWhiteSpace(error))
        return Results.Content("<!doctype html><title>Spotify connection cancelled</title><p>Spotify connection was cancelled. You can close this window.</p>", "text/html");
    if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(state))
        return Results.BadRequest("Spotify did not provide an authorization code.");
    try
    {
        await spotify.CompleteAuthorizationAsync(code, state, cancellationToken);
        connectionLog.Record("Spotify", "success", "Spotify authorization completed and the encrypted connection was saved.");
        return Results.Content("""
            <!doctype html><html><head><meta charset="utf-8"><title>Spotify connected</title>
            <style>body{font:16px system-ui;background:#0b0d13;color:#f5f7fb;display:grid;place-items:center;min-height:90vh}main{text-align:center}strong{color:#55dc98}</style></head>
            <body><main><h1><strong>Spotify connected</strong></h1><p>Return to John's Twitch Handler. You can close this browser tab.</p></main>
            <script>if(window.opener){window.opener.postMessage({type:'streamsidekick-spotify-connected'},window.location.origin);setTimeout(()=>window.close(),1200)}</script></body></html>
            """, "text/html");
    }
    catch (Exception exception)
    {
        var message = $"Spotify authorization failed: {exception.GetBaseException().Message}";
        connectionLog.Record("Spotify", "error", message);
        return Results.BadRequest($"{message} Verify the Spotify redirect URI exactly matches http://127.0.0.1:5274/api/spotify/callback.");
    }
});
app.MapGet("/api/spotify/status", (CancellationToken cancellationToken) => spotify.GetSnapshotAsync(cancellationToken));
app.MapGet("/api/spotify/search", async (string query, CancellationToken cancellationToken) =>
{
    try { return Results.Ok(await spotify.SearchAsync(query, cancellationToken)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPut("/api/spotify/options", (SpotifyAutomationOptions options) =>
{
    try { return Results.Ok(spotify.SetOptions(options)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/spotify/queue", async (SpotifyQueueTrackRequest request, CancellationToken cancellationToken) =>
{
    try { return Results.Ok(await spotify.QueueTrackAsync(request, cancellationToken)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/spotify/skip", async (CancellationToken cancellationToken) =>
{
    try
    {
        await spotify.SkipAsync(cancellationToken);
        return Results.Ok(new { message = "Skipped to the next Spotify track." });
    }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/spotify/requests/approve", async (SpotifyRequestDecision request, CancellationToken cancellationToken) =>
{
    try { return Results.Ok(await spotify.ApproveAsync(request.RequestId, cancellationToken)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/spotify/requests/reject", (SpotifyRequestDecision request) =>
{
    try { return Results.Ok(spotify.Reject(request.RequestId)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/spotify/requests/test", async (SpotifyTestRequest request, CancellationToken cancellationToken) =>
{
    try
    {
        await spotify.ReceiveTestRequestAsync(request, cancellationToken);
        return Results.Ok(await spotify.GetSnapshotAsync(cancellationToken));
    }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/spotify/disconnect", () =>
{
    spotify.Disconnect();
    return Results.Ok(new { connected = false });
});

app.MapPost("/api/nvidia-broadcast/launch", () =>
{
    try
    {
        return Results.Ok(nvidiaBroadcast.Launch());
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});

// --- OBS WebSocket controls ------------------------------------------------------------------

app.MapPost("/api/obs/connect", async (ObsConnectionRequest request, CancellationToken cancellationToken) =>
{
    var url = string.IsNullOrWhiteSpace(request.Url) ? "ws://127.0.0.1:4455" : request.Url.Trim();
    try
    {
        await obs.ConnectAsync(url, request.Password, cancellationToken);
        connectionLog.Record("OBS", "success", $"Connected to OBS WebSocket at {url} and saved the encrypted connection.");
        return Results.Ok(await obs.GetSnapshotAsync(cancellationToken));
    }
    catch (Exception exception)
    {
        var message = ExplainObsError(exception, url);
        connectionLog.Record("OBS", "error", message);
        return Results.BadRequest(new { error = message });
    }
});

app.MapGet("/api/obs/status", (CancellationToken cancellationToken) => obs.GetSnapshotAsync(cancellationToken));
app.MapGet("/api/obs/audio", (CancellationToken cancellationToken) => obs.GetAudioMixerAsync(cancellationToken));
app.MapPost("/api/obs/microphone/unmute", async (CancellationToken cancellationToken) =>
{
    try
    {
        var microphone = await obs.GetMicrophoneStatusAsync(cancellationToken);
        if (!microphone.Connected)
            return Results.BadRequest(new { error = "Connect OBS before unmuting the microphone." });
        if (!microphone.Found || string.IsNullOrWhiteSpace(microphone.SourceName))
            return Results.BadRequest(new { error = "No microphone source was found. Name the OBS source Mic/Aux or include Mic in its name." });
        await obs.SetInputMuteAsync(microphone.SourceName, false, cancellationToken);
        return Results.Ok(new { ok = true, sourceName = microphone.SourceName });
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});

// Tangia is intentionally controlled through OBS instead of a private/undocumented Tangia API.
// This keeps the integration stable and gives one place to manage visibility, audio, and reloads.
app.MapGet("/api/tangia", (CancellationToken cancellationToken) => obs.GetTangiaStatusAsync(cancellationToken));
app.MapPost("/api/tangia/mute", async (TangiaMuteRequest request, CancellationToken cancellationToken) =>
{
    try { return Results.Ok(await obs.SetTangiaMuteAsync(request.Muted, cancellationToken)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/tangia/volume", async (TangiaVolumeRequest request, CancellationToken cancellationToken) =>
{
    try { return Results.Ok(await obs.SetTangiaVolumeAsync(request.VolumeDb, cancellationToken)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/tangia/visibility", async (TangiaVisibilityRequest request, CancellationToken cancellationToken) =>
{
    try { return Results.Ok(await obs.SetTangiaVisibilityAsync(request.Visible, cancellationToken)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/tangia/reload", async (CancellationToken cancellationToken) =>
{
    try { return Results.Ok(await obs.ReloadTangiaAsync(cancellationToken)); }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/tangia/boss-focus", async (TangiaBossFocusRequest request, CancellationToken cancellationToken) =>
{
    try
    {
        var result = await obs.SetTangiaBossFocusAsync(request.Enabled, cancellationToken);
        await sessions.AddActivityAsync("tangia", request.Enabled ? "Tangia Boss Focus enabled" : "Tangia Boss Focus disabled", cancellationToken);
        return Results.Ok(result);
    }
    catch (Exception exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/tangia/interactions", async (TangiaInteractionRequest request, CancellationToken cancellationToken) =>
{
    if (!sessions.HasActiveSession)
        return Results.BadRequest(new { error = "Start a John’s Twitch Handler session before logging a Tangia interaction." });
    var detail = string.IsNullOrWhiteSpace(request.Description)
        ? "Tangia interaction"
        : $"Tangia interaction · {request.Description.Trim()}";
    await sessions.AddActivityAsync("tangia", detail, cancellationToken);
    return Results.Ok(new { recorded = true, detail });
});

app.MapPost("/api/obs/audio/volume", async (ObsAudioVolumeRequest request, CancellationToken cancellationToken) =>
{
    try
    {
        await obs.SetInputVolumeAsync(request.InputName, request.VolumeDb, cancellationToken);
        return Results.Ok(new { ok = true });
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});

app.MapPost("/api/obs/audio/mute", async (ObsAudioMuteRequest request, CancellationToken cancellationToken) =>
{
    try
    {
        await obs.SetInputMuteAsync(request.InputName, request.Muted, cancellationToken);
        return Results.Ok(new { ok = true });
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});

app.MapPost("/api/obs/scene", async (SceneChangeRequest request, CancellationToken cancellationToken) =>
{
    try
    {
        await obs.SetCurrentSceneAsync(request.SceneName, cancellationToken);
        return Results.Ok(new { ok = true });
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});

app.MapPost("/api/obs/replay/save", async (CancellationToken cancellationToken) =>
{
    try
    {
        await obs.SaveReplayBufferAsync(cancellationToken);
        return Results.Ok(new { ok = true });
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});

// --- Session markers and reports --------------------------------------------------------------

app.MapGet("/api/session", async (CancellationToken cancellationToken) =>
    Results.Ok(await sessions.CurrentReportAsync(cancellationToken)));
app.MapPost("/api/session/start", async (SessionStartRequest request, CancellationToken cancellationToken) =>
{
    var session = await sessions.StartAsync(request.Title, cancellationToken);
    if (wardogs.Configured && session.Wardogs?.Baseline is null)
    {
        try
        {
            await sessions.SetActiveWardogsBaselineAsync(
                await wardogs.FetchSnapshotAsync(cancellationToken),
                cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            app.Logger.LogWarning(exception, "Could not capture the Wardogs starting baseline.");
        }
    }
    return Results.Ok(session);
});

app.MapPost("/api/session/end", async (CancellationToken cancellationToken) =>
{
    var report = await sessions.EndAsync(cancellationToken);
    return report is null
        ? Results.BadRequest(new { error = "No session is active." })
        : Results.Ok(report);
});

app.MapGet("/api/reports/latest", async (CancellationToken cancellationToken) =>
{
    var report = await sessions.LatestReportAsync(cancellationToken);
    return report is null ? Results.NotFound(new { error = "No reports found." }) : Results.Ok(report);
});
app.MapGet("/api/reports", async (int? limit, CancellationToken cancellationToken) =>
    Results.Ok(await sessions.ListReportsAsync(limit ?? 30, cancellationToken)));
app.MapGet("/api/reports/{id:guid}", async (Guid id, CancellationToken cancellationToken) =>
{
    var report = await sessions.ReportAsync(id, cancellationToken);
    return report is null ? Results.NotFound(new { error = "That saved stream was not found." }) : Results.Ok(report);
});

app.MapPost("/api/markers", async (MarkerRequest request, CancellationToken cancellationToken) =>
{
    var warnings = new List<string>();
    if (request.SaveReplay)
    {
        try
        {
            await obs.SaveReplayBufferAsync(cancellationToken);
        }
        catch (Exception exception)
        {
            warnings.Add($"Replay was not saved: {exception.Message}");
        }
    }

    var marker = await sessions.AddMarkerAsync(
        request.Title,
        request.Kind,
        request.SaveReplay,
        warnings.Count == 0 ? null : string.Join(" ", warnings),
        cancellationToken);

    if (request.CreateTwitchClip)
    {
        try
        {
            var clip = await twitch.CreateClipAsync(marker.Title, cancellationToken);
            await sessions.UpdateMarkerClipAsync(marker.Id, clip, cancellationToken);
            marker.TwitchClipId = clip.Id;
            marker.TwitchEditUrl = clip.EditUrl;
        }
        catch (Exception exception)
        {
            warnings.Add($"Twitch clip was not created: {exception.Message}");
        }
    }

    return Results.Ok(new { marker, warnings });
});

// --- Wardogs post-stream results --------------------------------------------------------------

app.MapGet("/api/wardogs/status", () => Results.Ok(wardogs.GetStatus()));
app.MapPut("/api/wardogs/settings", (WardogsSettingsRequest request) =>
{
    try { return Results.Ok(wardogs.SaveSettings(request)); }
    catch (ArgumentException exception) { return Results.BadRequest(new { error = exception.Message }); }
});
app.MapPost("/api/wardogs/baseline", async (CancellationToken cancellationToken) =>
{
    if (!sessions.HasActiveSession)
        return Results.BadRequest(new { error = "Start a tracked session before capturing a Wardogs baseline." });
    try
    {
        var snapshot = await wardogs.FetchSnapshotAsync(cancellationToken);
        var report = await sessions.SetActiveWardogsBaselineAsync(snapshot, cancellationToken);
        return Results.Ok(new { snapshot, report, status = wardogs.GetStatus() });
    }
    catch (Exception exception) when (exception is not OperationCanceledException)
    {
        return Results.BadRequest(new { error = exception.Message, status = wardogs.GetStatus() });
    }
});
app.MapPost("/api/wardogs/reconcile", async (WardogsReconcileRequest request, CancellationToken cancellationToken) =>
{
    try
    {
        var snapshot = await wardogs.FetchSnapshotAsync(cancellationToken);
        var report = await sessions.SetWardogsFinalAsync(request.ReportId, snapshot, cancellationToken);
        return report is null
            ? Results.BadRequest(new { error = "No stream report is available for Wardogs results." })
            : Results.Ok(new { snapshot, report, status = wardogs.GetStatus() });
    }
    catch (Exception exception) when (exception is not OperationCanceledException)
    {
        return Results.BadRequest(new { error = exception.Message, status = wardogs.GetStatus() });
    }
});

app.MapGet("/api/twitch/status", () => Results.Ok(twitch.GetStatus()));
app.MapGet("/api/alerts", () => Results.Ok(twitchEvents.GetSnapshot()));
app.MapGet("/api/chat/messages", () => Results.Ok(twitchEvents.GetChatSnapshot()));
app.MapPost("/api/alerts/test", () =>
{
    twitchEvents.AddTestAlert();
    return Results.Ok(twitchEvents.GetSnapshot());
});
app.MapGet("/api/ads/status", () => Results.Ok(adBreaks.GetSnapshot()));
app.MapPut("/api/ads/options", (AdBreakOptions options) =>
{
    try { return Results.Ok(adBreaks.SetOptions(options)); }
    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
    {
        app.Logger.LogWarning(exception, "Could not save ad break options.");
        return Results.Json(new { error = "Could not save the ad break announcement setting." }, statusCode: 500);
    }
});
app.MapPost("/api/ads/start", async (AdBreakStartRequest request, CancellationToken cancellationToken) =>
{
    try
    {
        if (!request.StartOnTwitch)
            return Results.Ok(await adBreaks.BeginAsync(request.DurationSeconds, "Manual timer", cancellationToken: cancellationToken));

        var commercial = await twitch.StartCommercialAsync(request.DurationSeconds, cancellationToken);
        var countdown = await adBreaks.BeginAsync(commercial.LengthSeconds, "Twitch manual ad", cancellationToken: cancellationToken);
        return Results.Ok(new { countdown, commercial.Message, commercial.RetryAfterSeconds });
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.GetBaseException().Message });
    }
});
app.MapPost("/api/twitch/auth/start", async (TwitchAuthorizationRequest request, CancellationToken cancellationToken) =>
{
    try
    {
        var authorization = await twitch.BeginDeviceAuthorizationAsync(request, cancellationToken);
        Process.Start(new ProcessStartInfo(authorization.VerificationUri) { UseShellExecute = true });
        connectionLog.Record("Twitch", "info", "Opened Twitch authorization in the default browser.");

        // Device authorization may take several minutes. Keep polling on the server so closing the
        // Settings dialog does not lose a successful approval.
        RunEventTask(async () =>
        {
            try
            {
                var configuration = await twitch.WaitForDeviceAuthorizationAsync(CancellationToken.None);
                string? alertError = null;
                try { await twitchEvents.ConnectAsync(configuration, CancellationToken.None); }
                catch (Exception exception) { alertError = exception.GetBaseException().Message; }
                connectionLog.Record("Twitch", alertError is null ? "success" : "warning", alertError is null
                    ? "Twitch authorization completed; renewable credentials were encrypted and saved."
                    : $"Twitch authorization was saved, but some live events failed: {alertError}");
            }
            catch (Exception exception)
            {
                connectionLog.Record("Twitch", "error", $"Twitch authorization failed: {exception.GetBaseException().Message}");
                throw;
            }
        }, "complete Twitch device authorization");

        return Results.Ok(new
        {
            message = $"Twitch sign-in opened. Approve John's Twitch Handler in the browser. Activation code: {authorization.UserCode}",
            authorization.UserCode,
            authorization.VerificationUri,
            authorization.ExpiresAt
        });
    }
    catch (Exception exception)
    {
        var message = $"Could not start Twitch sign-in: {exception.GetBaseException().Message}";
        connectionLog.Record("Twitch", "error", message);
        return Results.BadRequest(new { error = message });
    }
});
app.MapPost("/api/twitch/configure", async (TwitchConfigurationRequest request, CancellationToken cancellationToken) =>
{
    try
    {
        // Validate identity and the two permissions required for song-request feedback before storing the token.
        await twitch.ValidateConfigurationAsync(request, cancellationToken);
        twitch.Configure(request);
        string? alertError = null;
        try
        {
            await twitchEvents.ConnectAsync(request, cancellationToken);
        }
        catch (Exception exception)
        {
            alertError = exception.Message;
        }
        connectionLog.Record("Twitch", alertError is null ? "success" : "warning", alertError is null
            ? "Connected Twitch and saved the encrypted credentials."
            : $"Twitch credentials were saved, but some live events failed: {alertError}");
        return Results.Ok(new { configured = true, alertError, alerts = twitchEvents.GetSnapshot() });
    }
    catch (Exception exception)
    {
        var message = $"Twitch connection failed: {exception.GetBaseException().Message}";
        connectionLog.Record("Twitch", "error", message);
        return Results.BadRequest(new { error = message });
    }
});
app.MapDelete("/api/twitch/configure", async () =>
{
    twitch.Clear();
    await twitchEvents.DisconnectAsync();
    return Results.Ok(new { configured = false });
});

// CSV is intentionally generated on demand so the durable JSON report remains the source of truth.
app.MapGet("/api/reports/latest.csv", async (CancellationToken cancellationToken) =>
{
    var report = await sessions.LatestReportAsync(cancellationToken);
    if (report is null)
    {
        return Results.NotFound();
    }

    static string Csv(string? value) => $"\"{(value ?? "").Replace("\"", "\"\"")}\"";
    var lines = new List<string> { "offset,title,kind,twitch_edit_url,note" };
    lines.AddRange(report.Markers.Select(marker => string.Join(",",
        marker.OffsetSeconds.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture),
        Csv(marker.Title),
        Csv(marker.Kind),
        Csv(marker.TwitchEditUrl),
        Csv(marker.Note))));
    lines.AddRange(report.Activities
        .Where(activity => activity.Type is "tangia" or "ad")
        .Select(activity => string.Join(",",
            Math.Max(0, (activity.At - report.StartedAt).TotalSeconds).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture),
            Csv(activity.Detail),
            Csv(activity.Type),
            Csv(null),
            Csv("Session activity"))));
    return Results.Text(string.Join(Environment.NewLine, lines), "text/csv", System.Text.Encoding.UTF8);
});

app.MapFallbackToFile("index.html", dashboardStaticFiles);
app.Run();

static string ExplainObsError(Exception exception, string url)
{
    var message = exception.GetBaseException().Message;
    var normalized = message.ToLowerInvariant();
    if (normalized.Contains("refused") || normalized.Contains("unable to connect") || normalized.Contains("actively refused"))
        return $"OBS is not accepting connections at {url}. Open OBS, then go to Tools → WebSocket Server Settings, enable the server, and confirm port 4455.";
    if (normalized.Contains("password") || normalized.Contains("authentication") || normalized.Contains("identified"))
        return "OBS rejected the WebSocket login. In OBS → Tools → WebSocket Server Settings, copy the current password and try again.";
    if (normalized.Contains("uri") || normalized.Contains("scheme"))
        return "The OBS address is invalid. Use ws://127.0.0.1:4455 unless OBS shows a different port.";
    return $"OBS connection failed: {message}";
}
