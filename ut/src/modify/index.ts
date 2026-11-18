import {
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  SelectRenderable,
  ImageRenderable,
} from "@opentui/core"
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { utCacheDir, utConfig, utConfigDir } from "../utdirs.ts"
import { ImageCache } from "./image-cache.ts"
import type { SlotCtx, TrackerSlot, KeyLike } from "../slot.ts"

/**
 * Build the Modify tracker onto the host's renderer and root container.
 * Everything below runs per hosted tracker; the standalone entry point used to
 * own the renderer and terminal, ut's host (src/main.ts) owns them now.
 */
export async function startModify(ctx: SlotCtx): Promise<TrackerSlot> {

type ProjectType = "mod" | "resourcepack"
type Source = "modrinth" | "curseforge"

type Hit = {
  project_id: string
  source: Source
  project_type: string
  slug: string
  title: string
  description: string
  author: string
  categories: string[]
  versions: string[]
  downloads: number
  follows: number
  icon_url?: string | null
  addedAt?: number
}

type SearchResponse = {
  hits: Hit[]
  offset: number
  limit: number
  total_hits: number
}

type Favorite = {
  project_id: string
  source?: Source
  project_type: string
  slug: string
  title: string
  author?: string
  description?: string
  downloads?: number
  follows?: number
  icon_url?: string | null
  categories?: string[]
  addedAt?: number
}

type FavoritesStore = { favorites: Favorite[] }

/** Version tag written into exported files, so a future format change stays readable. */
const EXPORT_VERSION = 1

const SORTS = ["relevance", "downloads", "follows", "newest", "updated", "name", "dateAdded"]
const MODRINTH = "https://api.modrinth.com/v2"
const CF_API = "https://api.curseforge.com"
const CF_CLASS_ID: Record<ProjectType, number> = { mod: 6, resourcepack: 12 }
/** Modrinth sort keys -> CurseForge ModsSearchSortField numbers. */
const CF_SORT: Record<string, number> = {
  relevance: 13, // Relevancy
  downloads: 6, // TotalDownloads
  follows: 2, // Popularity (nearest CF equivalent; no follow sort)
  newest: 11, // Release Date
  updated: 3, // LastUpdated
}
let searchSeq = 0

/** Sort keys the backend APIs accept; name/dateAdded are favorites-only, fall back to relevance for server sorts. */
function apiSortFor(sort: string): string {
  return ["relevance", "downloads", "follows", "newest", "updated"].includes(sort) ? sort : "relevance"
}

/** Read the optional CurseForge API key: env var wins, else ~/.config/modify/config.json. */
function loadConfig(): { cfApiKey: string | null } {
  const env = process.env.CURSEFORGE_API_KEY
  if (env) return { cfApiKey: env.trim() || null }
  try {
    const parsed = JSON.parse(readFileSync(utConfig("modify", "config.json"), "utf8")) as { curseforgeApiKey?: unknown }
    if (typeof parsed.curseforgeApiKey === "string" && parsed.curseforgeApiKey.trim()) {
      return { cfApiKey: parsed.curseforgeApiKey.trim() }
    }
  } catch { /* missing config file -> no key */ }
  return { cfApiKey: null }
}

const CF_KEY = loadConfig().cfApiKey

type CfLogo = { url?: string; thumbnailUrl?: string }
type CfAuthor = { name?: string }
type CfMod = {
  id: number
  name?: string
  slug?: string
  summary?: string
  downloadCount?: number
  authors?: CfAuthor[]
  loaders?: string[]
  logo?: CfLogo
}
type CfSearchResponse = { data?: CfMod[]; totalCount?: number }

/** XDG cache dir: icon bytes cached on disk so covers show instantly. */
const imageCache = new ImageCache(utCacheDir("modify"))

/** URL of the image currently assigned to the cover, tracked by identity. */
let currentImageUrl: string | null = null

/** Abbreviate big numbers: 291497256 -> 291.5M, 100000 -> 100K. */
function trimNum(v: number): string {
  const s = v.toFixed(v >= 100 ? 1 : 2)
  return s.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1")
}

function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1e9) return `${trimNum(n / 1e9)}B`
  if (n >= 1e6) return `${trimNum(n / 1e6)}M`
  if (n >= 1e3) return `${trimNum(n / 1e3)}K`
  return String(n)
}

