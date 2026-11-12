# John's Twitch Handler - Project notes

These notes describe the product direction and technical background for John's Twitch Handler.
If you are trying the app for the first time, start with the [tester guide](docs/tester-kit/README.md).

## Quick introduction

John's Twitch Handler is a lightweight Windows streaming companion created primarily for John to
use on his own Twitch channel. John is the primary user and tester. The product should remain useful
to him personally while also being simple enough for nontechnical testers to download and open.

Current approved version: **.016**

Source repository: <https://github.com/yepitsjohn/johns-twitch-handler>

The Handler combines stream preparation, live controls, chat tools, viewer integrations, performance
monitoring, and post-stream review in one local dashboard. Its central design rule is that a tool
intended to protect stream performance must not become a meaningful resource drain itself.

## Primary product direction

**Simplicity and ease of use take priority above everything else.** Do not remove working
functionality; simplify how it is presented.

The product has two user modes backed by the same systems and settings:

- **Simple** is the default. It presents one obvious status, one obvious next action, plain-English
  explanations, automatic setup, sensible defaults, and minimal technical detail. It also keeps
  personal reminders, interpreted Stream Health, and two stage-appropriate shortcuts within reach.
  A small Customize Simple control lets each user choose those sections and optionally pin Chat,
  Song Requests, or the Ad Timer. Raw metrics and configuration stay behind Details.
- **Advanced** exposes raw performance metrics, OBS and WebSocket details, integration diagnostics,
  detailed configuration, full customization, and troubleshooting information.

Keep the Pre-stream, During stream, and After stream workflow, but center each stage on one question:

1. **Before: Am I ready to stream?** Summarize OBS, Twitch, microphone, and internet readiness.
2. **During: Is everything okay?** Lead with a clear healthy state or explain the detected problem,
   likely cause, and a safe next action.
3. **After: How did my stream go?** Summarize incidents, recovery, and the most useful recommendation.

The Handler should increasingly say **“Everything looks good.”** instead of asking the user to
interpret ten metrics. When something is wrong, prefer **“I found a problem. Fix it?”** over requiring
the user to understand OBS, GPU, encoder, networking, WebSocket, or OAuth terminology.

Development priority:

1. Simple and Advanced modes.
2. Simplify existing screens.
3. Automatic OBS and integration detection.
4. Stream Health.
5. Safe one-click Fix It actions.
6. Before, During, and After demo.
7. Simple first-run onboarding.
8. Better post-stream recommendations.
9. Installer and updater later.
10. Code signing before broad public distribution.

### Visual direction

The interface should feel like **OBS plus a lightweight Windows broadcast utility**, not a generic
SaaS analytics dashboard. Prefer flat panels, small radiuses, tight functional spacing, clear
dividers, restrained color, and one consistent utility-style icon language. Avoid unnecessary
gradients, shadows, glows, badges, decorative labels, and separate containers.

During a stream, emphasize Stream Health first, then the current OBS scene, microphone and important
audio, critical actions, chat/activity, optional integrations, and finally technical history. The
During page has one recognizable top status strip: **STREAM HEALTHY**, **PERFORMANCE PRESSURE**, or
**STREAM AT RISK**, with the session timer and a Fix It action only when needed. Simple mode remains
one cohesive control surface; raw metrics, graphs, process data, and diagnostics remain in Advanced.

## How the application works

- Backend: C# and ASP.NET Core on .NET 9.
- Frontend: plain HTML, CSS, and JavaScript. There is no React, Angular, Vue, or Node.js runtime.
- Local server: the application starts Kestrel at `http://127.0.0.1:5274`.
- Network exposure: the dashboard is bound to the local computer, not the LAN or public internet.
- Database: none. Durable application data uses small local JSON or JSONL files.
- Browser preferences: themes, collapsed cards, and similar display preferences use local storage.
- Credentials: connection tokens and passwords are encrypted locally with ASP.NET Data Protection
  and Windows DPAPI. They are tied to the user's Windows account and computer.
- Distribution: the tester package is one self-installing Windows x64 `Setup.exe`. Testers do not
  extract a ZIP or install .NET, Node.js, a database, or developer tools.

