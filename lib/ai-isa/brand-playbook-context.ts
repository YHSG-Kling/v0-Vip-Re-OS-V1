/**
 * lib/ai-isa/brand-playbook-context.ts
 *
 * Lane 75B — owner verbatim (wave 75 rulings): "there should not only be a
 * playbook but the brand settings like brand voice, any other business
 * process, brand knowledge base, etc. needs to be included."
 *
 * Before this file, `buildQualificationPrompt` (lib/ai-isa/qualification-
 * playbook.ts) carried the SIX qualification goals + the follow-up menu +
 * the conversational rules, but nothing about the brand doing the talking —
 * no brand voice, no brand knowledge base, no business-process/SOP facts, no
 * office hours, no service areas. This file is the ONE loader every mounting
 * surface calls to fill that gap — never a second per-surface assembly.
 * Every field is read from an EXISTING survivor, never a new implementation:
 *
 *   - brand voice (tone/formality/prohibited+preferred words/tagline/mission/
 *     FAQ/objections): lib/ai-isa/brand-voice-prompt.ts::loadBrandVoicePrompt
 *     — the SAME brokerage→team→agent merge cascade inbound email / video /
 *     call context already mount.
 *   - brand knowledge base: lib/intelligence/kb-search.ts::searchKB, scoped
 *     to the brokerage — the SAME reader the brand-voice cascade's own RAG
 *     block and the onboarding assistant already use. Tenant-free
 *     (brokerageId=null) for the PLATFORM surface, the SAME degrade
 *     lib/voice/platform-reception.ts's platform_faq_lookup already relies on.
 *   - business processes / SOPs: brokerage_settings.settings.business_processes
 *     — the EXISTING generic settings jsonb column (lib/kernel/self-book.ts's
 *     `settings.self_booking.enabled` is the precedent for a namespaced key
 *     under it). No new column, no migration.
 *   - office hours: ai_identity_profiles.business_hours at brokerage scope —
 *     the SAME column lib/voice/twilio-voice.ts already reads for the inbound
 *     voice brain's after-hours rule.
 *   - service areas / territories: subscriber_service_areas (active rows) —
 *     the platform-subscriber territory table (never lead_scraping_markets,
 *     which is acquisition-side only, not a "where do we serve" fact for a
 *     live conversation).
 *
 * PLATFORM surface (brokerageId: null): only the platform's own brand
 * (lib/platform/product-brand.ts::loadProductBrand) + tenant-free KB. The
 * four tenant-only fields (brand-voice cascade, business processes, office
 * hours, service areas) do not exist for a platform prospect line and are
 * left empty rather than invented.
 *
 * CACHED PER BROKERAGE PER REQUEST — a short in-process TTL cache (same
 * posture as lib/ai-isa/persona-tool-policy.ts's `tierCache`) so a single
 * conversation turn that builds more than one prompt block in the same
 * request does not repeat five reads for the same brokerage.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { loadBrandVoicePrompt, type BrandVoicePromptResult } from "@/lib/ai-isa/brand-voice-prompt"
import { searchKB, type KBResult } from "@/lib/intelligence/kb-search"
import type { BusinessHours } from "@/lib/voice/inbound-number-binding"

export interface BrandPlaybookBusinessProcess {
  title: string
  text: string
}

export interface BrandPlaybookServiceArea {
  city: string | null
  state: string | null
  zipCode: string | null
  isPrimary: boolean
}

export interface BrandPlaybookContext {
  brokerageId: string | null
  /** null for the platform surface (no brand-voice cascade exists there). */
  voice: BrandVoicePromptResult | null
  kb: KBResult[]
  businessProcesses: BrandPlaybookBusinessProcess[]
  officeHours: BusinessHours | null
  serviceAreas: BrandPlaybookServiceArea[]
  /** The assembled prompt text — the ONE shape every mounting surface injects. */
  block: string
}

