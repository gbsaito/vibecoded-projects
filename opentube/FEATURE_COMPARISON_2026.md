# opentube vs YouTube.com 2026 — Feature Gap Analysis

## Baseline

**opentube (current)**: TUI YouTube client (Bun + @opentui/solid, mpv player, CUI ≈ VSCode)
**YouTube.com (2026)**: Modern web player + navigation (watch page, feed, home, shorts, etc.)

---

## Completed Features (snapshots)

| Feature | opentube | YouTube | Notes |
|---------|----------|---------|-------|
| Search video list | ✅ | ✅ | `/` on home / searchbox |
| Pagination (`←/→`) | ✅ | ✅ | `page_count` setting |
| Sort by title/views/date | ✅ | ✅ | `o`, `O` |
| Thumbnail preview | ✅ | ✅ | `previews` + `image_previews` |
| Sidebar thumbnails | ✅ | ✅ | `thumbs instant` (commit 18db814) |
| Description display | ✅ | ✅ | Two-phase: fast invidious snapshot + full yt-dlp merge |
| Playing video (UI+audio) | ✅ | ✅ | mpv over JSON IPC |
| Audio-only mode | ✅ (P key) | ✅ (on-the-go) | PCM route through `--audio-file` |
| Progress bar | ✅ | ✅ | NowPlaying syncs `playback-time`/`duration` |
| Loop toggle | ✅ | ✅ | `r` key |
| Mute toggle | ✅ | ✅ | `m` key |
| Quality selection | ✅ | ✅ | 480p/720p/1080p/2160p/auto/best/lowest |
| Fullscreen mode | ✅ | ✅ | `--fullscreen` mpv arg |
| Keyboard navigation (h/j/k/l) | ✅ | ✅ | `HINTS` row lists them |
| Mouse selection (click/drag) | ✅ | ✅ | `mouse` setting; drag over rows moves highlight |
| Zoom level (0.5–2) | ✅ | ✅ | `ctrl+wheel` (excluded from codegraph visible) |
| Quick access menu | ✅ | ✅ | history, playlists (visual), subscriptions (visual), settings, quit |
| Home snippet | ✅ | ❌ | Not exists in web |
| Backend pool | ✅ (yt-dlp, invidious) | ✅ | Invidious instance pool cycled |
| Play history | ✅ | ✅ | Local JSON store, `history_limit` |
| WIP Labels | ✅ | ❌ | "Playlists (WIP)" / "Subscriptions (WIP)" |

---

## Missing Features (no code path)

### 1. Direct Watch Page / Comments

| Feature | opentube | YouTube | Notes |
|---------|----------|---------|-------|
| Comments UI | ❌ | ✅ | Live chat panel (desktop) / community tab (mobile) |
| Comment posting | ❌ | ✅ | No `c` key for comments in codegraph visible |
| Related videos rail | ❌ (search results only) | ✅ | `Related videos` off-rail; opentube only surfaces from same backend (yt-dlp ≈ scan channel, invidious ≈ top results) |

---

### 2. Engagement / Replayable Meta

| Feature | opentube | YouTube | Notes |
|---------|----------|---------|-------|
| Like button | ❌ | ✅ (shift+l) | UI only; track server-side dislikable (now stateless in most cases) |
| Dislike button | ❌ | ✅ (legacy) | YouTube (EE/EXT) track as like_dislike. opentube doesn’t separate them; user-facing UI not present |
| Share button | ❌ | ✅ | UI only; share URL via xdg-open (not yet wired) |

---

### 3. Watch Later / Saved / Playlists Control

| Feature | opentube | YouTube | Notes |
|---------|----------|---------|-------|
| Watch Later | ❌ | ✅ (bookmark) | Not separate from History; also toggleable in Settings (backend-supported, UI not added) |
| Save / Hype | ❌ | ✅ | Not wired in UI |
| Queue forward/back | ❌ | ✅ | No session queue; `l` add-to-playlist removed (commit 691a4fa1) |
| Playlist add/remove | ❌ | ✅ | "Playlists (WIP)" visual screen lacks add/remove UI; `l` key removed |

---

### 4. Live / Shorts / Trending / Recommendations

| Feature | opentube | YouTube | Notes |
|---------|----------|---------|-------|
| Live streams | ❌ | ✅ (with chat) | opentube downloads any video; doesn’t flag `is_live`/`is_upcoming` |
| Shorts feed | ❌ | ✅ (home + dropdown) | No Shorts screen / tab / chips |
| Trending tab | ❌ | ✅ | No trending search stub |
| Home feed recommendations | ❌ | ✅ (wave focus, channels view) | opentube: flat search-only; no companion wave |
| Watch history dashboard | ❌ | ✅ | opentube only sql.json list |
| Custom feeds | ❌ | ✅ (up to 8 for Premium) | Not exposed to opentube users (auth not wired) |

---

### 5. Playback / Engagement Micro-features

| Feature | opentube | YouTube | Notes |
|---|---------|---------|-------|
| Seek by double-tap | ❌ | ✅ (arrows) | No double-tap overlay in codegraph visible |
| Skip intro/outro | ❌ | ✅ (via plugins) | yt-dlp lacks intro/outro skip in codebase visible |
| Captions/subtitles | ❌ | ✅ | No subtitle toggle; mpv’s `--sub-file` invisible; need thread to `sub-list` |
| Auto Speed / Playback rate | ❌ | ✅ (auto speed) | No UI for playback speed adjustment |
| On-the-go mode | ❌ | ✅ (Premium, gesture) | UI overlay for audio-only (skip forward/back) — not on mpv directly |
| Chromecast casting | ❌ | ✅ | No wrapper around mpv player (not in TUI scope) |
| Audio focus (focus loss) | ❌ | ✅ | No Linux desktop integration with pulseaudio/pipewire when focused out |

