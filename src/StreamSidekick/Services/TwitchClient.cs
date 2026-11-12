using System.Net.Http.Headers;
using System.Text.Json;

namespace StreamSidekick.Services;

public sealed record TwitchDeviceAuthorization(
    string UserCode,
    string VerificationUri,
    DateTimeOffset ExpiresAt,
    int PollIntervalSeconds);

public sealed record TwitchConnectionStatus(
    bool Configured,
    bool Renewable,
    string Status,
    string? ChannelName,
    bool ApplicationConfigured);

internal sealed record TwitchTokenDetails(
    string ClientId,
    string UserId,
    string? Login,
    IReadOnlySet<string> Scopes);

/// <summary>
/// Owns Twitch authorization, encrypted token persistence, refresh-token rotation, and Helix
/// actions. The device flow lets a Windows client stay signed in without retaining a client secret.
/// </summary>
public sealed class TwitchClient
{
    internal const int MaxChatMessageLength = 500;
    private const string DeviceGrantType = "urn:ietf:params:oauth:grant-type:device_code";
    private static readonly string[] RequiredScopes =
    [
        "clips:edit",
        "moderator:read:followers",
        "channel:read:subscriptions",
        "bits:read",
        "channel:read:redemptions",
        "user:read:chat",
        "user:write:chat"
    ];
    // Ad permissions are requested for new sign-ins but remain optional when validating an older
    // saved/manual token. This preserves the existing Twitch connection until John chooses to
    // reconnect and approve the two new capabilities.
    private static readonly string[] RequestedScopes =
    [
        .. RequiredScopes,
        "channel:read:ads",
        "channel:edit:commercial"
    ];
    private static readonly string ScopeText = string.Join(' ', RequestedScopes);

    private readonly IHttpClientFactory httpClientFactory;
    private readonly SecureConnectionStore connectionStore;
    private readonly ConnectionDiagnosticsLog diagnostics;
    private readonly string? _packagedClientId;
    private readonly object _sync = new();
    private readonly SemaphoreSlim _tokenRefreshGate = new(1, 1);
    private TwitchConfigurationRequest? _configuration;
    private string? _refreshToken;
    private DateTimeOffset _expiresAt;
    private string? _pendingDeviceCode;
    private string? _pendingClientId;
    private string? _pendingChannelName;
    private DateTimeOffset _pendingExpiresAt;
    private int _pendingIntervalSeconds;
    private string _status = "Twitch is not connected.";

    public TwitchClient(
        IHttpClientFactory httpClientFactory,
        SecureConnectionStore connectionStore,
        ConnectionDiagnosticsLog diagnostics,
        IConfiguration configuration)
    {
        this.httpClientFactory = httpClientFactory;
        this.connectionStore = connectionStore;
        this.diagnostics = diagnostics;
        _packagedClientId = NormalizeClientId(configuration["Integrations:Twitch:ClientId"]);

        var saved = connectionStore.Read().Twitch;
        if (saved is null) return;
        _configuration = FromStored(saved);
        _refreshToken = saved.RefreshToken;
        _expiresAt = saved.ExpiresAt;
        _status = string.IsNullOrWhiteSpace(saved.RefreshToken)
            ? "Restored the saved Twitch token. Reconnect with Twitch to enable automatic renewal."
            : "Restored the renewable Twitch connection.";
    }

    public bool IsConfigured
    {
        get { lock (_sync) return _configuration is not null; }
    }

    public TwitchConnectionStatus GetStatus()
    {
        lock (_sync)
        {
            return new TwitchConnectionStatus(
                _configuration is not null,
                !string.IsNullOrWhiteSpace(_refreshToken),
                _status,
                _configuration?.ChannelName,
                !string.IsNullOrWhiteSpace(_packagedClientId) || _configuration is not null);
        }
    }