export interface LoadBrandPlaybookContextInput {
  /** null = the PLATFORM's own reception line (lib/voice/platform-reception.ts). */
  brokerageId: string | null
  agentId?: string | null
  teamId?: string | null
  managerKey?: string
  /** The inbound message / call objective — steers the KB search. Omit for a
   *  query-agnostic build (no KB cost, no behavior change). */
  knowledgeQuery?: string | null
  contactId?: string | null
  /**
   * A caller that already resolved lib/ai-isa/brand-voice-prompt.ts's cascade
   * for this same scope (e.g. a route that renders tone/FAQ/objections into
   * its OWN prompt already) passes it here so this loader does not run the
   * SAME query twice and `block` does not restate the SAME brand-voice text
   * a second time (see `omitVoiceBlock`).
   */
  preloadedVoice?: BrandVoicePromptResult | null
  /**
   * True when the caller already renders the brand-voice fields (tone,
   * prohibited/preferred words, FAQ, objections) into its own prompt and only
   * wants this loader's NEW fields (KB, business processes, office hours,
   * service areas) in `block` — never the SAME sentence twice in one prompt.
   */
  omitVoiceBlock?: boolean
}

/** PURE — settings.business_processes → the typed list, tolerant of a
 *  missing or malformed key (never throws on a tenant that never set one). */
function parseBusinessProcesses(settings: Record<string, unknown> | null | undefined): BrandPlaybookBusinessProcess[] {
  const raw = (settings as Record<string, unknown> | null | undefined)?.business_processes
  if (!Array.isArray(raw)) return []
  const out: BrandPlaybookBusinessProcess[] = []
  for (const r of raw) {
    const title = typeof (r as Record<string, unknown>)?.title === "string" ? ((r as Record<string, unknown>).title as string).trim() : ""
    const text = typeof (r as Record<string, unknown>)?.text === "string" ? ((r as Record<string, unknown>).text as string).trim() : ""
    if (title && text) out.push({ title: title.slice(0, 120), text: text.slice(0, 1000) })
  }
  return out.slice(0, 20)
}

interface StaticContext {
  voice: BrandVoicePromptResult | null
  businessProcesses: BrandPlaybookBusinessProcess[]
  officeHours: BusinessHours | null
  serviceAreas: BrandPlaybookServiceArea[]
  platformBrand: { name: string; tagline: string; voicePitch: string } | null
}

const STATIC_CACHE = new Map<string, { at: number; ctx: StaticContext }>()
const STATIC_CACHE_TTL_MS = 60_000 // 60s — same short-lived posture as persona-tool-policy.ts's tierCache

async function loadStaticContext(input: LoadBrandPlaybookContextInput): Promise<StaticContext> {
  // A preloaded voice cascade is caller-specific (already resolved for THIS
  // request) — never cached under the shared key, and never re-fetched.
  if (input.preloadedVoice !== undefined && input.brokerageId) {
    return loadNonVoiceContext(input, input.preloadedVoice)
  }

  const cacheKey = `${input.brokerageId ?? "platform"}:${input.agentId ?? ""}:${input.teamId ?? ""}:${input.managerKey ?? "ai_isa"}`
  const cached = STATIC_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.at < STATIC_CACHE_TTL_MS) return cached.ctx

  const svc = createServiceClient()

  if (!input.brokerageId) {
    // PLATFORM surface — no tenant brand-voice cascade, no business
    // processes, no office hours, no service areas: none of these exist for
    // the platform's own reception line.
    const { loadProductBrand } = await import("@/lib/platform/product-brand")
    const brand = await loadProductBrand(svc).catch(() => null)
    const ctx: StaticContext = {
      voice: null,
      businessProcesses: [],
      officeHours: null,
      serviceAreas: [],
      platformBrand: brand ? { name: brand.name, tagline: brand.tagline, voicePitch: brand.voicePitch } : null,
    }
    STATIC_CACHE.set(cacheKey, { at: Date.now(), ctx })
    return ctx
  }

  const brokerageId = input.brokerageId
  const [voice, rest] = await Promise.all([
    loadBrandVoicePrompt({ brokerageId, agentId: input.agentId, teamId: input.teamId, managerKey: input.managerKey }).catch(() => null),
    loadNonVoiceContext(input, undefined),
  ])
  const ctx: StaticContext = { ...rest, voice }
  STATIC_CACHE.set(cacheKey, { at: Date.now(), ctx })
  return ctx
}

/** The four fields that never come from loadBrandVoicePrompt — split out so a
 *  caller passing `preloadedVoice` (or none at all, for the platform-free
 *  branch above) never re-runs the brand-voice cascade query. */
