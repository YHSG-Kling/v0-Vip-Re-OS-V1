// lib/kernel/regulatory-watcher.ts
//
// THE REGULATORY-CHANGE WATCHER — keeps the OS's compliance GATES current
// automatically. The 5-gate cascade (lib/kernel/compliance.ts), the Fair-Housing
// pattern list (lib/compliance-rules/fair-housing-patterns.ts + state_protected_classes),
// the BBA/authority gate, the TCPA/CAN-SPAM consent gates and the brand/them-first
// gates are all ENCODED rules. When the law that those rules implement CHANGES (a TCPA
// quiet-hours amendment, a state adding a protected class, an NAR buyer-agreement rule,
// an FTC marketing-claims action), the encoded rule can silently drift out of date.
//
// This watcher SCANS for recent real-estate regulatory changes via the SAME gated
// external-search rail the rest of the app uses (lib/ai/web-search → Tavily/Exa through
// the connector-gateway, "research" mode), MATCHES each described change to the OS
// surfaces it touches, records an honest observation (idempotent per change-signature ×
// period), and ESCALATES a GATED brief to the brokerage's compliance/broker owner over
// the inter-manager bus + the notifications rail ("a TCPA change effective <date>
// affects your <surface> — review").
//
// HONESTY is first-class — the watcher NEVER fabricates a regulation:
//   · A flagged change comes ONLY from a REAL search hit (title/snippet/url/answer).
//   · classifyChangeSeverity reads an effective date ONLY when it is literally present
//     in the change text — it never invents one (effectiveDate stays null otherwise).
//   · When the search rail is unavailable (no creds / provider "none") the runner
//     records "search unavailable / no changes detected" and escalates NOTHING. It does
//     not manufacture a change to look busy.
//
// The PURE core (matchAffectedSurfaces / classifyChangeSeverity / parseChangesFrom
// SearchResult) is total + unit-tested in scripts/regulatory-watcher-simulator.ts
// without egress. The runner takes an injectable searchFetcher seam (real web-search
// default; the simulator injects fixed results) and is idempotent per
// (change-signature, period) via the m224 upsert. NOT server-only — the simulator
// imports it directly.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

// ─────────────────────────────────────────────────────────────────────────────
// THE OS COMPLIANCE-SURFACE CATALOG — the things a reg change can AFFECT.
//
// Each surface is a real encoded rule/gate/template in the OS. A matched change
// names the surfaces a human must REVIEW (the watcher proposes review, it never
// auto-edits a gate). `keywords` are the deterministic match terms; `authority`
// is the regulator whose changes touch this surface; `file` points the reviewer
// at the encoded rule to update.
// ─────────────────────────────────────────────────────────────────────────────

export type RegAuthority =
  | "TCPA"
  | "CAN_SPAM"
  | "FTC"
  | "FAIR_HOUSING"
  | "HUD"
  | "NAR"
  | "STATE_RE_COMMISSION"

export interface ComplianceSurface {
  /** Stable id (used as part of the escalation + observation payload). */
  id: string
  /** Human label for the brief. */
  label: string
  /** The regulators whose changes can touch this surface. */
  authorities: RegAuthority[]
  /** The encoded rule/gate file a reviewer updates when this surface is flagged. */
  file: string
  /** Deterministic match terms (lower-cased substring match against change text). */
  keywords: string[]
}

