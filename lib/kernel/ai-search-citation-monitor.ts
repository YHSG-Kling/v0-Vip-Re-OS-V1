// lib/kernel/ai-search-citation-monitor.ts
//
// THE AI-SEARCH CITATION MONITOR — the natural pair to the m222 GEO auto-publish
// reel pages. m222 makes every broker-approved reel a public /v/[slug] page so AI
// search engines CAN cite it; this monitor tracks whether they ACTUALLY DO.
//
// For a brokerage's recently-published reels it issues a gated external query
// (brand + listing) to the SAME web-search rail the rest of the app uses
// (lib/ai/web-search → Exa/Tavily through the connector-gateway), detects whether
// the AI/search answer references OUR /v/[slug] URL or brand, records one honest
// observation per (page, platform, day) in ai_search_citation_observations (m223),
// and scores AI-search visibility 0..1 so the GEO loop can improve.
//
// HONESTY is first-class. The monitor NEVER fabricates a citation:
//   · cited       — the answer referenced our /v/[slug] URL or brand
//   · not_cited   — the search ran but did not reference us
//   · not_checked — the search rail was unavailable (no creds / no provider). We
//                   record the gap and it contributes to NEITHER the numerator NOR
//                   the checked denominator of the score.
//
// The PURE core (scoreCitationVisibility / detectOurCitation) is total + unit-tested
// in scripts/citation-monitor-simulator.ts without egress. The runner takes an
// injectable searchFetcher seam (real web-search default; the simulator injects
// fixed results) and is idempotent per (project, platform, day) via the m223 upsert.
// NOT server-only — the simulator imports it directly.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

// ── Vocabulary (mirrors the m223 CHECK constraints + geo-platform-optimizer) ──

/** The AI-search platforms we observe — the geo-platform-optimizer rail. */
export const CITATION_PLATFORMS = [
  "google_ai_overviews",
  "chatgpt",
  "perplexity",
  "gemini",
  "bing_copilot",
] as const
export type CitationPlatform = (typeof CITATION_PLATFORMS)[number]

/** Honest outcome vocabulary — `not_checked` is the degrade, never a fabricated miss. */
export type CitationOutcome = "cited" | "not_cited" | "not_checked"

export interface CitationObservation {
  platform: CitationPlatform
  outcome:  CitationOutcome
}

// ── PURE: detect whether a search answer cites OUR pages/brand ──

export interface DetectionTarget {
  /** Our citable /v/[slug] URLs (full URL) AND any standalone slugs to match. */
  slugs:    string[]
  /** Our domains/hosts (from NEXT_PUBLIC_APP_URL) — a bare domain mention counts. */
  domains:  string[]
  /** Brand strings (brokerage + agent name). A brand mention is an unlinked citation. */
  brands:   string[]
}

export interface DetectionResult {
  cited:    boolean
  /** When cited via a URL/slug, the matched URL or slug; when cited only via brand, the brand. */
  matched:  string | null
  /** "url" (a /v/[slug] or domain appeared) is a STRONGER citation than "brand" (unlinked mention). */
  kind:     "url" | "brand" | null
}

/** Normalize for substring matching — lowercase, collapse whitespace. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * PURE + total: does an AI/search answer text reference one of OUR published
 * /v/[slug] pages, domains, or brand strings?
 *
 * A URL/slug/domain match is the gold signal (the answer points AT our page). A
 * brand-only match is the weaker "unlinked brand mention" signal the
 * geo-brand-mentions discipline values. URL/slug is checked first so `kind`
 * reflects the strongest evidence. Empty text or no targets → not cited (never
 * a false positive). No network, no DB.
 */