function favPath() {
  const dir = utConfigDir("modify")
  try { mkdirSync(dir, { recursive: true }) } catch {}
  return join(dir, "favorites.json")
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined
}

function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** Turn one unknown record into a Favorite; null when it is not a usable entry. */
function sanitizeFavorite(raw: unknown): Favorite | null {
  if (!raw || typeof raw !== "object") return null
  const f = raw as Record<string, unknown>
  if (typeof f.project_id !== "string" || typeof f.title !== "string") return null
  // Legacy entries used bare ids; name them on load for stable matching.
  const id = f.project_id.includes(":") ? f.project_id : `modrinth:${f.project_id}`
  const source: Source =
    f.source === "curseforge" || f.source === "modrinth"
      ? f.source
      : id.startsWith("cf:")
        ? "curseforge"
        : "modrinth"
  const project_type: ProjectType =
    f.project_type === "resourcepack" || f.project_type === "mod" ? f.project_type : "mod"
  return {
    project_id: id,
    source,
    project_type,
    slug: typeof f.slug === "string" ? f.slug : "",
    title: f.title,
    author: optStr(f.author),
    description: optStr(f.description),
    downloads: optNum(f.downloads),
    follows: optNum(f.follows),
    icon_url: typeof f.icon_url === "string" || f.icon_url === null ? f.icon_url : undefined,
    categories: strArray(f.categories),
    addedAt: typeof f.addedAt === "number" && Number.isFinite(f.addedAt) ? f.addedAt : undefined,
  }
}

/** Accept a bare array or a `{ favorites: [...] }` object; null when neither shape fits. */
function parseFavorites(raw: unknown): Favorite[] | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { favorites?: unknown }).favorites)
      ? ((raw as { favorites: unknown[] }).favorites)
      : null
  if (!list) return null
  return list.map(sanitizeFavorite).filter((f): f is Favorite => f !== null)
}

function loadFavorites(): FavoritesStore {
  let raw: string
  try {
    raw = readFileSync(favPath(), "utf8")
  } catch {
    return { favorites: [] } // missing file -> fresh store
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt (not merely missing) file: snapshot it so past favorites stay
    // recoverable instead of being wiped by the next save.
    try { copyFileSync(favPath(), `${favPath()}.corrupt`) } catch {}
    return { favorites: [] }
  }
  return { favorites: parseFavorites(parsed) ?? [] }
}

function saveFavorites(store: FavoritesStore) {
  try {
    // Atomic write: temp file + rename, so a crash mid-write never truncates
    // an existing favorites.json.
    const path = favPath()
    writeFileSync(`${path}.tmp`, JSON.stringify(store, null, 2))
    renameSync(`${path}.tmp`, path)
  } catch (e) {
    // non-fatal: favorites view just won't persist
  }
}

const state = {
  source: "modrinth" as Source,
  projectType: "mod" as ProjectType,
  sortIndex: 0,
  sortDir: "desc" as "asc" | "desc",
  query: "",
  results: [] as Hit[],
  offset: 0,
  limit: 20,
  total: 0,
  loading: false,
  status: "Press / to focus search, Enter to search",
  favorites: loadFavorites(),
  favoritesView: false,
  savedResults: [] as Hit[],
  helpVisible: false,
}

function isFav(id: string) {
  return state.favorites.favorites.some((f) => f.project_id === id)
}

type QueryOutcome = { hits: Hit[]; total: number }

type SourceAdapter = {
  id: Source
  label: string
  search: (opts: {
    query: string
    sort: string
    offset: number
    limit: number
    projectType: ProjectType
    signal: AbortSignal
    apiKey?: string | null
    dir: "asc" | "desc"
  }) => Promise<QueryOutcome>
}