async function loadNonVoiceContext(
  input: LoadBrandPlaybookContextInput,
  preloadedVoice: BrandVoicePromptResult | null | undefined,
): Promise<StaticContext> {
  const svc = createServiceClient()
  const brokerageId = input.brokerageId as string
  const [settingsRow, identityRow, areaRows] = await Promise.all([
    svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
      .then((r: { data: unknown }) => r.data as { settings?: Record<string, unknown> } | null, () => null),
    svc.from("ai_identity_profiles").select("business_hours").eq("scope_type", "brokerage").eq("scope_id", brokerageId).maybeSingle()
      .then((r: { data: unknown }) => r.data as { business_hours?: BusinessHours | null } | null, () => null),
    svc.from("subscriber_service_areas").select("city, state, zip_code, is_primary")
      .eq("brokerage_id", brokerageId).eq("active", true).limit(25)
      .then((r: { data: unknown }) => (r.data ?? []) as Array<{ city: string | null; state: string | null; zip_code: string | null; is_primary: boolean | null }>, () => []),
  ])
  return {
    voice: preloadedVoice ?? null,
    businessProcesses: parseBusinessProcesses(settingsRow?.settings ?? null),
    officeHours: identityRow?.business_hours ?? null,
    serviceAreas: areaRows.map((r) => ({ city: r.city ?? null, state: r.state ?? null, zipCode: r.zip_code ?? null, isPrimary: r.is_primary === true })),
    platformBrand: null,
  }
}

/** PURE — assembles the ONE prompt block from every resolved source.
 *  `omitVoiceBlock` skips the brand-voice sentence for a caller that already
 *  renders it into its own prompt (never the same sentence twice). */
function composeBlock(static_: StaticContext, kb: KBResult[], omitVoiceBlock: boolean): string {
  const parts: string[] = []

  if (!omitVoiceBlock) {
    if (static_.platformBrand) {
      parts.push(`You represent ${static_.platformBrand.name} — ${static_.platformBrand.tagline}. ${static_.platformBrand.voicePitch}`.trim())
    } else if (static_.voice) {
      parts.push(static_.voice.systemBlock)
    }
  }

  if (static_.businessProcesses.length > 0) {
    parts.push(
      `HOW THIS OFFICE WORKS — business processes to follow and reference accurately:\n${static_.businessProcesses.map((p) => `- ${p.title}: ${p.text}`).join("\n")}`,
    )
  }

  if (static_.serviceAreas.length > 0) {
    const lines = static_.serviceAreas.map((a) => [a.city, a.state, a.zipCode].filter(Boolean).join(", ")).filter(Boolean)
    if (lines.length > 0) {
      parts.push(`SERVICE AREAS — this office serves: ${lines.join("; ")}. Never claim coverage outside these areas; offer to confirm instead.`)
    }
  }

  if (static_.officeHours?.start && static_.officeHours?.end) {
    const tz = static_.officeHours.timezone ? ` (${static_.officeHours.timezone})` : ""
    parts.push(`OFFICE HOURS: ${static_.officeHours.start}–${static_.officeHours.end}${tz}. Outside these hours, say the team will follow up first thing next business day.`)
  }

  if (kb.length > 0) {
    parts.push(
      `BRAND KNOWLEDGE — use these facts first and never contradict them:\n${kb.map((k) => `### ${k.title}\n${k.content}`).join("\n\n")}`,
    )
  }

  return parts.filter(Boolean).join("\n\n")
}

/**
 * THE shared loader. Every mounting surface (buildQualificationPrompt's
 * `brand` input, and any other caller wanting the same brand+KB+SOP+hours+
 * territory picture) calls this instead of assembling its own.
 */
export async function loadBrandPlaybookContext(input: LoadBrandPlaybookContextInput): Promise<BrandPlaybookContext> {
  const static_ = await loadStaticContext(input)

  // KB is query-scoped and never cached across queries (a stale KB match is
  // worse than a fresh miss) — always a live read when a query is given.
  let kb: KBResult[] = []
  const q = (input.knowledgeQuery ?? "").trim()
  if (q.length >= 2) {
    try {
      kb = await searchKB(q.slice(0, 1000), input.brokerageId, 4)
    } catch { /* KB unavailable — the rest of the playbook context still stands */ }
  }

  return {
    brokerageId: input.brokerageId,
    voice: static_.voice,
    kb,
    businessProcesses: static_.businessProcesses,
    officeHours: static_.officeHours,
    serviceAreas: static_.serviceAreas,
    block: composeBlock(static_, kb, input.omitVoiceBlock === true),
  }
}