---

### 6. Account / Notifications / Sync

| Feature | opentube | YouTube | Notes |
|---------|----------|---------|-------|
| Account login / auth | ❌ (planned) | ✅ | Required for custom feeds, cloud watch history; phase 4 goal |
| Notifications | ❌ | ✅ | No notification badge UI |
| Cloud watch history | ❌ | ✅ | Only local JSON history store |
| Cloud playlists | ❌ | ✅ | Local playlists store, not synced |
| Device switching | ❌ | ✅ | Only CLI-only; no active devices list |
| Save data / Settings API | ❌ | ✅ | Not exposed; only local conf files |

---

### 7. Invisible / Backend Features (internal, not UI)

| Feature | opentube | YouTube | Notes |
|---------|----------|---------|-------|
| User language detection | ❌ | ✅ | No UI for default language, relies on backend behavior |
| LanguagePreference (automatic naming) | ❌ | ✅ | Not exposed; ultimately invidious audio pick (`plang` flag) |
| No-AI write filter | ❌ | ✅ | Not in codebase |
| Account lock (smart TV) | ❌ | ✅ | No TV-specific safety setting in CLI |
| Family safety | ❌ | ✅ | Not exposed |
| Restricted mode | ❌ | ✅ | Not exposed |

---

### 8. UI / UX / Cognitive Fit

| Feature | opentube | YouTube | Notes |
|---------|----------|---------|-------|
| Wave home tab | ❌ | ✅ | opentube: flat search list |
| Channel pages | ❌ (only list view) | ✅ | Shows channel banner, description, uploads |
| Subscriptions tab relocation | ❌ | ✅ (home top row) | opentube: local store screen only |
| Playground (playground) | ❌ | ✅ | No dev/testing harness in CLI |
| Shortcuts menu (Settings) | ❌ | ✅ | No keyboard diagnostics / info screen |
| Visual focus state | ✅ | ✅ | Good (but no README-level mapping of key combos) |
| Status indicators in now-playing | ✅ | ✅ | Loop/Paused/Muted indicators (commit a695440) |

---

## Priority Assessment

| Priority | Missing item | Why it matters |
|----------|--------------|----------------|
| **P0** | Comments UI (flat description + comment) | People expect a flat comment feed; currently hidden internally |
| **P0** | Auto Speed / Playback Rate | High-demand for video/podcast consumption; often needed for ponctual features |
| **P0** | Pause-on-focus-loss (audio mode) | Desktop usability for background audio; in mpv only exists via OS integration (not UI) |
| **P1** | Subs navigation (tube.sh/tube-home) | Similar to search results; opinionated page for channels; ease of retaining interest |
| **P1** | Shortcuts menu (GitHub issue boxes) | Helpful debug+feature info center; no such plan yet |
| **P1** | Context Search within Playlist | opentube manual feature request; currently unfocused |
| **P2** | Watch History dashboard (chart) | Not an interaction gap; more of a data view |
| **P2** | Shorts | Removal of tab not feasible soon; use case is possible soon |
| **P2** | Recommendations (wave-based) | opentube makes explicit choices via search; alternative search queue is plausible |
| **P3** | Playlists UI (add/remove) | "Playlists (WIP)" visual screen tickets; user wields them manually after commits |
| 【】同步与配置要将变化写入本地等价的需求；若用户期望将自己账号的云端内容转存为本地罐头，可在远端添加转储按钮（自定义首选项）并控制行为，避免同步能力非必要扩张。本地罐头通常更深嵌于视频元数据中（比如历史、订阅和播放列表），可考虑基于“差异同步”实现云端dump（一次性导出或增量），既不远程同步个人信息，也无需登录验证。

---

## Example Gap Lines (SUMMARY)

### 关注图表与数据驱动变更的适配建议

除了上一节的代码层面对比，还建议关注本地配置与同步机制的差异：

- 用户从浏览器迁移时，云端历史、订阅与收藏已存储；本地 opentube 需通过“数据迁移”导入这些内容（导入按钮或从 ~/.config/opentube 启动时检测）。
- 若期望实现云端数据的镜像导出（非同步），请在云端增加转储与还原按钮；本地配置标签应包含数据镜像的导出/导入开关——这些是配置akin的项，而非实时同步需求。
- 认证流程仅应服务于配置与特权操作；导出/镜像不依赖登录即可访问，避免让用户为了导出而生产凭证。
- 导出/导入不上传到任何远端，因此不存在隐私问题；也无需对远端或拷贝机做考量的同步时段与分片策略。

---

## Opinionated Next Implementation Path

1. Validate current obs: user expects missing “Review Highlight” diag in now-playing.
2. Add options to share outgoing URLs (xdg-open from `l` legend).
3. Add captions/subtitles UI (toggle + list from mpv).
4. Replace `l` with proper playlist UI (add/remove) on playback.
5. Curtain-watch / “custom feeds” upload: export/import JSON blobs; not real sync.

总体而言，opentube 功能完备性不错（CUI 侧基础覆盖），要追近 YouTube 感觉的另一大块是“交互性”：评论、弹幕（非必要但不偏离主要需求）、播放速率与音频焦点适配。后续迭代可参照如 P0–P2 优先级滚动。