const sourceAdapters: Record<Source, SourceAdapter> = {
  modrinth: {
    id: "modrinth",
    label: "Modrinth",
    search: async ({ query, sort, offset, limit, projectType, signal }) => {
      const facets = JSON.stringify([["project_type:" + projectType]])
      const url =
        `${MODRINTH}/search?query=${encodeURIComponent(query)}` +
        `&index=${sort}` +
        `&limit=${limit}&offset=${offset}` +
        `&facets=${encodeURIComponent(facets)}`
      const res = await fetch(url, { headers: { "User-Agent": "Modify/1.0 (local)" }, signal })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const data = (await res.json()) as SearchResponse
      if (!Array.isArray(data.hits)) throw new Error("Malformed response: missing hits")
      const hits = data.hits.map((h) => ({
        ...h,
        project_id: `modrinth:${h.project_id}`,
        source: "modrinth" as const,
      }))
      return { hits, total: data.total_hits ?? 0 }
    },
  },
  curseforge: {
    id: "curseforge",
    label: "CurseForge",
    search: async ({ query, sort, offset, limit, projectType, signal, apiKey, dir }) => {
      const url =
        `${CF_API}/v1/mods/search?gameId=432` +
        `&classId=${CF_CLASS_ID[projectType]}` +
        `&searchFilter=${encodeURIComponent(query)}` +
        `&sortField=${CF_SORT[sort] ?? 13}` +
        `&sortOrder=${dir}&index=${offset}&pageSize=${limit}`
      const res = await fetch(url, {
        headers: {
          "x-api-key": apiKey ?? "",
          Accept: "application/json",
          // CurseForge's edge WAF rejects unknown user agents on /v1/mods/search
          // with 403 "API Key missing or invalid" — use a browser-like UA.
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        },
        signal,
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
      }
      const data = (await res.json()) as CfSearchResponse
      if (!Array.isArray(data.data)) throw new Error("Malformed response: missing data")
      const hits = data.data.map((m) => cfToHit(m, projectType))
      return { hits, total: data.totalCount ?? hits.length }
    },
  },
}

function cfToHit(m: CfMod, projectType: ProjectType): Hit {
  return {
    project_id: `cf:${m.id}`,
    source: "curseforge",
    project_type: projectType,
    slug: m.slug ?? "",
    title: m.name ?? "",
    description: m.summary ?? "",
    author: m.authors?.[0]?.name ?? "",
    categories: (m.loaders ?? []).map((l) => l.toLowerCase()),
    versions: [],
    downloads: m.downloadCount ?? 0,
    follows: 0,
    icon_url: m.logo?.url ?? m.logo?.thumbnailUrl ?? null,
  }
}

async function search(resetOffset = true) {
  const seq = ++searchSeq
  if (resetOffset) state.offset = 0
  state.loading = true
  state.status = "Loading..."
  refreshHeader()

  if (state.source === "curseforge" && !CF_KEY) {
    state.results = []
    state.total = 0
    state.loading = false
    state.status = "CurseForge: no API key (set CURSEFORGE_API_KEY or ~/.config/modify/config.json)"
    refreshHeader()
    renderResults(true)
    updateDetail()
    return
  }

  const adapter = sourceAdapters[state.source]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const out = await adapter.search({
      query: state.query,
      sort: apiSortFor(SORTS[state.sortIndex] ?? "relevance"),
      offset: state.offset,
      limit: state.limit,
      projectType: state.projectType,
      signal: controller.signal,
      apiKey: CF_KEY,
      dir: state.sortDir,
    })
    if (seq !== searchSeq) return // stale response, discard
    state.total = out.total
    state.results = out.hits
    state.status = `${out.hits.length} / ${out.total} results`
    prefetchIcons(out.hits)
  } catch (e) {
    if (seq !== searchSeq) return // stale response, discard
    state.status = `Error: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    clearTimeout(timer)
    if (seq === searchSeq) {
      state.loading = false
      refreshHeader()
      renderResults(true)
      updateDetail()
    }
  }
  if (seq !== searchSeq) return
  renderResults(true)
  updateDetail()
}

function favToHit(f: Favorite): Hit {
  const source: Source = f.source === "curseforge" || f.project_id.startsWith("cf:") ? "curseforge" : "modrinth"
  return {
    project_id: f.project_id,
    source,
    project_type: f.project_type,
    slug: f.slug,
    title: f.title,
    description: f.description ?? "",
    author: f.author ?? "",
    categories: f.categories ?? [],
    versions: [],
    downloads: f.downloads ?? 0,
    follows: f.follows ?? 0,
    icon_url: f.icon_url ?? null,
    addedAt: f.addedAt,
  }
}

function currentResults(): Hit[] {
  const hits = state.favoritesView ? state.favorites.favorites.map(favToHit) : state.results
  const sort = SORTS[state.sortIndex] ?? "relevance"
  if (!state.favoritesView) return hits // search results arrive sorted by the API
  if (sort === "relevance") return hits // favorites keep stored order
  return sortHits(hits, sort, state.sortDir)
}

/** Sort hits for display; favorites have no API sort, so sort client-side. */
function sortHits(hits: Hit[], sort: string, dir: "asc" | "desc"): Hit[] {
  const arr = [...hits]
  const sign = dir === "asc" ? 1 : -1
  switch (sort) {
    case "downloads":
      return arr.sort((a, b) => sign * ((a.downloads ?? 0) - (b.downloads ?? 0)))
    case "follows":
      return arr.sort((a, b) => sign * ((a.follows ?? 0) - (b.follows ?? 0)))
    case "newest":
    case "updated":
    case "dateAdded":
      // favorites carry no mod-update timestamp; addedAt is the best proxy
      return arr.sort((a, b) => sign * ((a.addedAt ?? 0) - (b.addedAt ?? 0)))
    case "name":
      return arr.sort((a, b) => sign * (a.title.localeCompare(b.title)))
    default:
      return arr // relevance (or unknown) -> stored order
  }
}

function renderResults(reset = false) {
  const prev = currentResults()
  const prevIdx = resultsSelect.getSelectedIndex()
  const prevId =
    prev.length > 0 && prevIdx >= 0 ? (prev[prevIdx]?.project_id ?? null) : null
  const opts = currentResults().map((h) => ({
    name: (isFav(h.project_id) ? "★ " : "  ") + h.title,
    description: "",
    value: h.project_id,
  }))
  resultsSelect.options = opts
  let nextIdx = 0
  if (!reset && prevId) {
    const idx = opts.findIndex((o) => o.value === prevId)
    if (idx >= 0) nextIdx = idx
  }
  resultsSelect.setSelectedIndex(nextIdx)
}

function selectedHit(): Hit | null {
  const res = currentResults()
  const idx = resultsSelect.getSelectedIndex()
  if (idx < 0 || idx >= res.length) return null
  return res[idx] ?? null
}

function toggleFavorite() {
  const h = selectedHit()
  if (!h) return
  const pt = h.project_type as ProjectType
  const store = state.favorites
  const i = store.favorites.findIndex((f) => f.project_id === h.project_id)
  if (i >= 0) store.favorites.splice(i, 1)
  else
    store.favorites.push({
      project_id: h.project_id,
      source: h.source,
      project_type: pt,
      slug: h.slug,
      title: h.title,
      author: h.author,
      description: h.description,
      downloads: h.downloads,
      follows: h.follows,
      icon_url: h.icon_url ?? null,
      categories: h.categories ?? [],
      addedAt: Date.now(),
    })
  saveFavorites(store)
  renderResults()
  updateDetail()
}

/** Refresh the status line (header owns the text, status bar mirrors it). */
function setStatus(msg: string) {
  state.status = msg
  statusText.content = msg
}

function defaultIoPath() {
  return utConfig("modify", "favorites-export.json")
}

/** Write every favorite to a JSON file the user can back up or move to another machine. */
function exportFavorites(path: string) {
  const store = state.favorites
  try {
    mkdirSync(dirname(path), { recursive: true })
    const payload = {
      app: "modify",
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      count: store.favorites.length,
      favorites: store.favorites,
    }
    writeFileSync(path, JSON.stringify(payload, null, 2))
    setStatus(`Exported ${store.favorites.length} favorite(s) to ${path}`)
  } catch (e) {
    setStatus(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Read a JSON file and merge its favorites into the current store (ids already present win). */
function importFavorites(path: string) {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    setStatus(`Import failed: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  const incoming = parseFavorites(raw)
  if (!incoming) {
    setStatus(`Import failed: no favorites array in ${path}`)
    return
  }
  const store = state.favorites
  let added = 0
  for (const f of incoming) {
    if (store.favorites.some((x) => x.project_id === f.project_id)) continue
    store.favorites.push({ ...f, addedAt: Date.now() })
    added++
  }
  if (added > 0) saveFavorites(store)
  if (state.favoritesView) prefetchIcons(currentResults())
  renderResults()
  updateDetail()
  refreshHeader()
  setStatus(`Imported ${added} new favorite(s) from ${path} (${incoming.length} in file, ${store.favorites.length} total)`)
}

function moveSel(delta: number) {
  const res = currentResults()
  if (res.length === 0) return
  let idx = resultsSelect.getSelectedIndex() + delta
  if (idx < 0) idx = res.length - 1
  if (idx >= res.length) idx = 0
  resultsSelect.setSelectedIndex(idx)
  updateDetail()
}

function nextPage() {
  if (state.favoritesView) return // favorites are not paged
  if (state.offset + state.limit < state.total) {
    state.offset += state.limit
    search(false)
  }
}

function prevPage() {
  if (state.favoritesView) return // favorites are not paged
  if (state.offset >= state.limit) {
    state.offset -= state.limit
    search(false)
  }
}

/** Warm the icon cache in the background for a list of hits. */
function prefetchIcons(hits: Hit[]) {
  for (const h of hits) if (h.icon_url) void imageCache.ensure(h.icon_url)
}

/** Modrinth slug -> CurseForge icon URL (CF covers are sharper); null = not found. */
const cfCoverCache = new Map<string, string | null>()

const LOADER_NAMES = new Set(["fabric", "forge", "quilt", "neoforge", "paper", "bukkit", "spigot", "mojang"])

type CompatInfo = {
  versions: string[]
  loaders: string[]
}

const compatCache = new Map<string, CompatInfo>()
const versionNameCache = new Map<string, string>()

async function versionName(id: string): Promise<string> {
  const hit = versionNameCache.get(id)
  if (hit !== undefined) return hit
  let name = id
  try {
    const res = await fetch(`${MODRINTH}/version/${id}`, { headers: { "User-Agent": "Modify/1.0 (local)" } })
    if (res.ok) {
      const v = (await res.json()) as { version_number?: string; name?: string }
      name = v.version_number || v.name || id
    }
  } catch { /* keep raw id */ }
  versionNameCache.set(id, name)
  return name
}

async function loadCompat(h: Hit): Promise<CompatInfo> {
  const key = h.project_id
  const cached = compatCache.get(key)
  if (cached) return cached
  const info: CompatInfo = {
    versions: [],
    loaders: h.source === "curseforge" ? (h.categories ?? []) : (h.categories ?? []).filter((c) => LOADER_NAMES.has(c.toLowerCase())),
  }
  if (h.source === "modrinth") {
    const versionIds = Array.isArray(h.versions) ? h.versions : []
    const names: string[] = []
    for (const vid of versionIds) names.push(await versionName(vid))
    info.versions = names
  }
  compatCache.set(key, info)
  return info
}

function formatCompat(info: CompatInfo): { versions: string; loaders: string } {
  const versions = info.versions.length > 0 ? `Versions: ${info.versions.join(", ")}` : ""
  const loaders = info.loaders.length > 0 ? `Loaders: ${info.loaders.join(", ")}` : ""
  return { versions, loaders }
}

async function cfCoverFor(slug: string): Promise<string | null> {
  const key = slug.toLowerCase()
  const hit = cfCoverCache.get(key)
  if (hit !== undefined) return hit
  let found: string | null = null
  if (CF_KEY) {
    const url =
      `${CF_API}/v1/mods/search?gameId=432&classId=6&searchFilter=${encodeURIComponent(key)}&sortField=13&sortOrder=desc&index=0&pageSize=5`
    try {
      const res = await fetch(url, {
        headers: {
          "x-api-key": CF_KEY,
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        },
      })
      if (res.ok) {
        const data = (await res.json()) as CfSearchResponse
        const m = (data.data ?? []).find((x) => (x.slug ?? "").toLowerCase() === key)
        found = m?.logo?.url ?? m?.logo?.thumbnailUrl ?? null
      }
    } catch {
      found = null
    }
  }
  cfCoverCache.set(key, found)
  return found
}

async function updateDetail() {
  const h = selectedHit()
  if (!h) {
    detailTitle.content = "No selection"
    authorText.content = ""
    synopsisText.content = ""
    downloadsText.content = ""
    compatText.content = ""
    compatLoadersText.content = ""
    coverImage.source = undefined
    currentImageUrl = null
    renderer.requestRender()
    return
  }
  detailTitle.content = h.title
  authorText.content = h.author ? `by ${h.author}` : ""
  synopsisText.content = h.description?.trim() ? h.description : ""
  downloadsText.content = `Downloads: ${fmtCount(h.downloads)}`
  catText.content = `Categories: ${(h.categories ?? []).join(", ")}`
  // Cover art: serve from cache (memory/disk); fetch in background otherwise.
  // Mods that also exist on CurseForge get the CF cover (sharper) when found.
  const baseUrl = h.icon_url ?? null
  const url = h.source === "curseforge" ? baseUrl : (await cfCoverFor(h.slug)) ?? baseUrl
  const cached = url ? imageCache.get(url) : null
  if (url && !cached) void imageCache.ensure(url)
  if (url && cached) {
    if (currentImageUrl !== url) {
      coverImage.source = cached
      currentImageUrl = url
    }
  } else {
    coverImage.source = undefined
    currentImageUrl = null
  }
  const compat = await loadCompat(h)
  const { versions, loaders } = formatCompat(compat)
  compatText.content = versions
  compatLoadersText.content = loaders
  renderer.requestRender()
}

const { renderer } = ctx
const root = ctx.root

const header = new TextRenderable(renderer, { content: "Modify — Modrinth TUI", fg: "#7aa2f7" })
root.add(header)

const searchInput = new InputRenderable(renderer, { placeholder: "Search mods/resource packs...", width: "100%" })
root.add(searchInput)

const statusText = new TextRenderable(renderer, { content: state.status })
root.add(statusText)

const catText = new TextRenderable(renderer, { content: "Modloaders: —", fg: "#6b7280" })
root.add(catText)

const body = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, gap: 1 })
root.add(body)

