namespace StreamSidekick;

// Small request records describe JSON bodies accepted by the local HTTP API.
public sealed record ObsConnectionRequest(string Url, string? Password);
public sealed record SceneChangeRequest(string SceneName);
public sealed record SessionStartRequest(string? Title);
public sealed record MarkerRequest(
    string? Title,
    string? Kind,
    bool SaveReplay = false,
    bool CreateTwitchClip = false);
public sealed record TwitchConfigurationRequest(
    string ClientId,
    string AccessToken,
    string BroadcasterId,
    string? ChannelName = null,
    string? RefreshToken = null,
    DateTimeOffset? ExpiresAt = null);
// ClientId is optional for normal users because distributed builds can carry the Handler's public
// application ID. Keeping the field supports owner/developer overrides without exposing a secret.
public sealed record TwitchAuthorizationRequest(string? ClientId = null, string? ChannelName = null);
public sealed record DashboardLayoutRequest(
    IReadOnlyList<string> PanelOrder,
    IReadOnlyDictionary<string, IReadOnlyList<string>>? PanelPages = null);
public sealed record WardogsSettingsRequest(string? SteamId, string? Server);
public sealed record WardogsReconcileRequest(Guid? ReportId = null);

// A StreamSession is the durable source model written to disk; reports are derived views of it.
public sealed class StreamSession
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Title { get; set; } = "Untitled stream";
    public DateTimeOffset StartedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? EndedAt { get; set; }
    public List<StreamMarker> Markers { get; set; } = [];
    public List<SessionActivity> Activities { get; set; } = [];
    public List<SessionChatMessage> ChatMessages { get; set; } = [];
    public List<PerformanceSample> PerformanceSamples { get; set; } = [];
    public List<SessionResourceSnapshot> ResourceSnapshots { get; set; } = [];
    public WardogsSessionData? Wardogs { get; set; }
}

public sealed class StreamMarker
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Title { get; set; } = "Highlight";
    public string Kind { get; set; } = "clip";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public double OffsetSeconds { get; set; }
    public bool ReplaySaveRequested { get; set; }
    public string? TwitchClipId { get; set; }
    public string? TwitchEditUrl { get; set; }
    public string? Note { get; set; }
}

public sealed class SessionActivity
{
    public DateTimeOffset At { get; set; } = DateTimeOffset.UtcNow;
    public string Type { get; set; } = "event";
    public string Detail { get; set; } = "";
}

// Chat is public stream activity, but it remains in the same local-only session file as the rest
// of the report. We intentionally do not retain Twitch user IDs or account credentials here.
public sealed class SessionChatMessage
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public DateTimeOffset At { get; set; } = DateTimeOffset.UtcNow;
    public string UserName { get; set; } = "Viewer";
    public string Text { get; set; } = "";
}

// Reports contain calculated rollups so the browser does not need to reproduce backend diagnostics.
public sealed record SessionReport(
    Guid Id,
    string Title,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt,
    double DurationMinutes,
    int HighlightCount,
    int SceneChangeCount,
    int ChatMessageCount,
    double AverageCpuPercent,
    double PeakCpuPercent,
    double AverageGpuPercent,
    double PeakGpuPercent,
    double PeakVramPercent,
    string PerformanceSummary,
    IReadOnlyList<StreamMarker> Markers,
    IReadOnlyList<SessionActivity> Activities,
    IReadOnlyList<SessionChatMessage> ChatMessages,
    IReadOnlyList<SessionResourceSummary> TopResourceDrains,
    WardogsSessionData? Wardogs,
    IReadOnlyList<SessionTimelineItem> Timeline);

public sealed record WardogsProviderStatus(
    bool Configured,
    string? SteamId,
    string? Server,
    string Status);

public sealed record WardogsStatSnapshot(
    DateTimeOffset CapturedAt,
    string SteamId,
    string PlayerName,
    string Server,
    string ServerName,
    int Kills,
    int Deaths,
    int Headshots,
    double KillDeathRatio,
    double? LongestKillMeters,
    string? TopWeapon,
    string Source,
    string SourceUrl);

