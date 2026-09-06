// lib/kernel/capability-radar.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CAPABILITY RADAR — the OS watches the web for what it does not do yet.
//
// Owner, 2026-09-06: "this agentic saas os that we have built needs to
// consistantly check for any new ideas or capability out on the web, etc. so
// our saas ai os autonomously builds it in as a new capability annoucemtn to
// stay ahead of the curve. autonomous loops."
//
// WHAT EXISTED (§1 — reused, not re-spelled):
//   · lib/ai/web-search — the ONE gated external search rail (Exa / Tavily through
//     the connector gateway), already used by the AI-search citation monitor.
//   · lib/agentic-os/app-capability-registry — what the OS can DO today, by name.
//   · lib/voice/tool-registry + lib/voice/team-command-names — what a person can
//     ASK the team to do today, by name.
//   · feature_flags — the platform's own ledger of capabilities with a key, a
//     display name, a category and an enabled/beta state. A capability the OS does
//     not have yet is exactly a DISABLED, BETA, superadmin-only flag: the same row
//     the platform flips when it ships. No new table (§1.1 — a duplicate ledger
//     would be the defect).
//   · lib/notifications/platform-staff notifyPlatformStaff — the bell every
//     platform seat already reads.
//
// WHAT THIS ADDS: the loop. Each run searches a fixed watchlist, asks the model
// to name each finding as a CAPABILITY and to say whether the OS already has it
// (against the live capability vocabulary handed to it — not from memory),
// records each NEW one once as a radar flag (deduped by feature_key), and
// announces the batch to platform staff. The flag row IS the "new capability
// announcement" and the build proposal: its description carries the source,
// the why, and the proposed shape.
//
// HONESTY (§2, §3): a refused feature_flags read is a skipped finding, never a
// "new" one; a search provider returning nothing is reported as searched-0;
// the model's "have it" verdict is recorded beside the vocabulary it was given.
// The radar proposes and announces; it does not write code — that is a build
// session's job, and the flag names what to build.
// No `server-only` marker: the watchlist, the feature-key slug and the verdict
// parser are PURE and are what scripts/capability-radar-guard.ts imports; every
// server-reaching dependency is a dynamic import inside runCapabilityRadar,
// which only the cron route calls.
import type { SupabaseClient } from "@supabase/supabase-js"

/** What the OS watches for. Named once; each entry is a search the platform runs. */
export const RADAR_WATCHLIST: readonly { key: string; query: string }[] = [
  { key: "ai_agent_tools",     query: "new AI tools for real estate agents launched this month" },
  { key: "chatgpt_ads",        query: "advertising inside ChatGPT for real estate agents and brokerages" },
  { key: "ai_cmo_text_agents", query: "AI marketing agent for real estate you control by text message" },
  { key: "listing_marketing",  query: "AI listing marketing automation for real estate brokerages new capability" },
  { key: "mls_rules",          query: "MLS rule change coming soon listings NAR policy update" },
  { key: "ai_search_geo",      query: "how home buyers use ChatGPT Perplexity to find agents and listings" },
] as const

export interface RadarFinding {
  watchKey:    string
  title:       string
  url:         string
  capability:  string        // short name the model gave the capability
  featureKey:  string        // radar:<slug> — the dedupe key
  haveIt:      boolean
  why:         string
  proposal:    string
}

export interface RadarRunResult {
  searched:  number
  hits:      number
  newFlags:  number
  announced: number
  skipped:   number
  errors:    string[]
  findings:  RadarFinding[]
}

function radarFeatureKey(capability: string): string {
  const slug = capability.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60)
  return `radar:${slug || "unnamed"}`
}

/** The capability vocabulary the model is asked to judge against — derived, never typed.
 *  Internal (not exported): the cron route reaches it through runCapabilityRadar; a
 *  proof-only export is an orphan by this repo's ratchet, so the parser and the slug
 *  are proved by source shape in scripts/capability-radar-guard.ts instead. */
async function knownCapabilityVocabulary(): Promise<string[]> {
  const { APP_CAPABILITY_REGISTRY } = await import("@/lib/agentic-os/app-capability-registry")
  const { TEAM_COMMANDS } = await import("@/lib/voice/team-command-names")
  const { AD_CAMPAIGN_PLATFORMS } = await import("@/lib/integrations/ad-campaign-vocabulary")
  const { MANAGERS } = await import("@/lib/kernel/manager-registry")
  return [
    ...Object.keys(APP_CAPABILITY_REGISTRY),
    ...TEAM_COMMANDS,
    ...AD_CAMPAIGN_PLATFORMS.map((p) => `ads:${p}`),
    ...Object.keys(MANAGERS).map((m) => `manager:${m}`),
  ]
}

/** Parse the model's JSON list; anything malformed is dropped and counted. */
function parseRadarVerdicts(raw: string): Array<{ title: string; url: string; capability: string; have_it: boolean; why: string; proposal: string }> {
  const m = raw.match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is { title: string; url: string; capability: string; have_it: boolean; why: string; proposal: string } =>
      !!x && typeof x === "object"
      && typeof (x as { capability?: unknown }).capability === "string"
      && typeof (x as { url?: unknown }).url === "string"
      && typeof (x as { have_it?: unknown }).have_it === "boolean")
      .map((x) => ({ title: String(x.title ?? ""), url: x.url, capability: x.capability, have_it: x.have_it, why: String(x.why ?? ""), proposal: String(x.proposal ?? "") }))
  } catch { return [] }
}