export function detectOurCitation(searchResultText: string, target: DetectionTarget): DetectionResult {
  const hay = norm(searchResultText || "")
  if (!hay) return { cited: false, matched: null, kind: null }

  // Strongest first: a full /v/[slug] URL or a bare slug appearing in the answer.
  for (const raw of target.slugs ?? []) {
    const needle = norm(raw)
    // Guard against trivially-short slugs producing accidental matches.
    if (needle.length >= 4 && hay.includes(needle)) {
      return { cited: true, matched: raw, kind: "url" }
    }
  }
  // A bare domain mention (our host appears) — still points at our property.
  for (const raw of target.domains ?? []) {
    const needle = norm(raw)
    if (needle.length >= 4 && hay.includes(needle)) {
      return { cited: true, matched: raw, kind: "url" }
    }
  }
  // Weaker: an unlinked brand mention.
  for (const raw of target.brands ?? []) {
    const needle = norm(raw)
    if (needle.length >= 3 && hay.includes(needle)) {
      return { cited: true, matched: raw, kind: "brand" }
    }
  }
  return { cited: false, matched: null, kind: null }
}

// ── PURE: who ELSE did the answer name? ──

/** A competitor we watch, as stored on competitors / competitor_profiles. */
export interface CompetitorTarget {
  name: string
  /** Their site, when we know it. A domain match is the strong signal. */
  domain?: string | null
}

/**
 * PURE + total: which of the brokerages we watch appear in this SAME answer?
 *
 * This is the other half of the citation question, and the half that was being
 * thrown away. detectOurCitation reads the answer and decides about US, then the
 * text was discarded — so the OS could report a hit rate but never share of
 * voice, which is the number that can move the OPPOSITE way. Run against the
 * text already in memory, so it costs no extra provider call.
 *
 * Conservative by design: a domain match, or a competitor NAME long enough not
 * to collide with ordinary prose. Short names are skipped rather than guessed —
 * a false competitor citation would understate our own share and send a broker
 * chasing a rival who was never mentioned.
 */