const resultsSelect = new SelectRenderable(renderer, {
  width: "74%",
  options: [],
  showDescription: false,
  backgroundColor: "#11141c",
  selectedBackgroundColor: "#2b3a55",
  selectedTextColor: "#ffffff",
})
body.add(resultsSelect)

const detailBox = new BoxRenderable(renderer, {
  width: "26%",
  flexDirection: "column",
  gap: 0,
  padding: 1,
  backgroundColor: "#11141c",
  border: ["left"],
  borderColor: "#3b4261",
})
body.add(detailBox)

const coverImage = new ImageRenderable(renderer, { width: 20, height: 10 })
detailBox.add(coverImage)

const detailTitle = new TextRenderable(renderer, { content: "No selection", fg: "#e0e0e0" })
detailBox.add(detailTitle)

const authorText = new TextRenderable(renderer, { content: "", fg: "#9aa5ce" })
detailBox.add(authorText)

const downloadsText = new TextRenderable(renderer, { content: "", fg: "#e0af68" })
detailBox.add(downloadsText)

const synopsisText = new TextRenderable(renderer, { content: "", fg: "#a9b1d6" })
detailBox.add(synopsisText)

const compatText = new TextRenderable(renderer, { content: "", fg: "#6b7280" })
detailBox.add(compatText)