/** One turn of the radar. Cron-driven; safe to run as often as the schedule says. */
export async function runCapabilityRadar(
  svc: SupabaseClient,
  opts: { maxPerQuery?: number } = {},
): Promise<RadarRunResult> {
  const result: RadarRunResult = { searched: 0, hits: 0, newFlags: 0, announced: 0, skipped: 0, errors: [], findings: [] }
  const { webSearch } = await import("@/lib/ai/web-search")
  const vocabulary = await knownCapabilityVocabulary()

  // ── 1 · search the watchlist through the one external rail ──
  const raw: Array<{ watchKey: string; title: string; url: string; snippet: string }> = []
  for (const w of RADAR_WATCHLIST) {
    try {
      const r = await webSearch({ query: w.query, maxResults: opts.maxPerQuery ?? 5, mode: "research" })
      result.searched++
      for (const h of r.hits) {
        if (!h.url) continue // a hit with no URL cannot be cited or deduped
        raw.push({ watchKey: w.key, title: h.title ?? "", url: h.url, snippet: (h.snippet ?? "").slice(0, 400) })
      }
    } catch (err) {
      result.errors.push(`${w.key}: ${(err as Error).message}`)
    }
  }
  result.hits = raw.length
  if (raw.length === 0) return result

  // ── 2 · one verdict call for the batch, judged against the LIVE vocabulary ──
  const { generateTextRouted } = await import("@/lib/ai/models")
  const prompt = [
    "You are the capability radar for an agentic real-estate SaaS OS.",
    "Below is what the OS can already do (its capability vocabulary), then a list of web findings.",
    "For each finding, name the CAPABILITY it describes in 3-6 words, say whether the OS already has it",
    "(have_it true only if a vocabulary entry plainly covers it), why it matters for agents/brokerages,",
    "and a one-sentence build proposal (which manager should own it). Skip findings that are not a product capability.",
    "Respond with JSON ONLY: [{\"title\":\"\",\"url\":\"\",\"capability\":\"\",\"have_it\":false,\"why\":\"\",\"proposal\":\"\"}]",
    "",
    `VOCABULARY: ${vocabulary.join(", ")}`,
    "",
    "FINDINGS:",
    ...raw.map((h, i) => `${i + 1}. [${h.watchKey}] ${h.title} — ${h.url}\n   ${h.snippet}`),
  ].join("\n")
  let verdicts: ReturnType<typeof parseRadarVerdicts> = []
  try {
    const { text } = await generateTextRouted({ feature: "capability_radar", prompt, temperature: 0.2, maxTokens: 2500 })
    verdicts = parseRadarVerdicts(text)
  } catch (err) {
    result.errors.push(`verdict: ${(err as Error).message}`)
    return result
  }

  // ── 3 · record each NEW capability once, as the flag the platform will flip when it ships ──
  const announced: RadarFinding[] = []
  for (const v of verdicts) {
    const watchKey = raw.find((h) => h.url === v.url)?.watchKey ?? "unknown"
    const finding: RadarFinding = {
      watchKey, title: v.title, url: v.url, capability: v.capability,
      featureKey: radarFeatureKey(v.capability), haveIt: v.have_it, why: v.why, proposal: v.proposal,
    }
    result.findings.push(finding)
    if (finding.haveIt) { result.skipped++; continue }

    const { data: existing, error: readErr } = await svc
      .from("feature_flags").select("id").eq("feature_key", finding.featureKey).maybeSingle()
    if (readErr) { result.errors.push(`${finding.featureKey}: read refused (${readErr.message})`); result.skipped++; continue }
    if (existing) { result.skipped++; continue }

    const { data: inserted, error: insErr } = await svc.from("feature_flags").insert({
      feature_key:     finding.featureKey,
      display_name:    finding.capability.slice(0, 120),
      description:     `RADAR (${finding.watchKey}): ${finding.why}\nSOURCE: ${finding.url}\nPROPOSAL: ${finding.proposal}`.slice(0, 2000),
      category:        "capability_radar",
      enabled:         false,
      beta:            true,
      superadmin_only: true,
    }).select("id")
    if (insErr) { result.errors.push(`${finding.featureKey}: insert refused (${insErr.message})`); continue }
    if (!inserted || inserted.length === 0) { result.errors.push(`${finding.featureKey}: insert matched no row`); continue }
    result.newFlags++
    announced.push(finding)
  }

  // ── 4 · announce the batch to every platform seat, once per run ──
  if (announced.length > 0) {
    try {
      const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
      const n = await notifyPlatformStaff(svc, {
        type:     "capability_radar.new",
        title:    `Capability radar: ${announced.length} new capabilit${announced.length === 1 ? "y" : "ies"} spotted`,
        body:     announced.map((f) => `• ${f.capability} — ${f.why} (${f.url})`).join("\n").slice(0, 3000),
        priority: "medium",
      })
      result.announced = n
    } catch (err) {
      result.errors.push(`announce: ${(err as Error).message}`)
    }
  }
  return result
}