The browser is the control surface. The local C# process owns integrations, credentials, monitoring,
file storage, and API calls. Browser JavaScript should not receive or store secrets.

## Stream workflow pages

The dashboard has three pages in a persistent left navigation:

1. **Pre-stream** for connections, Preflight, optional integrations, and optimization.
2. **During stream** for OBS controls, chat, alerts, clips, music, ads, and live performance.
3. **After stream** for reports, timelines, clips, raids, performance review, and publishing work.

Users can open **Customize pages** and decide which cards appear on each page. A card may appear on
multiple pages, but it must remain assigned to at least one. Page assignments and card order persist
locally across restarts. Starting a tracked session opens During stream automatically; ending one
opens After stream.

## Major features already present

### Preparation and OBS

- Preflight checklist with red, yellow, green, and blue readiness meanings.
- Manual checklist reminders such as `Get Coffee`.
- Optional checklist rows can be hidden without disabling their integrations.
- OBS WebSocket 5 connection, scene switching, replay-buffer actions, and audio controls.
- Microphone mute-state check and unmute action in Preflight.
- NVIDIA Broadcast detection and launch reminder.
- Reversible, performance-first OBS recommendation centered on 720p at 30 FPS using NVENC.
- Five dashboard color themes.
- Movable, resizable, collapsible, floatable, and redockable panels with saved layouts, keyboard movement, and OBS-style tab stacks.
- New installations start with a consistent docked layout, paired panel sizes, and 12-pixel spacing. Reset layout asks before restoring panel positions, sizes, page assignments, and stacks without changing connections, themes, or Simple-mode choices. Existing layouts are not migrated automatically.
- Per-panel **Add to Simple** controls so users can expose selected Advanced tools without enabling the full Advanced interface.
- A saved **Appearance** panel with two-column choices for the flat **Broadcast Console**, rounded **Vibe Dashboard**, squared amber **Tactical Console**, and five color themes; it must never fork application behavior or integration state. Fresh installations default to Broadcast, Ocean, and the RPG game profile.

### Live stream operation

- Embedded Twitch chat and optional embedded YouTube live chat.
- A messages-only local OBS chat Browser Source with no Twitch leaderboards or promotional panels.
- Optional read-only TikTok chat through the locally running TikFinity desktop application.
- Private quiet chat notification intended for the streamer, not the broadcast.
- Activity feed highlighting follows, subscriptions, bits, raids, and other important events.
- Stream markers, OBS Replay Buffer saves, Twitch clip creation, and StreamLadder handoff.
- Persistent FPS and RPG game profiles, with kill/death session markers and counters in the FPS profile.
- Optional Wardogs post-stream results for community servers using a locally saved SteamID64/server identifier and the no-key WARDOGS Tracker API. A baseline/final snapshot delta is stored with the stream report; official-server and exact event-timestamp support are not implied.
- Ad-break timer with optional Twitch chat announcements at the start and end, off by default.
- Tangia OBS Browser Source controls, volume control, mute, reload, and Boss Focus support.
- Chat command manager for commands such as `!discord`, `!spec`, and `!build`.
- Safe action and schedule manager. It does not execute arbitrary scripts or programs.

### Spotify song requests

- Spotify OAuth using PKCE.
- Track search, current playback, active device status, queue display, and skip control.
- Twitch Channel Point song requests with viewer success or failure feedback.
- Built-in `!song` and `!playing` commands that can provide the current track link.
- Viewer-facing OBS Browser Source showing the current song and upcoming queue.
- A remembered Show/Hide overlay button hides only the song/queue graphics across OBS scenes. Playback, requests, preflight, and Boss Focus notices remain available; the hidden overlay stops polling Spotify.
- Song-request notifications should not add an extra audible alert to the broadcast.
- Spotify is optional for testers and defaults to No in the simple tester package.

Spotify audio routing remains outside the Handler. John currently separates music from the Twitch VOD
track in OBS. Technical routing does not itself grant music broadcast rights, so Spotify policy and
music licensing remain external considerations.

### Performance and reporting

- CPU, RAM, GPU, VRAM, GPU temperature, and recent system history.
- Top five resource-consuming process groups with plain-language suggestions, archived at a low
  frequency during tracked streams so historical reports can identify sustained drains.