public sealed class WardogsSessionData
{
    public WardogsStatSnapshot? Baseline { get; set; }
    public WardogsStatSnapshot? Final { get; set; }
    public int? Kills { get; set; }
    public int? Deaths { get; set; }
    public int? Headshots { get; set; }
    public bool VerifiedDelta { get; set; }
    public string Status { get; set; } = "Waiting for a baseline.";
    public DateTimeOffset? ReconciledAt { get; set; }
}

// History rows stay deliberately small so opening the After Stream page does not transfer every
// performance sample from every previous broadcast.
public sealed record SessionHistorySummary(
    Guid Id,
    string Title,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt,
    double DurationMinutes,
    int HighlightCount,
    int ChatMessageCount,
    bool Completed,
    string PerformanceSummary);

/// <summary>A normalized item lets the report mix markers, Twitch events, and performance incidents.</summary>
public sealed record SessionTimelineItem(
    DateTimeOffset At,
    double OffsetSeconds,
    string Type,
    string Title,
    string Detail,
    string Severity = "info");

public sealed record PerformanceSample(
    DateTimeOffset At,
    double CpuPercent,
    double GpuPercent,
    double MemoryPercent,
    double VramPercent,
    double? GpuTemperatureC,
    string? GpuName = null);

/// <summary>
/// Aggregates processes with the same executable name (for example, all Chrome helper processes)
/// so the dashboard ranks programs rather than individual operating-system process IDs.
/// </summary>
public sealed record ResourceDrain(
    string Name,
    int ProcessCount,
    double CpuPercent,
    double MemoryMb,
    string Assessment,
    string Recommendation);

public sealed record SessionResourceSnapshot(
    DateTimeOffset At,
    IReadOnlyList<ResourceDrain> Drains);

public sealed record SessionResourceSummary(
    string Name,
    int Observations,
    double AverageCpuPercent,
    double PeakCpuPercent,
    double AverageMemoryMb,
    double PeakMemoryMb,
    string Assessment,
    string Recommendation);

public sealed record SystemPerformanceSnapshot(
    PerformanceSample Current,
    IReadOnlyList<PerformanceSample> History,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<ResourceDrain> ResourceDrains);

/// <summary>
/// A short connection event is retained separately from routine samples so the streamer gets a
/// useful timestamped timeline instead of a noisy row for every successful five-second check.
/// </summary>
public sealed record InternetConnectionEvent(
    DateTimeOffset At,
    string Level,
    string Message,
    double? LatencyMs);

public sealed record InternetConnectionSnapshot(
    DateTimeOffset LastCheckedAt,
    bool Online,
    double? LatencyMs,
    double FailurePercent,
    string Status,
    string Detail,
    IReadOnlyList<InternetConnectionEvent> Events);

// OBS profile models keep analysis, recommendation, and reversible-action state distinct.
public sealed record ObsProfileAnalysis(
    bool Found,
    string? ProfileName,
    string? ChannelName,
    string? CurrentResolution,
    int? CurrentFps,
    string? CurrentEncoder,
    int? CurrentBitrateKbps,
    string Verdict,
    BroadcastPreset Recommendation);

public sealed record BroadcastPreset(
    string Resolution,
    int Fps,
    int VideoBitrateKbps,
    int AudioBitrateKbps,
    string Encoder,
    string RateControl,
    int KeyframeIntervalSeconds,
    string Preset,
    string DownscaleFilter,
    string Rationale);

public sealed record ObsOptimizerStatus(
    bool ObsRunning,
    bool BackupAvailable,
    string? BackupProfileName,
    DateTimeOffset? BackupCreatedAt);

public sealed record ObsOptimizerActionResult(
    bool Applied,
    string Message,
    ObsProfileAnalysis Analysis,
    ObsOptimizerStatus Status);

public sealed record ObsSceneSnapshot(
    bool Connected,
    string? CurrentScene,
    IReadOnlyList<string> Scenes,
    bool? StreamActive,
    bool? RecordingActive,
    bool? ReplayBufferActive,
    double? ObsCpuPercent = null,
    double? ActiveFps = null,
    double? RenderSkippedPercent = null,
    double? OutputSkippedPercent = null,
    double? OutputCongestion = null,
    string? Error = null);

public sealed record ObsAudioMixerSnapshot(
    bool Connected,
    IReadOnlyList<ObsAudioInput> Inputs,
    string? Error = null);