const compatLoadersText = new TextRenderable(renderer, { content: "", fg: "#6b7280" })
detailBox.add(compatLoadersText)

const helpText = new TextRenderable(renderer, {
  content:
    "q quit | / or Enter focus search (type = live search) | Enter submit | Tab type | s sort (Shift+s dir) | f fav | F fav-view | e export | i import | c source | ? help",
  fg: "#6b7280",
})
root.add(helpText)

const helpBox = new BoxRenderable(renderer, {
  position: "absolute",
  left: 10,
  top: 5,
  width: 60,
  height: 20,
  backgroundColor: "#11141c",
  borderColor: "#7aa2f7",
  padding: 1,
  flexDirection: "column",
  zIndex: 10,
  visible: false,
})
root.add(helpBox)
const helpLines = [
  "Help — keybinds",
  "",
  "/ or Enter  focus search box",
  "type        live search (debounced)",
  "Enter       submit search + back to results",
  "Esc         blur input",
  "Tab         toggle Mods / Resource Packs",
  "s           cycle sort",
  "Shift+s     toggle sort direction",
  "Up/Down     navigate results (Shift = 5 at a time)",
  "j/k         navigate results (vim)",
  "f           toggle favorite",
  "F           toggle favorites view",
  "e           export favorites to JSON",
  "i           import favorites from JSON",
  "c           switch source (Modrinth / CurseForge)",
  "?           toggle help",
  "q           quit",
]
for (const l of helpLines) helpBox.add(new TextRenderable(renderer, { content: l }))