- Internet latency and failure monitoring with timestamped connection incidents.
- OBS render, encoder, and dropped-frame health when connected.
- Stream timeline for scene changes, markers, ads, Twitch events, and performance incidents.
- Automatic OBS-driven session finalization plus Previous Streams history; reports remain local and
  retain chat, activity, performance, timeline, and highlight data per broadcast.
- Post-stream checklist, performance diagnosis, highlights, report export, and publishing queue.
- Incoming and outgoing raid history with one-week, two-week, and one-month views.
- Lightweight local viewer notes.

## Optional integrations

Spotify, Tangia, StreamElements, and TikFinity must remain genuinely optional. Choosing No should
prevent unnecessary background connection work and mark the related Preflight item as intentionally
skipped. Optional integrations should not block the user from starting a normal stream.

- **Twitch:** OAuth, Helix API, and EventSub WebSocket.
- **OBS:** OBS WebSocket 5.x on the local computer.
- **Spotify:** Spotify Web API with renewable OAuth tokens.
- **Tangia:** controlled through its OBS Browser Source; Tangia owns its own login.
- **StreamElements:** SE.Live detection and multistream planning; StreamElements owns stream keys.
- **TikFinity:** optional read-only local WebSocket bridge for TikTok chat.
- **YouTube:** official embedded live chat using the livestream URL, without Google OAuth.
- **StreamLadder:** browser handoff for editing and publishing clips.

Automated YouTube chat posting is deliberately not included because it would require a separate
Google OAuth application and sensitive YouTube permissions. Twitch remains the platform used for
scheduled bot messages.

## Owner and tester releases

Owner and tester builds share the same approved functionality. Differences are configuration and
identity, not separate feature forks.

- The owner build is John's local working installation.
- Tester builds use a visible **Tester** label and a versioned Setup executable filename.
- Each installation has its own connections, settings, reports, and encrypted credentials.
- Tester data is not sent to John and cannot be viewed by John.
- Public OAuth Client IDs may be distributed; client secrets, tokens, passwords, and signing keys may
  never be included in source control or tester packages.
- Changes should be tested locally, approved, committed, tagged, and then packaged.

Versions use the visible `.001`, `.002`, and similar format in the application. Git tags use
`v0.0.1`, `v0.0.2`, and similar semantic equivalents.

## Performance rules

When proposing or reviewing a change, preserve these rules:

1. Prefer event-driven integrations over frequent polling.
2. Use recursive delayed refreshes so slow requests cannot stack.
3. Pause card-specific browser polling when its card is collapsed or on an inactive page.
4. Keep optional services dormant when disabled.
5. Avoid a frontend framework or large dependency unless it provides a measured benefit.
6. Never perform expensive process, file-system, or network scans every second.
7. Do not make OBS perform extra rendering solely to preview its own program output in the Handler.
8. Keep log files bounded and exclude credentials from logs.
9. Treat CPU and RAM usage on the stream PC as product requirements, not afterthoughts.

## Privacy and safety requirements

- Never put Twitch, Spotify, Discord, OBS, or other private credentials in GitHub, documentation, or
  a tester installer.
- Never collect tester telemetry by default.
- Never imply that John can see another user's settings, reports, viewer notes, or account data.
- Keep the web server bound to loopback unless a separate security review explicitly approves a
  network-facing design.
- Keep arbitrary script execution out of user-configurable automations.
- Preserve recoverable OBS changes: save current settings before applying a recommendation and offer
  restoration.
- Do not silently enable an optional integration.
- Bot messages should use the product name **John's Twitch Handler**.
- Avoid double-hyphen punctuation in viewer-facing messages.

## Features intentionally paused or deferred

- World of Warcraft addon profiling and Encounter Highlights remain implemented but disabled behind
  `Features:WowTools = false`. Preserve the code for possible later use.
- A low-cost OBS scene preview was discussed but deliberately deferred.
- TikTok chat through TikFinity is optional and defaults to No.
- Automated posting to YouTube chat is deferred.
- Automatic updater and Windows code signing are not implemented yet.

## RPC direction

RPC means local program-to-program commands and events; it does not automatically remove OAuth,
developer applications, or account permission requirements.