    /// <summary>Begins Twitch's public-client device flow; the caller opens the returned URI.</summary>
    public async Task<TwitchDeviceAuthorization> BeginDeviceAuthorizationAsync(
        TwitchAuthorizationRequest request,
        CancellationToken cancellationToken = default)
    {
        // A tester should only approve Twitch. The public Client ID comes from the packaged app;
        // an explicit value is retained solely as an advanced owner/developer fallback.
        var clientId = NormalizeClientId(request.ClientId)
            ?? _packagedClientId
            ?? GetConfiguration()?.ClientId
            ?? "";
        if (clientId.Length is < 16 or > 128 || clientId.Any(character => !char.IsLetterOrDigit(character)))
            throw new InvalidOperationException("This build is missing the Twitch application ID. The person who packaged John's Twitch Handler must add it to appsettings.json.");

        using var client = httpClientFactory.CreateClient();
        using var response = await client.PostAsync(
            "https://id.twitch.tv/oauth2/device",
            new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["client_id"] = clientId,
                ["scopes"] = ScopeText
            }),
            cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(ReadTwitchError(body) ?? $"Twitch device authorization failed ({(int)response.StatusCode}).");

        using var json = JsonDocument.Parse(body);
        var root = json.RootElement;
        var deviceCode = root.GetProperty("device_code").GetString()
            ?? throw new InvalidOperationException("Twitch did not return a device code.");
        var userCode = root.GetProperty("user_code").GetString()
            ?? throw new InvalidOperationException("Twitch did not return an activation code.");
        var verificationUri = root.GetProperty("verification_uri").GetString()
            ?? throw new InvalidOperationException("Twitch did not return an activation page.");
        var expiresAt = DateTimeOffset.UtcNow.AddSeconds(root.GetProperty("expires_in").GetInt32());
        var interval = Math.Max(2, root.GetProperty("interval").GetInt32());