export const COMPLIANCE_SURFACES: ComplianceSurface[] = [
  {
    id: "tcpa-gate",
    label: "TCPA consent gate (SMS/phone outreach)",
    authorities: ["TCPA"],
    file: "lib/kernel/compliance.ts (Gate 2 — TCPA consent) + lib/kernel/voice-dial-batch consent re-check",
    keywords: [
      "tcpa", "telephone consumer protection", "quiet hours", "quiet-hours",
      "prior express written consent", "auto-dial", "autodialer", "atds",
      "do not call", "do-not-call", "dnc", "robocall", "one-to-one consent",
      "revocation of consent", "consent revocation",
    ],
  },
  {
    id: "can-spam-gate",
    label: "CAN-SPAM email gate (email opt-out / unsubscribe)",
    authorities: ["CAN_SPAM", "FTC"],
    file: "lib/kernel/compliance.ts (Gate 2 — email_opt_out) + lib/ai-isa/lead-nurture (email_verified && !email_opt_out)",
    keywords: [
      "can-spam", "can spam", "unsubscribe", "opt-out link", "opt out link",
      "commercial email", "header information", "physical postal address",
    ],
  },
  {
    id: "fair-housing-patterns",
    label: "Fair Housing content patterns (federal)",
    authorities: ["FAIR_HOUSING", "HUD"],
    file: "lib/compliance-rules/fair-housing-patterns.ts (FAIR_HOUSING_PATTERNS) + lib/kernel/compliance.ts Gate 4",
    keywords: [
      "fair housing", "fair-housing", "protected class", "protected classes",
      "discriminatory advertising", "3604", "steering", "familial status",
      "disability", "hud", "housing for older persons", "redlining",
      "source of income", "discriminat",
    ],
  },
  {
    id: "state-protected-classes",
    label: "State-added protected classes (state_protected_classes reference data)",
    authorities: ["STATE_RE_COMMISSION", "FAIR_HOUSING"],
    file: "state_protected_classes table + lib/compliance-rules/state-fair-housing.ts",
    keywords: [
      "state protected class", "state-protected class", "adds protected class",
      "new protected class", "source of income", "arrest record", "marital status",
      "state fair housing", "state human rights", "section 8", "housing voucher",
    ],
  },
  {
    id: "bba-authority-gate",
    label: "Buyer-broker agreement / representation authority gate",
    authorities: ["NAR", "STATE_RE_COMMISSION"],
    file: "lib/kernel/compliance.ts (Gate 3 — authority) + lib/kernel/compliance/active-representation.ts (buyer_broker_agreements)",
    keywords: [
      "buyer agreement", "buyer-broker agreement", "buyer broker agreement",
      "written buyer agreement", "buyer representation agreement", "bba",
      "nar settlement", "nar rule", "touring agreement", "compensation disclosure",
      "offers of compensation", "cooperative compensation", "commission disclosure",
    ],
  },
  {
    id: "marketing-claims-gate",
    label: "FTC marketing-claims / them-first content gate",
    authorities: ["FTC"],
    file: "lib/kernel/compliance.ts (Gate 5 — them-first prohibited phrases) + lib/them-first/validator.ts",
    keywords: [
      "deceptive advertising", "endorsement guides", "endorsement guide",
      "testimonial", "substantiation", "false urgency", "deceptive claim",
      "made-up reviews", "fake reviews", "ai-generated endorsement",
      "negative option", "click to cancel", "click-to-cancel",
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// PURE — the change model
// ─────────────────────────────────────────────────────────────────────────────

/** A described regulatory change. ALWAYS sourced from a real search hit — the
 *  `source`/`url` carry the provenance so a flagged change is auditable to its
 *  origin and never fabricated. */
export interface RegulatoryChange {
  /** Headline / title of the change (from the search hit). */
  title: string
  /** The body text scanned for surface keywords + an effective date (snippet/answer). */
  summary: string
  /** The originating source label (provider/domain) — provenance, never invented. */
  source: string
  /** The source URL when present — provenance. */
  url: string | null
}

/** A stable signature for a change — the idempotency key component so the same
 *  change in the same period is recorded/escalated ONCE. Derived only from the
 *  real title + url, normalized; never random. */
export function changeSignature(change: Pick<RegulatoryChange, "title" | "url">): string {
  const basis = norm(`${change.title}|${change.url ?? ""}`)
  // Short, deterministic, collision-resistant-enough fingerprint (FNV-1a 32-bit hex).
  let h = 0x811c9dc5
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return ("0000000" + h.toString(16)).slice(-8)
}

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — matchAffectedSurfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface SurfaceMatch {
  surface: ComplianceSurface
  /** The keyword(s) in the change text that matched this surface (evidence). */
  matchedKeywords: string[]
}

/**
 * PURE + total: which OS compliance surfaces does a described reg change touch?
 *
 * Deterministic substring match of each surface's keywords against the change's
 * (title + summary). A surface is affected when ≥1 of its keywords appears. An
 * unrelated change matches NOTHING (empty array) — never a false positive, never a
 * fabricated surface. No network, no DB.
 *
 * Examples (asserted in the simulator):
 *   · a TCPA quiet-hours change          → [tcpa-gate]
 *   · a state adding a protected class    → [fair-housing-patterns?, state-protected-classes]
 *   · an NAR buyer-agreement rule         → [bba-authority-gate]
 *   · a software pricing press release    → []  (no compliance surface)
 */
export function matchAffectedSurfaces(
  change: Pick<RegulatoryChange, "title" | "summary">,
  surfaceCatalog: ComplianceSurface[] = COMPLIANCE_SURFACES,
): SurfaceMatch[] {
  const hay = norm(`${change.title} ${change.summary}`)
  if (!hay) return []
  const matches: SurfaceMatch[] = []
  for (const surface of surfaceCatalog) {
    const hit: string[] = []
    for (const kw of surface.keywords) {
      const needle = norm(kw)
      if (needle.length >= 3 && hay.includes(needle)) hit.push(kw)
    }
    if (hit.length > 0) matches.push({ surface, matchedKeywords: hit })
  }
  return matches
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — classifyChangeSeverity
// ─────────────────────────────────────────────────────────────────────────────

export type SeverityTier = "binding" | "advisory" | "informational"

export interface ChangeSeverity {
  /** binding   — a final rule / settlement / statute / effective-dated mandate.
   *  advisory   — guidance / FAQ / proposed rule / staff bulletin.
   *  informational — a change is referenced but no binding/advisory signal found. */
  tier: SeverityTier
  /** An effective date PARSED literally from the change text — null when none is
   *  present. NEVER invented. ISO yyyy-mm-dd when a full date is found. */
  effectiveDate: string | null
  /** The phrase that drove the tier (evidence / auditability). */
  reason: string
}

const BINDING_SIGNALS = [
  "final rule", "effective date", "effective ", "takes effect", "goes into effect",
  "settlement", "court order", "enacted", "signed into law", "mandate", "compliance deadline",
  "must comply", "is required to", "amended rule", "adopted rule",
]
const ADVISORY_SIGNALS = [
  "guidance", "proposed rule", "notice of proposed", "nprm", "faq", "advisory",
  "staff bulletin", "consultation", "request for comment", "draft", "white paper",
]

/**
 * PURE + total: classify a change's binding force + extract a literal effective date.
 *
 * Tier is binding when a binding signal is present (a final/effective-dated mandate),
 * advisory when only advisory signals appear, else informational. The effective date
 * is parsed ONLY from explicit dates in the text — "effective January 1, 2025" →
 * "2025-01-01"; no date in the text → null (we NEVER fabricate one). No network.
 */
export function classifyChangeSeverity(change: Pick<RegulatoryChange, "title" | "summary">): ChangeSeverity {
  const hay = norm(`${change.title} ${change.summary}`)
  const effectiveDate = extractEffectiveDate(hay)

  const binding = BINDING_SIGNALS.find((s) => hay.includes(s))
  if (binding || effectiveDate) {
    return {
      tier: "binding",
      effectiveDate,
      reason: binding ? `binding signal: "${binding.trim()}"` : "explicit effective date present",
    }
  }
  const advisory = ADVISORY_SIGNALS.find((s) => hay.includes(s))
  if (advisory) {
    return { tier: "advisory", effectiveDate, reason: `advisory signal: "${advisory.trim()}"` }
  }
  return { tier: "informational", effectiveDate, reason: "no binding/advisory signal found" }
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04", jun: "06", jul: "07", aug: "08",
  sep: "09", sept: "09", oct: "10", nov: "11", dec: "12",
}

/** PURE: extract a literal effective date from text → ISO yyyy-mm-dd, or null.
 *  Only matches dates ACTUALLY PRESENT in the text — never invents one. */
export function extractEffectiveDate(text: string): string | null {
  const hay = norm(text)
  // "January 1, 2025" / "Jan 1 2025"
  const m1 = hay.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/,
  )
  if (m1) {
    const mm = MONTHS[m1[1]]
    if (mm) return `${m1[3]}-${mm}-${m1[2].padStart(2, "0")}`
  }
  // ISO "2025-01-01"
  const m2 = hay.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`
  // "1/1/2025" or "01/01/2025"
  const m3 = hay.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/)
  if (m3) return `${m3[3]}-${m3[1].padStart(2, "0")}-${m3[2].padStart(2, "0")}`
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// The external-search seam (gated, honest-degrade)
// ─────────────────────────────────────────────────────────────────────────────

/** What the runner asks the search rail for. `provider:"none"` ⇒ search unavailable. */
export interface RegSearchResult {
  answer: string | null
  hits: Array<{ title: string | null; url: string | null; snippet: string | null }>
  provider: string
}

/** Injectable seam: run ONE reg-scan query and return the answer/hits. Real default =
 *  lib/ai/web-search ("research" mode). The simulator injects fixed results so there
 *  is no egress / spend in tests. */
export type RegSearchFetcher = (params: { query: string; brokerageId: string }) => Promise<RegSearchResult>

/**
 * REAL search fetcher — the app-wide web-search rail in "research" mode (Tavily
 * synthesized answer first, Exa fallback). Honest-degrade: web-search NEVER throws
 * and returns provider "none" with no hits when no creds are configured → the runner
 * records "search unavailable" and escalates nothing. No key is read or logged here.
 */
export const realRegSearchFetcher: RegSearchFetcher = async (params) => {
  const { webSearch } = await import("@/lib/ai/web-search")
  const res = await webSearch({ query: params.query, maxResults: 8, mode: "research", deep: true }).catch(
    () => ({ answer: null, hits: [], provider: "none" as const, cost: 0 }),
  )
  return { answer: res.answer, hits: res.hits, provider: res.provider }
}

/** The default scan queries — named regulators × "recent change" so a real change
 *  surfaces. Kept here (not env) so the scan is reproducible + auditable. */
export const DEFAULT_SCAN_QUERIES: string[] = [
  "recent TCPA rule change real estate SMS calling consent effective date",
  "new state fair housing protected class real estate added effective date",
  "NAR buyer agreement rule change real estate commission settlement effective date",
  "FTC real estate marketing advertising enforcement rule change effective date",
  "HUD fair housing advertising guidance update real estate",
]

/**
 * PURE + total: turn a search result into REAL described changes. Each hit (and the
 * synthesized answer, when present) becomes ONE RegulatoryChange carrying its own
 * provenance (source + url). NOTHING is fabricated — an empty result yields []. The
 * caller then matches each change to surfaces; only changes that match ≥1 surface are
 * escalated. No network.
 */
export function parseChangesFromSearchResult(
  result: RegSearchResult,
  queryLabel: string,
): RegulatoryChange[] {
  if (result.provider === "none") return []
  const changes: RegulatoryChange[] = []
  for (const h of result.hits ?? []) {
    const title = (h.title ?? "").trim()
    const snippet = (h.snippet ?? "").trim()
    if (!title && !snippet) continue
    changes.push({
      title: title || queryLabel,
      summary: snippet || title,
      source: hostOf(h.url) ?? result.provider,
      url: h.url ?? null,
    })
  }
  return changes
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try { return new URL(url).host.replace(/^www\./, "") } catch { return null }
}

// ─────────────────────────────────────────────────────────────────────────────
// The runner
// ─────────────────────────────────────────────────────────────────────────────

export interface RegulatoryWatcherOptions {
  now?: Date
  /** Injectable external-search seam — real web-search default. */
  searchFetcher?: RegSearchFetcher
  /** Override the scan queries (the simulator passes a single labelled query). */
  queries?: string[]
  /** Cap of distinct flagged changes to escalate per pass. */
  maxChanges?: number
}

export interface FlaggedChange {
  signature: string
  title: string
  source: string
  url: string | null
  severity: ChangeSeverity
  surfaces: Array<{ id: string; label: string; file: string; matchedKeywords: string[] }>
  /** "new" — first time recorded this period; "duplicate" — already recorded (idempotent). */
  state: "new" | "duplicate"
  /** Whether this pass escalated a brief for the change (new + matched). */
  escalated: boolean
}

export interface RegulatoryWatcherResult {
  /** True when the search rail answered for at least one query. */
  searchRan: boolean
  provider: string
  changesScanned: number
  /** Changes that matched ≥1 OS compliance surface. */
  flagged: FlaggedChange[]
  escalated: number
  /** Honest human-readable status when nothing actionable happened. */
  status: string
}

/** The compliance/broker recipients for the escalation (real users only). */
async function loadComplianceRecipients(supabase: Svc, brokerageId: string): Promise<string[]> {
  const { data } = await supabase.from("users").select("id")
    .eq("brokerage_id", brokerageId)
    .in("user_type", ["broker", "admin", "compliance_officer"])
    .limit(10)
  return ((data ?? []) as Array<{ id: string }>).map((u) => u.id)
}

/**
 * Run one regulatory-watcher pass for a brokerage.
 *
 * SCAN the gated external-search rail for recent real-estate reg changes → PARSE each
 * real hit into a described change (with provenance) → MATCH affected OS surfaces →
 * classify severity → for each NEW (idempotent per signature × period) change that
 * touches ≥1 surface, RECORD an observation (m224) and ESCALATE a GATED brief to the
 * brokerage's compliance/broker owner (manager-signals bus data_steward →
 * campaign_orchestrator + a notification). A change that touches no surface is recorded
 * but not escalated. When the rail is unavailable NOTHING is fabricated or escalated.
 *
 * Always tenant-scoped by brokerage_id. Idempotent per (change-signature, period) via
 * the m224 unique index UPSERT — a rerun in the same period re-flags as "duplicate" and
 * escalates nothing new. Returns a read-only summary.
 */
export async function runRegulatoryWatcher(
  brokerageId: string,
  opts: RegulatoryWatcherOptions = {},
  deps: { searchFetcher?: RegSearchFetcher } = {},
  client?: Svc,
): Promise<RegulatoryWatcherResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const fetcher = deps.searchFetcher ?? opts.searchFetcher ?? realRegSearchFetcher
  const queries = opts.queries ?? DEFAULT_SCAN_QUERIES
  const maxChanges = opts.maxChanges ?? 20
  // Idempotency PERIOD: ISO week (yyyy-Www) — weekly cadence; the same change in the
  // same week is recorded/escalated once, but a recurrence next week re-surfaces.
  const period = isoWeek(now)

  const result: RegulatoryWatcherResult = {
    searchRan: false, provider: "none", changesScanned: 0, flagged: [], escalated: 0,
    status: "",
  }

  // De-dupe identical changes within a single pass (same signature across queries).
  const seenThisPass = new Set<string>()
  const candidateChanges: RegulatoryChange[] = []

  for (const query of queries) {
    const res = await fetcher({ query, brokerageId }).catch(
      () => ({ answer: null, hits: [], provider: "none" as const }),
    )
    if (res.provider !== "none") {
      result.searchRan = true
      if (result.provider === "none") result.provider = res.provider
    }
    for (const ch of parseChangesFromSearchResult(res, query)) {
      const sig = changeSignature(ch)
      if (seenThisPass.has(sig)) continue
      seenThisPass.add(sig)
      candidateChanges.push(ch)
    }
  }

  if (!result.searchRan) {
    result.status = "search unavailable — no changes detected (nothing fabricated, nothing escalated)"
    return result
  }

  result.changesScanned = candidateChanges.length

  const recipientsPromise = loadComplianceRecipients(supabase, brokerageId)
  let recipients: string[] | null = null

  for (const ch of candidateChanges) {
    if (result.flagged.length >= maxChanges) break
    const matches = matchAffectedSurfaces(ch)
    if (matches.length === 0) continue // unrelated to any OS surface — not flagged

    const sig = changeSignature(ch)
    const severity = classifyChangeSeverity(ch)
    const surfaces = matches.map((m) => ({
      id: m.surface.id, label: m.surface.label, file: m.surface.file, matchedKeywords: m.matchedKeywords,
    }))

    // RECORD — idempotent per (brokerage, signature, period). UPSERT: a rerun in the
    // same period overwrites the row (latest observation wins), never appends.
    const { data: upserted, error } = await supabase
      .from("reg_change_observations")
      .upsert({
        brokerage_id: brokerageId,
        change_signature: sig,
        period,
        title: ch.title.slice(0, 500),
        source: ch.source.slice(0, 300),
        url: ch.url,
        severity_tier: severity.tier,
        effective_date: severity.effectiveDate, // null when not literally present
        affected_surfaces: surfaces.map((s) => s.id),
        surface_detail: surfaces,
        observed_at: now.toISOString(),
      }, { onConflict: "brokerage_id,change_signature,period" })
      .select("id, escalated_at")
      .maybeSingle()
    if (error) {
      // A failed write must not fabricate a flag — skip honestly.
      console.error("[regulatory-watcher] observation upsert failed:", error.message)
      continue
    }

    const alreadyEscalated = !!(upserted as { escalated_at?: string | null } | null)?.escalated_at
    const flagged: FlaggedChange = {
      signature: sig, title: ch.title, source: ch.source, url: ch.url,
      severity, surfaces, state: alreadyEscalated ? "duplicate" : "new", escalated: false,
    }

    // ESCALATE only the FIRST time we see this change in this period.
    if (!alreadyEscalated) {
      if (recipients === null) recipients = await recipientsPromise
      const escalated = await escalateBrief(supabase, brokerageId, ch, severity, surfaces, recipients)
      if (escalated) {
        flagged.escalated = true
        result.escalated += 1
        await supabase.from("reg_change_observations")
          .update({ escalated_at: now.toISOString() })
          .eq("brokerage_id", brokerageId).eq("change_signature", sig).eq("period", period)

        // REGULATORY → CURRICULUM AUTOPILOT — don't just warn, TRAIN: author a gated training module on
        // the change (idempotent per signature) so the learning-router pushes it to agents + brokers.
        // Best-effort; the model may be unavailable — never blocks the watcher.
        try {
          const { authorRegulatoryTraining } = await import("@/lib/education/regulatory-curriculum")
          await authorRegulatoryTraining(supabase, {
            brokerageId,
            change: {
              signature: sig, title: ch.title, source: ch.source, url: ch.url,
              severityTier: severity.tier, effectiveDate: severity.effectiveDate,
              surfaceLabels: surfaces.map((s) => s.label),
            },
          })
        } catch { /* best-effort */ }
      }
    }

    result.flagged.push(flagged)
  }

  if (result.flagged.length === 0) {
    result.status = result.changesScanned > 0
      ? "scanned recent changes — none affect an OS compliance surface (no escalation)"
      : "no recent regulatory changes detected"
  } else {
    result.status = `${result.flagged.length} change(s) affect OS surfaces; ${result.escalated} new brief(s) escalated`
  }
  return result
}

/** Escalate ONE gated compliance brief: a manager-signals bus line (data_steward →
 *  campaign_orchestrator) + a notification to each compliance/broker recipient. Returns
 *  true when at least the bus line was published (the durable audit). */
async function escalateBrief(
  supabase: Svc,
  brokerageId: string,
  change: RegulatoryChange,
  severity: ChangeSeverity,
  surfaces: Array<{ id: string; label: string; file: string }>,
  recipients: string[],
): Promise<boolean> {
  const surfaceLabels = surfaces.map((s) => s.label).join("; ")
  const effective = severity.effectiveDate ? ` effective ${severity.effectiveDate}` : ""
  const message =
    `Regulatory change (${severity.tier})${effective} affects your: ${surfaceLabels}. ` +
    `Source: ${change.title} (${change.source}${change.url ? ` — ${change.url}` : ""}). Review the encoded gate(s).`

  // Bus audit line (idempotent per open (to_manager, signal_type, entity_id) via the
  // publishManagerSignal dedupe — entityId = the change signature so a repeat is deduped).
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const sig = changeSignature(change)
  const bus = await publishManagerSignal({
    brokerageId,
    fromManager: "data_steward",
    toManager: "campaign_orchestrator",
    signalType: "regulatory_change_detected",
    message,
    entityType: "reg_change",
    entityId: null, // entity_id is a uuid column — the change signature is not a uuid; carried in payload
    payload: {
      change_signature: sig, severity_tier: severity.tier, effective_date: severity.effectiveDate,
      affected_surfaces: surfaces.map((s) => s.id), source: change.source, url: change.url,
      title: change.title,
    },
    dedupe: false,
  }, supabase)

  // Surface it to the human compliance/broker owners (the people who own the gates).
  for (const userId of recipients) {
    const { error: notifyErr } = await supabase.from("notifications").insert({
      user_id: userId, brokerage_id: brokerageId, type: "regulatory_change",
      title: `Compliance review: a ${severity.tier} regulatory change${effective}`,
      body: message,
      entity_type: "reg_change", entity_id: null,
      priority: severity.tier === "binding" ? "high" : "medium", is_read: false,
    })
    if (notifyErr) console.error("[regulatory-watcher] notify failed:", notifyErr.message)
  }

  return bus.ok
}

/** PURE: ISO week label yyyy-Www (the idempotency period). */
export function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (date.getUTCDay() + 6) % 7 // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3) // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    )
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}
