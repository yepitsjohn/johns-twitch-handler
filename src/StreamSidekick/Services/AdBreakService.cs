using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace StreamSidekick.Services;

public sealed record AdBreakOptions([property: JsonRequired] bool AnnounceInChat);
public sealed record AdBreakMessages(
    [property: JsonRequired] string? StartMessage,
    [property: JsonRequired] string? EndMessage);

/// <summary>
/// Tracks one ad break, optionally announces it in Twitch chat, and writes both timestamps to the
/// active session. A generation number prevents an older countdown from ending a newer break.
/// </summary>
public sealed class AdBreakService
{
    private const string DefaultStartMessage = "John's Twitch Handler: Ad break started ({seconds} seconds). We'll be right back!";
    private const string DefaultEndMessage = "John's Twitch Handler: Ad break complete. Welcome back!";

    private sealed record SavedOptions(
        [property: JsonRequired] bool AnnounceInChat,
        string? StartMessage = null,
        string? EndMessage = null);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly TwitchClient twitch;
    private readonly TwitchEventSubService twitchEvents;
    private readonly SessionStore sessions;
    private readonly ILogger<AdBreakService> logger;
    private readonly object _sync = new();
    private readonly string _optionsPath;
    private SavedOptions _options = new(false);
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
            {
                var saved = JsonSerializer.Deserialize<SavedOptions>(File.ReadAllText(_optionsPath), JsonOptions)
                    ?? throw new JsonException("The ad break options were empty.");
                _options = saved with
                {
                    StartMessage = NormalizeMessage(saved.StartMessage, "Start message"),
                    EndMessage = NormalizeMessage(saved.EndMessage, "End message")
                };
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
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
        lock (_sync) return SaveOptionsUnsafe(_options with { AnnounceInChat = options.AnnounceInChat });
    }

    public AdBreakSnapshot SetMessages(AdBreakMessages messages)
    {
        var start = NormalizeMessage(messages.StartMessage, "Start message");
        var end = NormalizeMessage(messages.EndMessage, "End message");
        lock (_sync) return SaveOptionsUnsafe(_options with { StartMessage = start, EndMessage = end });
    }

    private AdBreakSnapshot SaveOptionsUnsafe(SavedOptions options)
    {
        if (_options != options)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_optionsPath)!);
            var temporary = _optionsPath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(options, JsonOptions));
            File.Move(temporary, _optionsPath, overwrite: true);
            _options = options;
        }
        return GetSnapshotUnsafe();
    }

    private static string? NormalizeMessage(string? message, string label)
    {
        var trimmed = message?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        if (trimmed.Length > TwitchClient.MaxChatMessageLength)
            throw new ArgumentException($"{label} must be {TwitchClient.MaxChatMessageLength} characters or fewer.");
        if (trimmed.Contains('\n') || trimmed.Contains('\r'))
            throw new ArgumentException($"{label} must fit on one line.");
        return trimmed;
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
        await TrySendChatAsync(atStart: true, durationSeconds, cancellationToken);

        _ = CompleteAfterDelayAsync(generation, start.AddSeconds(durationSeconds), durationSeconds);
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
            _options.AnnounceInChat,
            _options.StartMessage ?? DefaultStartMessage,
            _options.EndMessage ?? DefaultEndMessage);
    }

    private async Task CompleteAfterDelayAsync(long generation, DateTimeOffset expectedEnd, int durationSeconds)
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
            await TrySendChatAsync(atStart: false, durationSeconds);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Could not finish the ad-break countdown cleanly.");
        }
    }

    private async Task TrySendChatAsync(bool atStart, int durationSeconds, CancellationToken cancellationToken = default)
    {
        string template;
        lock (_sync)
        {
            if (!_options.AnnounceInChat) return;
            template = atStart ? _options.StartMessage ?? DefaultStartMessage : _options.EndMessage ?? DefaultEndMessage;
        }

        try
        {
            var message = template.Replace("{seconds}", durationSeconds.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);
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