// Import/export path row (hidden by default)
const ioInput = new InputRenderable(renderer, { placeholder: "JSON file path...", width: "100%", visible: false })
root.add(ioInput)
let ioMode: "export" | "import" | null = null

function refreshHeader() {
  const sourceLabel = state.source === "curseforge" ? "CurseForge" : "Modrinth"
  header.content = `Modify — ${sourceLabel} | ${state.projectType === "mod" ? "Mods" : "Resource Packs"} | sort: ${SORTS[state.sortIndex]} ${state.sortDir} | ${state.favoritesView ? "FAVORITES" : "SEARCH"}`
  statusText.content = state.status
}

function toggleHelp() {
  state.helpVisible = !state.helpVisible
  helpBox.visible = state.helpVisible
}

/** Show the path row for an export or import; Enter confirms, Esc cancels. */
function openIo(mode: "export" | "import") {
  ioMode = mode
  // Empty value keeps Enter = default path; the placeholder shows what that is.
  ioInput.value = ""
  ioInput.placeholder = defaultIoPath()
  ioInput.visible = true
  ioInput.focus()
  setStatus(`${mode === "export" ? "Export to" : "Import from"}: type path, Enter = default, Esc cancels`)
}

function closeIo() {
  ioMode = null
  ioInput.value = ""
  ioInput.blur()
  ioInput.visible = false
}