public sealed record ObsAudioInput(
    string InputName,
    string InputKind,
    double VolumeDb,
    bool Muted,
    double MeterPercent);

public sealed record ObsAudioVolumeRequest(string InputName, double VolumeDb);
public sealed record ObsAudioMuteRequest(string InputName, bool Muted);

// Preflight reports the most likely OBS microphone without exposing or storing device details.
public sealed record ObsMicrophoneCheck(
    bool Connected,
    bool Found,
    bool Muted,
    string Status,
    string? SourceName = null);

// Tangia runs as an OBS Browser Source. These models expose only the controls needed on stream;
// the private overlay URL remains inside OBS and is never returned to the browser dashboard.
public sealed record TangiaSourceSnapshot(
    bool Connected,
    bool Found,
    string Status,
    string? SourceName = null,
    bool Muted = false,
    double VolumeDb = 0,
    bool? Visible = null,
    bool BossFocusActive = false);
public sealed record TangiaVolumeRequest(double VolumeDb);
public sealed record TangiaMuteRequest(bool Muted);
public sealed record TangiaVisibilityRequest(bool Visible);
public sealed record TangiaBossFocusRequest(bool Enabled);
public sealed record TangiaInteractionRequest(string? Description);

// Ad countdowns are derived from timestamps instead of ticking on the server every second. This
// keeps the tracker inexpensive while allowing every open dashboard to display the same timer.
public sealed record AdBreakStartRequest(int DurationSeconds, bool StartOnTwitch = true);
public sealed record AdBreakSnapshot(
    bool Active,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndsAt,
    int DurationSeconds,
    int RemainingSeconds,
    string Source,
    string Status,
    bool AnnounceInChat,
    string StartMessage,
    string EndMessage);
public sealed record TwitchCommercialResult(int LengthSeconds, string Message, int RetryAfterSeconds);
public sealed record TwitchAdBreak(
    DateTimeOffset StartedAt,
    int DurationSeconds,
    bool Automatic,
    string? RequesterName = null);

// Used by preflight to confirm the viewer-facing queue was actually added to OBS.
public sealed record ObsBrowserSourceCheck(
    bool Found,
    string Status,
    string? SourceName = null);

// Twitch feed records are intentionally provider-neutral enough for local warnings and test alerts too.
public sealed record TwitchClipResult(string Id, string EditUrl);

public sealed record StreamAlert(
    string Id,
    DateTimeOffset At,
    string Type,
    string Title,
    string Detail,
    string? UserName = null);

public sealed record AlertFeedSnapshot(
    bool Connected,
    string Status,
    IReadOnlyList<string> SetupWarnings,
    IReadOnlyList<StreamAlert> Alerts);

// Chat chimes are deliberately rendered by OBS as Monitor Only. The safety/status fields let the
// dashboard explain when Desktop Audio could loop the monitored tone back into the broadcast.
public sealed record PrivateChatChimeOptions(bool Enabled, double VolumeDb);
public sealed record PrivateChatChimeSnapshot(
    bool Enabled,
    double VolumeDb,
    bool ObsConnected,
    bool SafeToPlay,
    string Status,
    string? LastViewer = null,
    DateTimeOffset? LastPlayedAt = null);

// These legacy snapshot records are retained for JSON/report compatibility; the richer addon UI types
// used by WowAddonService live beside that service.
public sealed record WowAddonSnapshot(
    bool Found,
    bool GameRunning,
    DateTimeOffset ScannedAt,
    IReadOnlyList<WowEditionSnapshot> Editions,
    IReadOnlyList<string> Recommendations);

public sealed record WowEditionSnapshot(
    string Id,
    string Name,
    string InstallPath,
    int AddonFolderCount,
    double TotalAddonSizeMb,
    bool ProfilerInstalled,
    DateTimeOffset? ProfilerCapturedAt,
    IReadOnlyList<WowAddonInfo> Addons);

public sealed record WowAddonInfo(
    string FolderName,
    string Title,
    string? Version,
    double SizeMb,
    double SavedVariablesMb,
    DateTimeOffset LastModified,
    double? RecentAverageMs,
    double? SessionAverageMs,
    double? PeakMs,
    int? SpikesOver10Ms,
    int? SpikesOver50Ms);
