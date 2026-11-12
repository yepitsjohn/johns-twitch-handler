using System.Text.Json;
using System.Text.Json.Serialization;

namespace StreamSidekick.Services;

public sealed record AdBreakOptions([property: JsonRequired] bool AnnounceInChat);

/// <summary>
/// Tracks one ad break, optionally announces it in Twitch chat, and writes both timestamps to the
/// active session. A generation number prevents an older countdown from ending a newer break.
/// </summary>
public sealed class AdBreakService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly TwitchClient twitch;
    private readonly TwitchEventSubService twitchEvents;
    private readonly SessionStore sessions;
    private readonly ILogger<AdBreakService> logger;
    private readonly object _sync = new();
    private readonly string _optionsPath;
    private AdBreakOptions _options = new(false);
    private DateTimeOffset? _startedAt;
    private DateTimeOffset? _endsAt;
    private int _durationSeconds;
    private string _source = "None";
    private string _status = "No ad break is running.";
    private long _generation;

    public AdBreakService(
        TwitchClient twitch,
        TwitchEventSubService twitchEvents,
        SessionStore sessions,
        IConfiguration configuration,
        ILogger<AdBreakService> logger)
    {
        this.twitch = twitch;
        this.twitchEvents = twitchEvents;
        this.sessions = sessions;
        this.logger = logger;
        var directory = configuration["PreferencesDirectory"] ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StreamSidekick");
        _optionsPath = Path.Combine(directory, "ad-break-options.json");
        try
        {
            if (File.Exists(_optionsPath))
                _options = JsonSerializer.Deserialize<AdBreakOptions>(File.ReadAllText(_optionsPath), JsonOptions)
                    ?? throw new JsonException("The ad break options were empty.");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            logger.LogWarning(exception, "Could not load ad break options. Chat announcements will stay off.");
        }
    }

    public AdBreakSnapshot GetSnapshot()
    {
        lock (_sync) return GetSnapshotUnsafe();
    }

    public AdBreakSnapshot SetOptions(AdBreakOptions options)
    {
        lock (_sync)
        {
            if (_options == options) return GetSnapshotUnsafe();
            Directory.CreateDirectory(Path.GetDirectoryName(_optionsPath)!);
            var temporary = _optionsPath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(options, JsonOptions));
            File.Move(temporary, _optionsPath, overwrite: true);
            _options = options;
            return GetSnapshotUnsafe();
        }
    }

    public async Task<AdBreakSnapshot> BeginAsync(
        int durationSeconds,
        string source,
        DateTimeOffset? startedAt = null,
        CancellationToken cancellationToken = default)
    {
        durationSeconds = Math.Clamp(durationSeconds, 1, 180);
        var start = startedAt ?? DateTimeOffset.UtcNow;
        long generation;
        lock (_sync)
        {
            // Twitch sends an EventSub notification shortly after a manual API request. Treat that
            // as confirmation of the same break so chat receives only one start/end announcement.
            if (_endsAt > DateTimeOffset.UtcNow
                && _startedAt is { } existingStart
                && Math.Abs((start - existingStart).TotalSeconds) < 15
                && Math.Abs(durationSeconds - _durationSeconds) <= 5)
            {
                _source = source;
                _status = $"{durationSeconds}-second ad break in progress.";
                return GetSnapshotUnsafe();
            }

            _startedAt = start;
            _endsAt = start.AddSeconds(durationSeconds);
            _durationSeconds = durationSeconds;
            _source = source;
            _status = $"{durationSeconds}-second ad break in progress.";
            generation = ++_generation;
        }

        await sessions.AddActivityAsync("ad", $"Ad break started · {durationSeconds}s · {source}", cancellationToken);
        twitchEvents.AddLocalAlert("ad", "Ad break started", $"{durationSeconds} seconds · {source}");
        await TrySendChatAsync($"John's Twitch Handler: Ad break started ({durationSeconds} seconds). We'll be right back!", cancellationToken);

        _ = CompleteAfterDelayAsync(generation, start.AddSeconds(durationSeconds));
        return GetSnapshot();
    }

    private AdBreakSnapshot GetSnapshotUnsafe()
    {
        var now = DateTimeOffset.UtcNow;
        var end = _endsAt;
        var active = end.HasValue && end.Value > now;
        return new AdBreakSnapshot(
            active,
            _startedAt,
            _endsAt,
            _durationSeconds,
            active ? Math.Max(0, (int)Math.Ceiling((end!.Value - now).TotalSeconds)) : 0,
            _source,
            active ? _status : "No ad break is running.",
            _options.AnnounceInChat);
    }

    private async Task CompleteAfterDelayAsync(long generation, DateTimeOffset expectedEnd)
    {
        try
        {
            var delay = expectedEnd - DateTimeOffset.UtcNow;
            if (delay > TimeSpan.Zero) await Task.Delay(delay);

            lock (_sync)
            {
                if (generation != _generation) return;
                _status = "Ad break complete.";
            }

            await sessions.AddActivityAsync("ad", "Ad break ended");
            twitchEvents.AddLocalAlert("ad", "Ad break ended", "The stream is back.");
            await TrySendChatAsync("John's Twitch Handler: Ad break complete. Welcome back!");
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Could not finish the ad-break countdown cleanly.");
        }
    }

    private async Task TrySendChatAsync(string message, CancellationToken cancellationToken = default)
    {
        lock (_sync)
        {
            if (!_options.AnnounceInChat) return;
        }

        try
        {
            await twitch.SendChatMessageAsync(message, cancellationToken);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Could not send an ad-break message to Twitch chat.");
            twitchEvents.AddLocalAlert(
                "warning",
                "Ad message was not sent",
                "Reconnect Twitch and make sure user:write:chat is approved.");
        }
    }
}