        lock (_sync)
        {
            _pendingDeviceCode = deviceCode;
            _pendingClientId = clientId;
            _pendingChannelName = request.ChannelName?.Trim();
            _pendingExpiresAt = expiresAt;
            _pendingIntervalSeconds = interval;
            _status = $"Waiting for Twitch authorization. Activation code: {userCode}";
        }
        return new TwitchDeviceAuthorization(userCode, verificationUri, expiresAt, interval);
    }

    /// <summary>Polls Twitch until browser authorization completes, then stores renewable tokens.</summary>
    public async Task<TwitchConfigurationRequest> WaitForDeviceAuthorizationAsync(
        CancellationToken cancellationToken = default)
    {
        string deviceCode;
        string clientId;
        string? requestedChannel;
        DateTimeOffset expiresAt;
        int interval;
        lock (_sync)
        {
            deviceCode = _pendingDeviceCode ?? throw new InvalidOperationException("Start Twitch authorization first.");
            clientId = _pendingClientId ?? throw new InvalidOperationException("The Twitch Client ID is missing.");
            requestedChannel = _pendingChannelName;
            expiresAt = _pendingExpiresAt;
            interval = _pendingIntervalSeconds;
        }

        while (DateTimeOffset.UtcNow < expiresAt)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(TimeSpan.FromSeconds(interval), cancellationToken);
            using var client = httpClientFactory.CreateClient();
            using var response = await client.PostAsync(
                "https://id.twitch.tv/oauth2/token",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["client_id"] = clientId,
                    ["scopes"] = ScopeText,
                    ["device_code"] = deviceCode,
                    ["grant_type"] = DeviceGrantType
                }),
                cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                var error = ReadTwitchError(body) ?? $"HTTP {(int)response.StatusCode}";
                if (error.Contains("authorization_pending", StringComparison.OrdinalIgnoreCase)) continue;
                if (error.Contains("slow_down", StringComparison.OrdinalIgnoreCase))
                {
                    interval += 5;
                    continue;
                }
                SetAuthorizationFailure($"Twitch authorization failed: {error}");
                throw new InvalidOperationException(error);
            }

            using var json = JsonDocument.Parse(body);
            var accessToken = json.RootElement.GetProperty("access_token").GetString()
                ?? throw new InvalidOperationException("Twitch did not return an access token.");
            var refreshToken = json.RootElement.GetProperty("refresh_token").GetString()
                ?? throw new InvalidOperationException("Twitch did not return a refresh token.");
            var tokenExpiresAt = DateTimeOffset.UtcNow.AddSeconds(json.RootElement.GetProperty("expires_in").GetInt32());
            var details = await ValidateTokenAsync(accessToken, cancellationToken);
            EnsureTokenMatches(clientId, null, details);
            EnsureRequiredScopes(details.Scopes);

            var configuration = new TwitchConfigurationRequest(
                clientId,
                accessToken,
                details.UserId,
                string.IsNullOrWhiteSpace(requestedChannel) ? details.Login : requestedChannel,
                refreshToken,
                tokenExpiresAt);
            lock (_sync)
            {
                // A newer authorization attempt supersedes this one instead of letting stale tokens win.
                if (!string.Equals(_pendingDeviceCode, deviceCode, StringComparison.Ordinal))
                    throw new InvalidOperationException("A newer Twitch connection attempt replaced this one.");
                SetConfigurationUnsafe(configuration);
                ClearPendingUnsafe();
                _status = $"Twitch connected as {configuration.ChannelName ?? details.Login ?? details.UserId}; automatic token renewal is enabled.";
            }
            return configuration;
        }

        SetAuthorizationFailure("Twitch authorization expired before it was approved. Click Connect with Twitch and try again.");
        throw new InvalidOperationException("Twitch authorization expired before it was approved.");
    }

    /// <summary>Manual tokens remain supported as a fallback, but cannot renew without a refresh token.</summary>
    public void Configure(TwitchConfigurationRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.ClientId)
            || string.IsNullOrWhiteSpace(request.AccessToken)
            || string.IsNullOrWhiteSpace(request.BroadcasterId))
            throw new ArgumentException("Client ID, access token, and broadcaster ID are required.");

        lock (_sync)
        {
            SetConfigurationUnsafe(request with
            {
                ClientId = request.ClientId.Trim(),
                AccessToken = NormalizeToken(request.AccessToken),
                BroadcasterId = request.BroadcasterId.Trim(),
                ChannelName = request.ChannelName?.Trim()
            });
            _status = string.IsNullOrWhiteSpace(request.RefreshToken)
                ? "Twitch connected with a manual token; automatic token renewal is unavailable."
                : "Twitch connected; automatic token renewal is enabled.";
        }
    }

    public TwitchConfigurationRequest? GetConfiguration()
    {
        lock (_sync) return _configuration;
    }

    public async Task<TwitchConfigurationRequest> GetValidConfigurationAsync(
        CancellationToken cancellationToken = default)
    {
        TwitchConfigurationRequest configuration;
        string? refreshToken;
        DateTimeOffset expiresAt;
        lock (_sync)
        {
            configuration = _configuration ?? throw new InvalidOperationException("Twitch is not configured.");
            refreshToken = _refreshToken;
            expiresAt = _expiresAt;
        }

        if (!string.IsNullOrWhiteSpace(refreshToken)
            && (expiresAt == default || expiresAt <= DateTimeOffset.UtcNow.AddMinutes(2)))
            return await RefreshAccessTokenAsync(cancellationToken);
        return configuration;
    }

    public async Task ValidateConfigurationAsync(
        TwitchConfigurationRequest request,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(request.ClientId)
            || string.IsNullOrWhiteSpace(request.AccessToken)
            || string.IsNullOrWhiteSpace(request.BroadcasterId))
            throw new ArgumentException("Client ID, access token, and broadcaster ID are required.");

        var details = await ValidateTokenAsync(NormalizeToken(request.AccessToken), cancellationToken);
        EnsureTokenMatches(request.ClientId.Trim(), request.BroadcasterId.Trim(), details);
        EnsureRequiredScopes(details.Scopes);
    }

    public void Clear()
    {
        lock (_sync)
        {
            _configuration = null;
            _refreshToken = null;
            _expiresAt = default;
            ClearPendingUnsafe();
            _status = "Twitch is not connected.";
            connectionStore.ClearTwitch();
        }
    }

    public async Task<TwitchClipResult> CreateClipAsync(string? title, CancellationToken cancellationToken = default)
    {
        var configuration = await GetValidConfigurationAsync(cancellationToken);
        using var client = httpClientFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", configuration.AccessToken);
        client.DefaultRequestHeaders.Add("Client-Id", configuration.ClientId);

        var query = $"broadcaster_id={Uri.EscapeDataString(configuration.BroadcasterId)}";
        if (!string.IsNullOrWhiteSpace(title)) query += $"&title={Uri.EscapeDataString(title.Trim())}";
        using var response = await client.PostAsync($"https://api.twitch.tv/helix/clips?{query}", null, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Twitch returned {(int)response.StatusCode}: {body}");

        using var json = JsonDocument.Parse(body);
        var clip = json.RootElement.GetProperty("data").EnumerateArray().FirstOrDefault();
        if (clip.ValueKind == JsonValueKind.Undefined)
            throw new InvalidOperationException("Twitch accepted the request but did not return a clip.");
        return new TwitchClipResult(
            clip.GetProperty("id").GetString() ?? "",
            clip.GetProperty("edit_url").GetString() ?? "");
    }

    public async Task SendChatMessageAsync(string message, CancellationToken cancellationToken = default)
    {
        var configuration = await GetValidConfigurationAsync(cancellationToken);
        var trimmed = message.Trim();
        if (trimmed.Length is < 1 or > MaxChatMessageLength)
            throw new ArgumentException($"Twitch chat messages must be 1–{MaxChatMessageLength} characters.");

        using var client = httpClientFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", configuration.AccessToken);
        client.DefaultRequestHeaders.Add("Client-Id", configuration.ClientId);
        using var response = await client.PostAsJsonAsync("https://api.twitch.tv/helix/chat/messages", new
        {
            broadcaster_id = configuration.BroadcasterId,
            sender_id = configuration.BroadcasterId,
            message = trimmed
        }, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Twitch chat returned {(int)response.StatusCode}. Confirm the token includes user:write:chat.");

        using var json = JsonDocument.Parse(body);
        var result = json.RootElement.GetProperty("data").EnumerateArray().FirstOrDefault();
        if (result.ValueKind == JsonValueKind.Undefined)
            throw new InvalidOperationException("Twitch did not return a chat-message result.");
        if (result.TryGetProperty("is_sent", out var sent) && !sent.GetBoolean())
        {
            var reason = result.TryGetProperty("drop_reason", out var dropReason)
                && dropReason.ValueKind == JsonValueKind.Object
                && dropReason.TryGetProperty("message", out var reasonMessage)
                    ? reasonMessage.GetString()
                    : null;
            throw new InvalidOperationException(reason ?? "Twitch dropped the confirmation message.");
        }
    }

    /// <summary>
    /// Reads public live status for the Raid Manager. Helix accepts up to 100 login names per call
    /// and this endpoint needs no permission beyond the saved authenticated Twitch connection.
    /// </summary>
    public async Task<IReadOnlyList<TwitchLiveChannel>> GetLiveChannelsAsync(
        IEnumerable<string> channelNames,
        CancellationToken cancellationToken = default)
    {
        var names = channelNames
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Select(name => name.Trim().TrimStart('@').ToLowerInvariant())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(100)
            .ToList();
        if (names.Count == 0) return [];

        var configuration = await GetValidConfigurationAsync(cancellationToken);
        using var client = httpClientFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", configuration.AccessToken);
        client.DefaultRequestHeaders.Add("Client-Id", configuration.ClientId);
        var query = string.Join('&', names.Select(name => $"user_login={Uri.EscapeDataString(name)}"));
        using var response = await client.GetAsync($"https://api.twitch.tv/helix/streams?{query}", cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Twitch live-status check failed: {ReadTwitchError(body) ?? $"HTTP {(int)response.StatusCode}"}");

        using var json = JsonDocument.Parse(body);
        return json.RootElement.GetProperty("data").EnumerateArray().Select(item => new TwitchLiveChannel(
            item.GetProperty("user_login").GetString() ?? "",
            item.GetProperty("user_name").GetString() ?? "",
            item.GetProperty("title").GetString() ?? "",
            item.GetProperty("game_name").GetString() ?? "",
            item.GetProperty("viewer_count").GetInt32())).ToList();
    }

    /// <summary>Starts a real Twitch commercial; Twitch limits this to live Affiliate/Partner channels.</summary>
    public async Task<TwitchCommercialResult> StartCommercialAsync(
        int durationSeconds,
        CancellationToken cancellationToken = default)
    {
        if (durationSeconds is not (30 or 60 or 90 or 120 or 150 or 180))
            throw new ArgumentException("Choose an ad length of 30, 60, 90, 120, 150, or 180 seconds.");

        var configuration = await GetValidConfigurationAsync(cancellationToken);
        using var client = httpClientFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", configuration.AccessToken);
        client.DefaultRequestHeaders.Add("Client-Id", configuration.ClientId);
        using var response = await client.PostAsJsonAsync(
            "https://api.twitch.tv/helix/channels/commercial",
            new { broadcaster_id = configuration.BroadcasterId, length = durationSeconds },
            cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var reason = ReadTwitchError(body) ?? $"HTTP {(int)response.StatusCode}";
            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                throw new InvalidOperationException("Reconnect Twitch to approve channel:edit:commercial, then try again.");
            if ((int)response.StatusCode == 400)
                throw new InvalidOperationException($"Twitch could not start the ad. Make sure the channel is live and eligible for ads. {reason}");
            if ((int)response.StatusCode == 429)
                throw new InvalidOperationException($"Twitch says another ad cannot run yet. {reason}");
            throw new InvalidOperationException($"Twitch ad request failed: {reason}");
        }

        using var json = JsonDocument.Parse(body);
        var result = json.RootElement.GetProperty("data").EnumerateArray().FirstOrDefault();
        if (result.ValueKind == JsonValueKind.Undefined)
            throw new InvalidOperationException("Twitch accepted the ad request but returned no countdown information.");
        return new TwitchCommercialResult(
            result.TryGetProperty("length", out var length) ? length.GetInt32() : durationSeconds,
            result.TryGetProperty("message", out var message) ? message.GetString() ?? "Commercial started." : "Commercial started.",
            result.TryGetProperty("retry_after", out var retry) ? retry.GetInt32() : 0);
    }

    private async Task<TwitchConfigurationRequest> RefreshAccessTokenAsync(CancellationToken cancellationToken)
    {
        await _tokenRefreshGate.WaitAsync(cancellationToken);
        try
        {
            TwitchConfigurationRequest configuration;
            string refreshToken;
            lock (_sync)
            {
                configuration = _configuration ?? throw new InvalidOperationException("Twitch is not configured.");
                if (!string.IsNullOrWhiteSpace(_refreshToken)
                    && _expiresAt > DateTimeOffset.UtcNow.AddMinutes(2)) return configuration;
                refreshToken = _refreshToken
                    ?? throw new InvalidOperationException("This Twitch token cannot renew itself. Use Connect with Twitch once to enable automatic renewal.");
            }

            using var client = httpClientFactory.CreateClient();
            using var response = await client.PostAsync(
                "https://id.twitch.tv/oauth2/token",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["client_id"] = configuration.ClientId,
                    ["grant_type"] = "refresh_token",
                    ["refresh_token"] = refreshToken
                }),
                cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                var reason = ReadTwitchError(body) ?? $"HTTP {(int)response.StatusCode}";
                lock (_sync) _status = $"Twitch could not renew the saved connection: {reason}. Connect with Twitch again.";
                throw new InvalidOperationException($"Twitch token renewal failed: {reason}");
            }

            using var json = JsonDocument.Parse(body);
            var newAccessToken = json.RootElement.GetProperty("access_token").GetString()
                ?? throw new InvalidOperationException("Twitch renewal did not return an access token.");
            var newRefreshToken = json.RootElement.TryGetProperty("refresh_token", out var refresh)
                ? refresh.GetString() : refreshToken;
            var newExpiresAt = DateTimeOffset.UtcNow.AddSeconds(json.RootElement.GetProperty("expires_in").GetInt32());
            lock (_sync)
            {
                if (!string.Equals(_refreshToken, refreshToken, StringComparison.Ordinal))
                    return _configuration ?? throw new InvalidOperationException("Twitch was disconnected while renewing its token.");
                _configuration = configuration with
                {
                    AccessToken = newAccessToken,
                    RefreshToken = newRefreshToken,
                    ExpiresAt = newExpiresAt
                };
                _refreshToken = newRefreshToken;
                _expiresAt = newExpiresAt;
                _status = $"Twitch connected as {_configuration.ChannelName ?? _configuration.BroadcasterId}; token renewed automatically.";
                SaveConnectionUnsafe();
                diagnostics.Record("Twitch", "success", "Automatically renewed the encrypted Twitch connection.");
                return _configuration;
            }
        }
        finally
        {
            _tokenRefreshGate.Release();
        }
    }

    private async Task<TwitchTokenDetails> ValidateTokenAsync(string accessToken, CancellationToken cancellationToken)
    {
        using var client = httpClientFactory.CreateClient();
        using var validation = new HttpRequestMessage(HttpMethod.Get, "https://id.twitch.tv/oauth2/validate");
        validation.Headers.Authorization = new AuthenticationHeaderValue("OAuth", NormalizeToken(accessToken));
        using var response = await client.SendAsync(validation, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException("Twitch rejected this user token. Connect with Twitch again.");

        using var json = JsonDocument.Parse(body);
        var root = json.RootElement;
        var scopes = root.TryGetProperty("scopes", out var scopeList) && scopeList.ValueKind == JsonValueKind.Array
            ? scopeList.EnumerateArray().Select(scope => scope.GetString()).Where(scope => scope is not null).Cast<string>().ToHashSet(StringComparer.Ordinal)
            : new HashSet<string>(StringComparer.Ordinal);
        return new TwitchTokenDetails(
            root.TryGetProperty("client_id", out var clientId) ? clientId.GetString() ?? "" : "",
            root.TryGetProperty("user_id", out var userId) ? userId.GetString() ?? "" : "",
            root.TryGetProperty("login", out var login) ? login.GetString() : null,
            scopes);
    }

    private static void EnsureTokenMatches(string clientId, string? broadcasterId, TwitchTokenDetails details)
    {
        if (!string.Equals(details.ClientId, clientId, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The Twitch token was created for a different Client ID.");
        if (string.IsNullOrWhiteSpace(details.UserId))
            throw new InvalidOperationException("Twitch did not identify the authorized broadcaster.");
        if (!string.IsNullOrWhiteSpace(broadcasterId)
            && !string.Equals(details.UserId, broadcasterId, StringComparison.Ordinal))
            throw new InvalidOperationException("The Twitch token user does not match the Broadcaster ID. Authorize while signed in as the broadcaster.");
    }

    private static void EnsureRequiredScopes(IReadOnlySet<string> scopes)
    {
        var missing = RequiredScopes.Where(scope => !scopes.Contains(scope)).ToList();
        if (missing.Count > 0)
            throw new InvalidOperationException($"The Twitch authorization is missing: {string.Join(", ", missing)}.");
    }

    private void SetConfigurationUnsafe(TwitchConfigurationRequest request)
    {
        _configuration = request;
        _refreshToken = request.RefreshToken;
        _expiresAt = request.ExpiresAt ?? default;
        SaveConnectionUnsafe();
    }

    private void SaveConnectionUnsafe()
    {
        if (_configuration is null) return;
        connectionStore.SaveTwitch(new StoredTwitchConnection(
            _configuration.ClientId,
            _configuration.AccessToken,
            _configuration.BroadcasterId,
            _configuration.ChannelName,
            _refreshToken,
            _expiresAt));
    }

    private void SetAuthorizationFailure(string message)
    {
        lock (_sync)
        {
            if (_configuration is null) _status = message;
            ClearPendingUnsafe();
        }
    }

    private void ClearPendingUnsafe()
    {
        _pendingDeviceCode = null;
        _pendingClientId = null;
        _pendingChannelName = null;
        _pendingExpiresAt = default;
        _pendingIntervalSeconds = 0;
    }

    private static string NormalizeToken(string token)
    {
        var trimmed = token.Trim();
        return trimmed.StartsWith("oauth:", StringComparison.OrdinalIgnoreCase) ? trimmed[6..] : trimmed;
    }

    private static string? NormalizeClientId(string? clientId)
    {
        var trimmed = clientId?.Trim();
        return string.IsNullOrWhiteSpace(trimmed) ? null : trimmed;
    }

    private static string? ReadTwitchError(string body)
    {
        try
        {
            using var json = JsonDocument.Parse(body);
            if (json.RootElement.TryGetProperty("message", out var message)) return message.GetString();
            if (json.RootElement.TryGetProperty("error", out var error)) return error.GetString();
        }
        catch { }
        return null;
    }

    private static TwitchConfigurationRequest FromStored(StoredTwitchConnection stored) => new(
        stored.ClientId,
        stored.AccessToken,
        stored.BroadcasterId,
        stored.ChannelName,
        stored.RefreshToken,
        stored.ExpiresAt == default ? null : stored.ExpiresAt);
}