### Discord

Discord is the strongest near-term local RPC candidate. An optional Discord integration could use
the official Discord desktop/Social SDK for Rich Presence, showing the game, stream state, elapsed
time, and buttons linking to Twitch or the community. If supported by the SDK and application
eligibility, read-only local voice state could help Preflight identify mute, deafen, voice mode, or
push-to-talk problems.

Discord Rich Presence is not the same as a Discord bot. A bot that posts in servers would require a
bot token, server installation, permissions, and a separate security design. Never place a bot token
inside a tester package.

### Spotify

The Spotify Web API should remain the primary Windows provider. It supports search, queue, playback
state, skip, and device selection. A future `IMusicProvider` abstraction could keep the current Web
API provider while allowing another implementation.

Spotify Soloist offers an official local WebSocket for a headless Linux Spotify Connect device. It
may be useful later for a dedicated Linux or Raspberry Pi music appliance, but it is not a direct
replacement for the current Windows integration. Do not ship an unofficial Windows Spotify RPC
dependency without a licensing, security, and maintenance review.

## GitHub workflow

The local project is connected to:

<https://github.com/yepitsjohn/johns-twitch-handler>

The primary branch is `main`. GitHub Actions builds the .NET solution and checks dashboard JavaScript
syntax. Feature work should use focused commits or branches, preserve unrelated local changes, and
avoid committing generated output.

Ignored content includes build directories, logs, local data, environment files, signing keys, and
generated installers. Approved tester Setup executables may be attached to GitHub Releases, while
generated output remains outside source control.

## Important source files

- `src/StreamSidekick/Program.cs` - ASP.NET Core setup and local API routes.
- `src/StreamSidekick/Models.cs` - request and persisted data models.
- `src/StreamSidekick/Services/` - OBS, Twitch, Spotify, monitoring, storage, and automation services.
- `src/StreamSidekick/wwwroot/index.html` - dashboard markup.
- `src/StreamSidekick/wwwroot/styles.css` - themes and layout.
- `src/StreamSidekick/wwwroot/app.js` - dashboard behavior and refresh scheduling.
- `src/StreamSidekick/appsettings.json` - safe defaults and feature switches.
- `docs/ARCHITECTURE.md` - developer-oriented architecture notes.
- `RELEASE_WORKFLOW.md` - owner/tester release rules.
- `RELEASE_VERSION.txt` - current tester-package number.
- `src/StreamSidekick.Installer/` - builds the single-file, per-user tester installer.
- `build-tester-package.ps1` - creates the self-contained tester Setup executable.

## Normal validation

Before calling a code change complete, run:

```powershell
dotnet build StreamSidekick.sln --configuration Release --no-restore
node --check src/StreamSidekick/wwwroot/app.js
git diff --check
```

Changes involving persistence or integrations should also exercise the relevant local API and confirm
that the previous configuration still loads. UI changes should be checked at normal desktop width and
at the narrow responsive breakpoint.

## Current product questions

These are open design decisions rather than instructions to implement immediately:

- Whether Discord should stop at Rich Presence or eventually include a separately secured server bot.
- Whether a dedicated Linux Spotify device is worthwhile.
- Whether tester updates should become automatic.
- When to purchase a Windows code-signing certificate.
- Whether source will remain private, become source-available, or eventually become open source.
- Where public tester downloads will be hosted without exposing private source code.

## Working on the project

When helping with this project:

1. Treat John as the product owner and primary user.
2. Separate suggestions from implemented behavior.
3. State clearly when a proposal needs a developer app, OAuth permission, cloud service, database, or
   recurring cost.
4. Prefer changes that work locally and reduce tester setup.
5. Preserve all existing owner functionality when making the tester experience simpler.
6. Keep Spotify, Tangia, StreamElements, TikFinity, YouTube, and future Discord features optional.
7. Verify behavior against the current source and a local test. Do not assume access to John's
   computer, OBS, files, GitHub, or accounts.
8. Ask for the specific current source file when exact implementation advice depends on code that was
   not uploaded.
9. Flag privacy, security, platform-policy, and performance consequences before recommending a design.
10. Use the current version and repository state stated by John if it is newer than this document.