// Live search: debounce keystrokes into queries; Enter submits immediately.
const LIVE_SEARCH_MS = 350
let liveTimer: ReturnType<typeof setTimeout> | null = null

/** Run a search for the given query, leaving favorites view if active. */
function applyQuery(q: string) {
  if (state.favoritesView) {
    state.favoritesView = false
    refreshHeader()
  }
  state.query = q
  search(true)
}

function scheduleLiveSearch() {
  const q = searchInput.value
  if (q === state.query) return
  if (liveTimer) clearTimeout(liveTimer)
  liveTimer = setTimeout(() => {
    liveTimer = null
    applyQuery(q)
  }, LIVE_SEARCH_MS)
}

// Events
searchInput.on("input", () => scheduleLiveSearch())

searchInput.on("enter", () => {
  if (liveTimer) {
    clearTimeout(liveTimer)
    liveTimer = null
  }
  applyQuery(searchInput.value)
  searchInput.blur()
})

ioInput.on("enter", () => {
  const path = ioInput.value.trim() || defaultIoPath()
  const mode = ioMode
  closeIo()
  if (mode === "export") exportFavorites(path)
  else if (mode === "import") importFavorites(path)
  refreshHeader()
})

resultsSelect.on("selectionChanged", () => {
  updateDetail()
})