export function detectCompetitorCitations(
  searchResultText: string, competitors: ReadonlyArray<CompetitorTarget>,
): string[] {
  const hay = norm(searchResultText || "")
  if (!hay || !competitors?.length) return []

  const found = new Set<string>()
  for (const c of competitors) {
    const name = String(c?.name ?? "").trim()
    if (!name) continue

    const domain = norm(String(c?.domain ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    if (domain.length >= 4 && hay.includes(domain)) { found.add(name); continue }

    // 4 chars is the same floor detectOurCitation uses for a slug/domain. A
    // brokerage called "EXP" or "KW" is skipped rather than matched against
    // every occurrence of those letters inside other words.
    const needle = norm(name)
    if (needle.length >= 4 && hay.includes(needle)) found.add(name)
  }
  return [...found].sort()
}

// ── PURE: score AI-search visibility from REAL recorded observations ──

export interface VisibilityScore {
  /** 0..1 visibility = cited / checked. NULL when nothing was actually checked
   *  (all not_checked or empty) — we report the honest gap, never a fabricated 0
   *  that would read as "definitely not cited". */
  score:      number | null
  cited:      number
  notCited:   number
  notChecked: number
  /** cited + notCited — the denominator that actually ran. */
  checked:    number
  total:      number
  /** Why score is null, when it is (for honest surfacing). */
  reason:     string | null
}

/**
 * PURE + total: AI-search visibility 0..1 over a set of recorded observations.
 *
 *   score = cited / (cited + not_cited)
 *
 * `not_checked` rows count toward NEITHER side — a search we couldn't run can't
 * raise OR lower visibility. If nothing was checked (all not_checked, or empty),
 * `score` is null with a reason rather than a misleading 0. all-cited → 1.0,
 * mixed → in-between, all-not_cited → 0.0 (an honest zero — we DID look).
 */
export function scoreCitationVisibility(observations: ReadonlyArray<CitationObservation>): VisibilityScore {
  let cited = 0, notCited = 0, notChecked = 0
  for (const o of observations) {
    if (o.outcome === "cited") cited++
    else if (o.outcome === "not_cited") notCited++
    else notChecked++
  }
  const total = cited + notCited + notChecked
  const checked = cited + notCited

  if (total === 0) {
    return { score: null, cited, notCited, notChecked, checked, total, reason: "no_observations" }
  }
  if (checked === 0) {
    return { score: null, cited, notCited, notChecked, checked, total, reason: "not_checked_search_rail_unavailable" }
  }
  return { score: cited / checked, cited, notCited, notChecked, checked, total, reason: null }
}

// ── The external-search seam (gated, honest-degrade) ──

/** What the runner asks the search rail for, per platform query. */
export interface SearchFetchResult {
  /** Combined answer + result snippets to scan for our citation. */
  text:     string
  /** The provider that answered: "tavily" | "exa" | "none". "none" ⇒ not_checked. */
  provider: string
}

/** Injectable seam: run ONE brand+listing query and return the answer/snippets.
 *  Real default = lib/ai/web-search (Exa/Tavily via connector-gateway). The
 *  simulator injects fixed results so no egress / spend in tests. */
export type SearchFetcher = (params: { query: string; brokerageId: string }) => Promise<SearchFetchResult>

/**
 * REAL search fetcher — the app-wide web-search rail in "research" mode (Tavily
 * synthesized answer first, the closest analog to an AI-search answer; Exa
 * fallback). Honest-degrade: web-search NEVER throws and returns provider "none"
 * with no hits when no creds are configured → the runner records not_checked.
 * No key is read or logged here — that lives env-only inside the clients.
 */
export const realSearchFetcher: SearchFetcher = async (params) => {
  const { webSearch, formatWebSearchContext } = await import("@/lib/ai/web-search")
  const res = await webSearch({ query: params.query, maxResults: 8, mode: "research" }).catch(
    () => ({ answer: null, hits: [], provider: "none" as const, cost: 0 }),
  )
  if (res.provider === "none") return { text: "", provider: "none" }
  const text = `${res.answer ?? ""}\n${formatWebSearchContext(res)}`.trim()
  return { text, provider: res.provider }
}

// ── Helpers ──

/** The public site origin the /v/[slug] pages live on (same source as app/v/[slug]). */
export function siteOrigin(): string {
  const { siteUrl } = require("@/lib/platform/site-url") as typeof import("@/lib/platform/site-url")
  return siteUrl()
}

/** Host (no scheme) of the site origin — the bare-domain detection target. */
export function siteHost(): string {
  return siteOrigin().replace(/^https?:\/\//, "").replace(/\/$/, "")
}

/** PURE: the brand+listing query we issue for a reel — names the brand + the
 *  listing place so an AI-search answer about that home could surface our page. */
export function buildCitationQuery(args: {
  brandName: string | null
  title:     string | null
  city:      string | null
  state:     string | null
}): string {
  const place = [args.city, args.state].filter(Boolean).join(", ")
  const subject = (args.title && args.title.trim()) || "real estate video"
  const brand = (args.brandName && args.brandName.trim()) || "real estate"
  return [subject, place ? `in ${place}` : "", `by ${brand}`].filter(Boolean).join(" ").trim()
}

/**
 * PURE: the query we issue for a LEAD-MAGNET / FAQ landing page. Unlike a reel (a
 * branded listing query), a lead-magnet page targets an INFORMATIONAL question an AI
 * search engine actually answers — so we issue the real demand QUESTION itself
 * (optionally placed), brand-FREE, and then detect whether the answer cites US. Keeping
 * the brand OUT of the query is the honest signal: "for this real question, does AI
 * search surface our page on its own merits?"
 */
export function buildLandingCitationQuery(args: {
  topQuestion: string | null
  fallback:    string | null
  area:        string | null
}): string {
  const q = (args.topQuestion && args.topQuestion.trim()) || (args.fallback && args.fallback.trim()) || "real estate help"
  const place = args.area && args.area.trim() ? `in ${args.area.trim()}` : ""
  return [q.replace(/\s+/g, " ").trim(), place].filter(Boolean).join(" ").trim()
}

// ── The runner ──

export interface CitationMonitorOptions {
  now?:           Date
  /** Injectable external-search seam — real web-search default. */
  searchFetcher?: SearchFetcher
  /** Which platforms to record this pass for. Defaults to all five. */
  platforms?:     CitationPlatform[]
  /** Cap of recently-published reels to monitor per pass. */
  maxPages?:      number
  /** Look-back window (days) for "recently published". */
  windowDays?:    number
}

export interface CitationMonitorResult {
  pagesMonitored:  number
  observations:    number
  cited:           number
  notCited:        number
  notChecked:      number
  /** Brokerage-wide AI-search visibility over THIS pass's observations (null when
   *  nothing was checkable — honest degrade). */
  visibility:      VisibilityScore
  /** Per-page roll-up for the surface (Content Studio / dashboard). */
  pages: Array<{
    projectId:  string
    slug:       string
    title:      string | null
    visibility: VisibilityScore
    citedUrl:   string | null
  }>
}

/**
 * The brokerage's watched competitors, for share-of-voice detection.
 *
 * Two tables hold them for two different features (competitors is the simple
 * watch list, competitor_profiles the richer intel record), so both are read and
 * merged by name — a broker who added a rival in one surface must not be
 * invisible to the other. Never throws: share of voice is an enrichment, and a
 * read failure must not stop the citation monitor from recording OUR outcome.
 */
async function loadCompetitorTargets(supabase: Svc, brokerageId: string): Promise<CompetitorTarget[]> {
  const byName = new Map<string, CompetitorTarget>()
  const add = (name: unknown, domain: unknown) => {
    const n = String(name ?? "").trim()
    if (!n) return
    const key = n.toLowerCase()
    const d = String(domain ?? "").trim() || null
    const existing = byName.get(key)
    if (!existing) byName.set(key, { name: n, domain: d })
    else if (!existing.domain && d) existing.domain = d
  }
  try {
    const { data } = await supabase.from("competitors")
      .select("competitor_name, competitor_url").eq("brokerage_id", brokerageId)
    for (const r of (data ?? []) as any[]) add(r.competitor_name, r.competitor_url)
  } catch { /* enrichment only */ }
  try {
    const { data } = await supabase.from("competitor_profiles")
      .select("competitor_name, website_url").eq("brokerage_id", brokerageId).eq("is_active", true)
    for (const r of (data ?? []) as any[]) add(r.competitor_name, r.website_url)
  } catch { /* enrichment only */ }
  return [...byName.values()]
}

/**
 * WHO OWNS THE PAGE — resolved ONCE per pass for every agent the pass touches,
 * not once per page (a per-page read would multiply the query count by the page
 * count for data that cannot change mid-pass).
 *
 * Returns the agent's team AND their display name, because both are needed and
 * both come from the same two rows:
 *
 *   · team_id is stamped onto the observation so a team lead has a team view.
 *     Stamped AS OF the observation — an agent changing teams must not silently
 *     rewrite last quarter's GEO history.
 *   · the NAME becomes a detection brand. This is the fix for a defect the code
 *     had documented but never implemented: the reel loop's comment said "agent
 *     attribution for the brand targets" while brands carried the BROKERAGE name
 *     alone. So an AI answer that named the agent — the single most valuable
 *     citation a real-estate agent can get, and the one their personal brand is
 *     built on — was recorded as not_cited. The score was not merely incomplete;
 *     it asserted a miss that had not happened.
 *
 * Never throws: scope + attribution are enrichment, and a read failure must not
 * stop the monitor from recording OUR outcome.
 */
interface PageOwner {
  /** ALWAYS agents.id — the observation column FKs agents, and agents.team_id is
   *  where the team lives. Never a users.id, whatever the source column held. */
  agentId: string
  teamId: string | null
  name: string | null
}

/**
 * TWO IDENTITY CLASSES, ONE COLUMN NAME — the trap this function exists to
 * absorb. The two citable-page tables both call their owner column `agent_id`
 * and they mean different things:
 *
 *   · ai_video_projects.agent_id  FKs AGENTS (an agents.id) — since m366; it was
 *     a users.id before, which is why the caller declares its class here
 *   · lead_capture_forms.agent_id FKs AGENTS (an agents.id)
 *
 * Stamping either straight onto the observation would be wrong for one of them:
 * the observation's agent_id FKs agents, and every scoped read joins through
 * agents.team_id. The reel path would have raised a foreign-key violation on
 * EVERY write — caught by inserting a real row against the live schema rather
 * than by reading the column name and trusting it.
 *
 * So the caller declares which class its ids are, and this returns a map keyed
 * by THAT id whose value always carries the canonical agents.id.
 */
async function loadPageOwners(
  supabase: Svc,
  ids: string[],
  keyClass: "users" | "agents",
  brokerageId: string,
): Promise<Map<string, PageOwner>> {
  const owners = new Map<string, PageOwner>()
  const unique = [...new Set(ids.filter((a): a is string => !!a))]
  if (unique.length === 0) return owners
  try {
    const keyColumn = keyClass === "users" ? "user_id" : "id"
    const { data } = await supabase.from("agents")
      .select("id, team_id, user_id, users(first_name, last_name)")
      // TENANT-SCOPED. The ids come from this brokerage's own pages, so this
      // filter should never change the result — which is exactly why it belongs
      // here: an id that somehow crossed tenants would otherwise resolve a
      // stranger's name and team onto our observation, and nothing would say so.
      .eq("brokerage_id", brokerageId)
      .in(keyColumn, unique)
    for (const r of (data ?? []) as any[]) {
      const full = [r.users?.first_name, r.users?.last_name].filter(Boolean).join(" ").trim()
      const key = keyClass === "users" ? r.user_id : r.id
      if (!key) continue
      owners.set(key, { agentId: r.id, teamId: r.team_id ?? null, name: full || null })
    }
  } catch { /* enrichment only */ }
  return owners
}

/**
 * Run one citation-monitor pass for a brokerage.
 *
 * For each recently-published reel (ai_video_projects.is_published, public_slug set,
 * within windowDays), issue ONE gated external query and, for each platform, record
 * an honest observation (cited / not_cited / not_checked) — idempotent per
 * (project, platform, observed_on) via the m223 unique index UPSERT. Then compute
 * the per-page + brokerage visibility score from the REAL recorded outcomes.
 *
 * The same external answer is evaluated for every platform this pass: our rail
 * issues ONE web query (we don't have per-platform AI-search APIs), so the
 * observation records WHICH platform vocabulary it belongs to while sharing the
 * underlying evidence — honest about provider, never fabricating a per-platform
 * difference. When the rail is unavailable every platform records not_checked.
 *
 * Always tenant-scoped by brokerage_id. Never sends, never spends beyond the one
 * gated search per page. Returns a read-only summary the surface can show.
 */
export async function runCitationMonitor(
  brokerageId: string,
  opts: CitationMonitorOptions = {},
  client?: Svc,
): Promise<CitationMonitorResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const fetcher = opts.searchFetcher ?? realSearchFetcher
  const platforms = opts.platforms ?? [...CITATION_PLATFORMS]
  const maxPages = opts.maxPages ?? 25
  const windowDays = opts.windowDays ?? 30
  const observedOn = now.toISOString().slice(0, 10)

  // Loaded ONCE per pass, not per page — the watch list does not change between
  // pages and a per-page read would multiply the query count by the page count.
  const competitorTargets = await loadCompetitorTargets(supabase, brokerageId)
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString()

  const result: CitationMonitorResult = {
    pagesMonitored: 0, observations: 0, cited: 0, notCited: 0, notChecked: 0,
    visibility: scoreCitationVisibility([]), pages: [],
  }

  // Brand once per brokerage (the brand-mention detection target).
  const { data: brk } = await supabase.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
  const brandName = (brk as { name: string | null } | null)?.name ?? null
  const host = siteHost()
  const origin = siteOrigin()

  // Recently-published reels with a live public page.
  const { data: reels } = await supabase.from("ai_video_projects")
    .select("id, title, listing_id, public_slug, published_at, agent_id")
    .eq("brokerage_id", brokerageId)
    .eq("is_published", true)
    .not("public_slug", "is", null)
    .gte("published_at", since)
    .order("published_at", { ascending: false })
    .limit(maxPages)
  const pages = (reels ?? []) as Array<{
    id: string; title: string | null; listing_id: string | null;
    public_slug: string | null; published_at: string | null; agent_id: string | null
  }>

  // One read for every agent in the pass — team (for scope) + name (for brand).
  // ai_video_projects.agent_id became agents-class in m366; keying this by
  // "users" now matches nothing, so every reel page would lose its agent brand
  // target and its team scope silently.
  const owners = await loadPageOwners(supabase, pages.map((p) => p.agent_id ?? ""), "agents", brokerageId)

  const allObs: CitationObservation[] = []

  for (const page of pages) {
    if (!page.public_slug) continue
    result.pagesMonitored += 1

    // Listing place for the query. (Agent attribution for the brand targets is
    // resolved above from loadPageOwners — this comment used to claim it
    // happened here, while brands carried the brokerage name alone.)
    let city: string | null = null, state: string | null = null
    if (page.listing_id) {
      const { data: l } = await supabase.from("listings")
        .select("city, state").eq("id", page.listing_id).eq("brokerage_id", brokerageId).maybeSingle()
      const lr = l as { city: string | null; state: string | null } | null
      city = lr?.city ?? null; state = lr?.state ?? null
    }

    const slug = page.public_slug
    const pageUrl = `${origin}/v/${slug}`
    // BOTH brands. The agent's own name is the citation that matters most to
    // them and it was never a target — see loadPageOwners. The brokerage name
    // stays: a brokerage-level page has no agent, and an answer naming the
    // company is still a real citation.
    const owner = page.agent_id ? owners.get(page.agent_id) ?? null : null
    const target: DetectionTarget = {
      slugs:   [pageUrl, `/v/${slug}`, slug],
      domains: [host],
      brands:  [brandName, owner?.name ?? null]
        .filter((b): b is string => !!b && b.trim().length >= 3),
    }

    const query = buildCitationQuery({ brandName, title: page.title, city, state })

    // ONE gated external search per page. Honest-degrade → not_checked.
    const fetched = await fetcher({ query, brokerageId }).catch(() => ({ text: "", provider: "none" }))
    const ran = fetched.provider !== "none" && fetched.text.trim().length > 0
    const detection = ran ? detectOurCitation(fetched.text, target) : { cited: false, matched: null, kind: null as null }

    const outcome: CitationOutcome = !ran ? "not_checked" : detection.cited ? "cited" : "not_cited"
    const citedUrl = outcome === "cited" ? detection.matched : null
    // WHO ELSE the answer named, from the SAME text — no extra provider call.
    // NULL when the search never ran: an empty array would claim we looked and
    // found nobody, which is a different (and false) statement from "we could
    // not look at all".
    const competitorsCited = ran ? detectCompetitorCitations(fetched.text, competitorTargets) : null

    const pageObs: CitationObservation[] = []
    for (const platform of platforms) {
      // Idempotent UPSERT per (project, platform, day) — a rerun overwrites the
      // day's row (latest observation wins), never appends/inflates.
      const { error } = await supabase.from("ai_search_citation_observations")
        .upsert({
          brokerage_id: brokerageId,
          // WHOSE citation this is (m335) — GEO is for agents, teams and
          // brokerages, and a row that knows only its tenant can answer only
          // the brokerage question.
          agent_id:     owner?.agentId ?? null,
          team_id:      owner?.teamId ?? null,
          project_id:   page.id,
          public_slug:  slug,
          platform,
          query,
          outcome,
          cited_url:    citedUrl,
          competitors_cited: competitorsCited,
          provider:     fetched.provider,
          observed_on:  observedOn,
          observed_at:  now.toISOString(),
        }, { onConflict: "project_id,platform,observed_on" })
      if (error) continue
      const ob: CitationObservation = { platform, outcome }
      pageObs.push(ob); allObs.push(ob)
      result.observations += 1
      if (outcome === "cited") result.cited += 1
      else if (outcome === "not_cited") result.notCited += 1
      else result.notChecked += 1
    }

    result.pages.push({
      projectId:  page.id,
      slug,
      title:      page.title,
      visibility: scoreCitationVisibility(pageObs),
      citedUrl,
    })
  }

  result.visibility = scoreCitationVisibility(allObs)
  return result
}

// ── Lead-magnet / FAQ landing-page citation monitor (the GEO INGRESS for /lm/[slug]) ──
//
// The natural pair to the AI lead-magnet copy + GEO FAQ now published on /lm/[slug]:
// that work makes a lead-magnet page CITABLE (real demand copy + schema.org FAQPage
// JSON-LD); this tracks whether AI search engines ACTUALLY cite it. It reuses the SAME
// pure core (detectOurCitation / scoreCitationVisibility) + the same gated web-search
// rail, recording honest observations into ai_search_landing_citation_observations
// (FK'd to lead_capture_forms — reels and landing pages are kept in their own tables).

export interface LandingCitationMonitorResult {
  pagesMonitored: number
  observations:   number
  cited:          number
  notCited:       number
  notChecked:     number
  visibility:     VisibilityScore
  pages: Array<{
    formId:     string
    slug:       string
    title:      string | null
    visibility: VisibilityScore
    citedUrl:   string | null
  }>
}

/** Narrow the persisted landing_content jsonb to the bits the monitor needs. */
function landingForMonitor(raw: unknown): { headline: string | null; faq: Array<{ question: string; answer: string }> } | null {
  if (!raw || typeof raw !== "object") return null
  const lc = raw as Record<string, unknown>
  const faqRaw = Array.isArray(lc.faq) ? lc.faq : []
  const faq = faqRaw.filter((f): f is { question: string; answer: string } =>
    !!f && typeof f === "object" && typeof (f as any).question === "string" && typeof (f as any).answer === "string")
  return { headline: typeof lc.headline === "string" ? lc.headline : null, faq }
}

/**
 * Run one citation-monitor pass for a brokerage's LEAD-MAGNET / FAQ landing pages.
 *
 * For each active lead magnet that has AI-built landing copy with a FAQ (i.e. real GEO
 * content worth being cited for), issue ONE gated external query built from the page's
 * top FAQ question and, per platform, record an honest observation (cited / not_cited /
 * not_checked) — idempotent per (form, platform, day) via the UPSERT. The query is the
 * real demand QUESTION (brand-free); detection still looks for our /lm/[slug] URL,
 * domain, or brand. Always tenant-scoped; never spends beyond the one gated search/page.
 */
export async function runLandingPageCitationMonitor(
  brokerageId: string,
  opts: CitationMonitorOptions & { area?: string | null } = {},
  client?: Svc,
): Promise<LandingCitationMonitorResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const fetcher = opts.searchFetcher ?? realSearchFetcher
  const platforms = opts.platforms ?? [...CITATION_PLATFORMS]
  const maxPages = opts.maxPages ?? 25
  const observedOn = now.toISOString().slice(0, 10)

  // Loaded ONCE per pass, not per page — the watch list does not change between
  // pages and a per-page read would multiply the query count by the page count.
  const competitorTargets = await loadCompetitorTargets(supabase, brokerageId)

  const result: LandingCitationMonitorResult = {
    pagesMonitored: 0, observations: 0, cited: 0, notCited: 0, notChecked: 0,
    visibility: scoreCitationVisibility([]), pages: [],
  }

  const { data: brk } = await supabase.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
  const brandName = (brk as { name: string | null } | null)?.name ?? null
  const host = siteHost()
  const origin = siteOrigin()

  // Active lead magnets that carry AI landing copy (the citable GEO surface).
  const { data: forms } = await supabase.from("lead_capture_forms")
    .select("id, name, slug, landing_content, agent_id")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .not("landing_content", "is", null)
    .limit(maxPages)
  const pages = (forms ?? []) as Array<{
    id: string; name: string | null; slug: string | null; landing_content: unknown; agent_id: string | null
  }>

  // lead_capture_forms.agent_id IS an agents id — the other class.
  const owners = await loadPageOwners(supabase, pages.map((p) => p.agent_id ?? ""), "agents", brokerageId)

  const allObs: CitationObservation[] = []

  for (const page of pages) {
    if (!page.slug) continue
    const landing = landingForMonitor(page.landing_content)
    // Only pages with a real FAQ have GEO content worth a citation check.
    if (!landing || landing.faq.length === 0) continue
    result.pagesMonitored += 1

    const slug = page.slug
    const pageUrl = `${origin}/lm/${slug}`
    const owner = page.agent_id ? owners.get(page.agent_id) ?? null : null
    const target: DetectionTarget = {
      slugs:   [pageUrl, `/lm/${slug}`, slug],
      domains: [host],
      brands:  [brandName, owner?.name ?? null]
        .filter((b): b is string => !!b && b.trim().length >= 3),
    }

    const query = buildLandingCitationQuery({
      topQuestion: landing.faq[0]?.question ?? null,
      fallback:    landing.headline ?? page.name,
      area:        opts.area ?? null,
    })

    const fetched = await fetcher({ query, brokerageId }).catch(() => ({ text: "", provider: "none" }))
    const ran = fetched.provider !== "none" && fetched.text.trim().length > 0
    const detection = ran ? detectOurCitation(fetched.text, target) : { cited: false, matched: null, kind: null as null }
    const outcome: CitationOutcome = !ran ? "not_checked" : detection.cited ? "cited" : "not_cited"
    const citedUrl = outcome === "cited" ? detection.matched : null
    // WHO ELSE the answer named, from the SAME text — no extra provider call.
    // NULL when the search never ran: an empty array would claim we looked and
    // found nobody, which is a different (and false) statement from "we could
    // not look at all".
    const competitorsCited = ran ? detectCompetitorCitations(fetched.text, competitorTargets) : null

    const pageObs: CitationObservation[] = []
    for (const platform of platforms) {
      const { error } = await supabase.from("ai_search_landing_citation_observations")
        .upsert({
          brokerage_id: brokerageId,
          agent_id:     owner?.agentId ?? null,
          team_id:      owner?.teamId ?? null,
          form_id:      page.id,
          public_slug:  slug,
          platform,
          query,
          outcome,
          cited_url:    citedUrl,
          competitors_cited: competitorsCited,
          provider:     fetched.provider,
          observed_on:  observedOn,
          observed_at:  now.toISOString(),
        }, { onConflict: "form_id,platform,observed_on" })
      if (error) continue
      const ob: CitationObservation = { platform, outcome }
      pageObs.push(ob); allObs.push(ob)
      result.observations += 1
      if (outcome === "cited") result.cited += 1
      else if (outcome === "not_cited") result.notCited += 1
      else result.notChecked += 1
    }

    result.pages.push({ formId: page.id, slug, title: page.name, visibility: scoreCitationVisibility(pageObs), citedUrl })
  }

  result.visibility = scoreCitationVisibility(allObs)
  return result
}