let wantsQuit = false
const handleKey = (key: KeyLike): void => {
  const focused = renderer.currentFocusedRenderable
  const inInput = focused === searchInput || focused === ioInput

  if (state.helpVisible) {
    state.helpVisible = false
    helpBox.visible = false
    return
  }

  if (key.name === "q" && !inInput) {
    wantsQuit = true
    return
  }
  if (!inInput && (key.name === "/" || key.name === "enter" || key.name === "return")) {
    // Focus the search box (same key submits from inside the input).
    key.stopPropagation?.()
    searchInput.focus()
    return
  }
  if (inInput && key.name === "escape") {
    if (focused === searchInput) searchInput.blur()
    if (focused === ioInput) {
      closeIo()
      refreshHeader()
    }
    return
  }
  if (focused === searchInput && (key.name === "up" || key.name === "down" || key.name === "pageup" || key.name === "pagedown")) {
    // Non-typable navigation keys release the search box and act at once,
    // so live search doesn't leave paging/selection stuck behind the input.
    searchInput.blur()
    if (key.name === "up") moveSel(key.shift ? -5 : -1)
    else if (key.name === "down") moveSel(key.shift ? 5 : 1)
    else if (key.name === "pageup") prevPage()
    else nextPage()
    return
  }
  if (inInput) return

  if (key.name === "c") {
    if (state.favoritesView) return // source switch only applies to search results
    state.source = state.source === "modrinth" ? "curseforge" : "modrinth"
    refreshHeader()
    search(true)
    return
  }
  if (key.name === "t") {
    if (state.favoritesView) return // type toggle not meaningful in favorites view
    state.projectType = state.projectType === "mod" ? "resourcepack" : "mod"
    search(true)
    refreshHeader()
    return
  }
  if (key.name === "s" && key.shift) {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc"
    if (state.favoritesView) {
      renderResults() // favorites sort client-side via currentResults()
    } else {
      search(true)
    }
    refreshHeader()
    return
  }
  if (key.name === "s") {
    state.sortIndex = (state.sortIndex + 1) % SORTS.length
    if (state.favoritesView) {
      renderResults() // favorites sort client-side via currentResults()
    } else {
      search(true)
    }
    refreshHeader()
    return
  }
  if (key.name === "f" && key.shift) {
    // Shift+F — toggle favorites view (OpenTUI reports shift+F as name "f", shift true)
    state.favoritesView = !state.favoritesView
    if (state.favoritesView) {
      state.savedResults = [...state.results]
      prefetchIcons(currentResults())
    } else {
      state.results = state.savedResults
    }
    renderResults()
    updateDetail()
    refreshHeader()
    return
  }
  if (key.name === "f") {
    toggleFavorite()
    return
  }
  if (key.name === "e") {
    key.stopPropagation?.() // the freshly-focused path input must not also receive "e"
    openIo("export")
    return
  }
  if (key.name === "i") {
    key.stopPropagation?.()
    openIo("import")
    return
  }
  if (key.name === "?") {
    toggleHelp()
    return
  }
  if (key.name === "r") {
    search(true)
    return
  }
  if (key.name === "up" || key.name === "k") {
    key.stopPropagation?.() // the focused Select also binds up/k — don't double-step
    moveSel(key.shift ? -5 : -1)
    return
  }
  if (key.name === "down" || key.name === "j") {
    key.stopPropagation?.()
    moveSel(key.shift ? 5 : 1)
    return
  }
  if (key.name === "pageup" || key.name === "b") {
    prevPage()
    return
  }
  if (key.name === "pagedown" || key.name === "n") {
    nextPage()
    return
  }
  if (key.name === "right" || key.name === "l") {
    nextPage()
    return
  }
  if (key.name === "left" || key.name === "h") {
    prevPage()
    return
  }
}

  // initial
  imageCache.setOnChange(() => updateDetail()) // icon fetch finished -> paint cover
  resultsSelect.focus() // start on results list, not the search box
  await search(true)

  return {
  name: "minecraft mods",
  key(k: KeyLike): boolean {
    wantsQuit = false
    handleKey(k)
    return wantsQuit
  },
  activate(): void {
    refreshHeader()
    renderResults()
    updateDetail()
    resultsSelect.focus()
  },
  deactivate(): void {},
  resize(): void {
    renderer.requestRender()
    updateDetail() // re-fit the cover to the new terminal size
  },
  announce(msg: string): void {
    setStatus(msg)
    renderer.requestRender()
  },
  dispose(): void {
    if (liveTimer) clearTimeout(liveTimer)
  },
}
}
