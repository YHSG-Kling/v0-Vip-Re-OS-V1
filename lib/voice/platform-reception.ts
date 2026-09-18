// lib/voice/platform-reception.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM-LEVEL AI RECEPTION — the THIRD scope of the Twilio-native voice lane
// (owner: "first as a platform application level, we need that as well and each
// tier tenant we bring on and brokerages tenants"). The platform's OWN number
// (TWILIO_PHONE_NUMBER, master account) is answered by the same turn-based
// conversational engine that answers tenant lines, but with a different job:
// sell the product HONESTLY, capture prospect hand-raises into the existing
// growth funnel (platform_prospects), and route existing-tenant support callers.
//
// Everything the AI says about the product resolves LIVE: the app's name/tagline
// from platform_settings.product_brand (never hardcoded — the name is still
// being decided) and pricing from subscription_tiers (never hardcoded — plans
// are edited by platform staff). Session state is platform_reception_calls
// (voice_calls is tenant-shaped: NOT NULL brokerage/contact/agent).

import { withAiCallDisclosures } from "@/lib/communication/call-disclosures"
import { PROSPECT_ROLES } from "@/lib/platform/growth-funnel"
import { buildQualificationPrompt } from "@/lib/ai-isa/qualification-playbook"
import type { BrandPlaybookContext } from "@/lib/ai-isa/brand-playbook-context"

// ── Number routing ────────────────────────────────────────────────────────────

/** PURE: is this called number the PLATFORM's own line? */
export function isPlatformNumber(toNumber: string | null | undefined, platformNumber: string | null | undefined): boolean {
  const a = (toNumber ?? "").replace(/\D/g, "")
  const b = (platformNumber ?? "").replace(/\D/g, "")
  return a.length > 0 && a === b
}

// ── Context (all live-resolved; nothing about the product is hardcoded) ──────

export interface PlatformReceptionContext {
  brandName: string
  tagline: string
  /** What the receptionist says the product is — a SETTING (product_brand.voicePitch). */
  voicePitch: string
  /** The opening question — a SETTING (product_brand.receptionGreeting). */
  receptionGreeting: string
  tierLines: string[]
  forwardNumber: string | null
  authToken: string
  /** Wave 75 — the PLATFORM's own brand + tenant-free KB (never a tenant's),
   *  resolved once by resolvePlatformReceptionContext via
   *  loadBrandPlaybookContext({brokerageId: null, ...}). */
  brand: BrandPlaybookContext | null
}

/** PURE: subscription_tiers rows → spoken pricing lines. Cents → dollars; only
 *  active tiers; no tiers configured → an honest "team will follow up" line. */
export function composeTierLines(rows: Array<{ display_name?: string | null; monthly_price_cents?: number | null; max_agents?: number | null; is_active?: boolean | null }>): string[] {
  const active = (rows ?? []).filter((r) => r?.is_active !== false && (r?.display_name ?? "").trim())
  if (active.length === 0) return ["Pricing is being finalized — offer to have the team follow up with current plan details. Never invent a price."]
  return active.map((r) => {
    const price = typeof r.monthly_price_cents === "number" && r.monthly_price_cents > 0
      ? `$${(r.monthly_price_cents / 100).toLocaleString("en-US")} per month`
      : "pricing on request"
    const seats = typeof r.max_agents === "number" && r.max_agents > 0 ? `, up to ${r.max_agents} agents` : ""
    return `${(r.display_name ?? "").trim()}: ${price}${seats}`
  })
}

/** Resolve the platform reception context: brand + live tier pricing + master
 *  auth token (the platform line lives on the MASTER Twilio account). */
export async function resolvePlatformReceptionContext(svc: any): Promise<PlatformReceptionContext | null> {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) return null
  const { loadProductBrand } = await import("@/lib/platform/product-brand")
  const { loadBrandPlaybookContext } = await import("@/lib/ai-isa/brand-playbook-context")
  const [brand, tiers, playbookBrand] = await Promise.all([
    loadProductBrand(svc),
    svc.from("subscription_tiers")
      .select("display_name, monthly_price_cents, max_agents, is_active")
      .eq("is_active", true).order("monthly_price_cents", { ascending: true })
      .then((r: any) => r.data ?? [], () => []),
    loadBrandPlaybookContext({ brokerageId: null }).catch(() => null),
  ])
  return {
    brandName: brand.name,
    tagline: brand.tagline,
    voicePitch: brand.voicePitch,
    receptionGreeting: brand.receptionGreeting,
    tierLines: composeTierLines(tiers),
    forwardNumber: (process.env.PLATFORM_RECEPTION_FORWARD_NUMBER ?? "").trim() || null,
    authToken,
    brand: playbookBrand,
  }
}

// ── The platform reception prompt (pure) ─────────────────────────────────────

export function buildPlatformReceptionPrompt(id: {
  brandName: string; tagline: string; tierLines: string[]; hasTransfer: boolean
  voicePitch?: string; receptionGreeting?: string
  brand?: BrandPlaybookContext | null
}): { firstMessage: string; systemPrompt: string } {
  // NO HARDCODED COPY (owner rule): the greeting question + product pitch are
  // SETTINGS (product_brand.receptionGreeting / .voicePitch — resolved with
  // defaults by resolveProductBrand); only the legal preamble is composed here.
  const greeting = (id.receptionGreeting ?? "").trim() || "How can I help you today?"
  const rawFirst = `Thanks for calling ${id.brandName} — I'm the AI assistant. ${greeting}`
  const firstMessage = withAiCallDisclosures(rawFirst, { recorded: true })

  const systemPrompt = [
    `You are the AI reception assistant answering the main phone line for ${id.brandName} — ${id.tagline}. This is the PLATFORM's own line: callers are either prospects curious about the product or existing customers who need support.`,
    "Tone: warm, professional, concise. Keep answers short — this is a phone call, not an essay.",
    `WHAT THE PRODUCT IS: ${(id.voicePitch ?? "").trim() || `${id.brandName} — ${id.tagline}`}.`,
    `CURRENT PLANS (the ONLY pricing you may state — read from the live plan catalog):\n${id.tierLines.map((l) => `- ${l}`).join("\n")}`,
    // "this goes for the platform ai agents" (wave 74) — the shared
    // conversational discipline (never salesy, one question at a time,
    // value before ask), NOT the real-estate buyer/seller goal list: a
    // platform prospect is asking about the SOFTWARE, not a property.
    buildQualificationPrompt({ surface: "platform_reception", brand: id.brand }),
    "FOR PROSPECTS: (1) learn their name and what they run — solo agent, team, brokerage, or multi-location; (2) answer honestly from what you know above; (3) ask for the best email so the team can send details and set up a walkthrough. Once they've shared contact details, use the 'prospect' action to save them.",
    id.hasTransfer
      ? "FOR EXISTING CUSTOMERS NEEDING SUPPORT: offer to connect them to the team right away (action 'transfer')."
      : "FOR EXISTING CUSTOMERS NEEDING SUPPORT: no live transfer is available on this line — take their name, company, and a short description of the issue, tell them the team will follow up quickly, then close. Never claim you can transfer.",
    "HARD RULES: Never invent pricing, discounts, features, customer names, or statistics — if you don't know, say the team will confirm. Never guarantee business results. Never disparage a competitor by name. Never give legal, lending, or tax advice.",
    "If the caller asks whether you are an AI or a robot, confirm honestly and immediately — never pretend to be human.",
    "If the caller asks to stop being contacted, acknowledge it clearly and end politely — their request is recorded.",
  ].filter(Boolean).join("\n")

  return { firstMessage, systemPrompt }
}

// ── Tenant-free platform FAQ tool (lane 73E) ──────────────────────────────────
//
// Item 5 of the voice-turn-engine restructuring: this line has NO
// brokerage/property context by design (it is the PLATFORM's own prospect/
// support line, never a tenant's), so none of lib/ai-isa/batchdata-isa-
// tools.ts's persona-scoped property tools belong here — that stays true.
// But it DOES have a SAFE, tenant-free capability the onboarding assistant
// already exercises: lib/intelligence/kb-search.ts's help_topics_kb search,
// scoped to `brokerage_id IS NULL` (platform-wide FAQ/help rows) by passing
// `brokerageId: null` — the RPC's own WHERE clause (`h.brokerage_id IS NULL
// OR h.brokerage_id = p_brokerage_id`) already degrades to exactly that set
// when `p_brokerage_id` is NULL, so this can never surface a brokerage's
// private help content. Wired as a REAL AI-SDK tool (native multi-step
// calling), same shape as the voice ISA's property tools below.
export async function platformFaqTools(): Promise<Record<string, unknown>> {
  const { tool } = await import("ai")
  const { z } = await import("zod")
  const { searchKB } = await import("@/lib/intelligence/kb-search")
  return {
    platform_faq_lookup: tool({
      description: "Search the platform's own public FAQ / help-topic knowledge base for facts about the product, how it works, or pricing plans. Tenant-free — only platform-wide entries are ever returned, never a brokerage's private content. Use this before saying \"I don't know\" to a product question.",
      inputSchema: z.object({ query: z.string().min(2).max(200) }),
      execute: async ({ query }: { query: string }) => {
        try {
          const results = await searchKB(query, null, 3)
          if (results.length === 0) return { success: true, found: false }
          return { success: true, found: true, topics: results.map((r) => ({ title: r.title, content: r.content.slice(0, 600) })) }
        } catch (e: any) {
          return { success: false, error: e?.message ?? "FAQ lookup failed" }
        }
      },
    }),
  }
}

// TOMBSTONE (2026-08-27, §6 one-vocabulary): PROSPECT_ROLE_INTERESTS was a
// second spelling of the SAME five-value role vocabulary the growth funnel
// owns. Survivor: lib/platform/growth-funnel.ts:13 PROSPECT_ROLES — the list
// the DB CHECK (role_interest), validateProspectInput and the proposal tier
// mapping already key on. One list, so a new tier value cannot land in one
// speller and not the other (imported at the top of this file).

// TOMBSTONE (lane 75D, wave 75 — ONE voice receptionist engine): this file's
// former PlatformTurnAction / PlatformTurnPlan / PLATFORM_TURN_INSTRUCTIONS /
// PLATFORM_TOOL_TURN_GUIDANCE / parsePlatformTurnPlan / planPlatformReceptionTurn
// are RETIRED. Survivors:
//   - the turn CONTRACT merged onto lib/voice/reception-brain.ts's
//     VoiceTurnAction (its "prospect" variant) / VoiceTurnPlan / parseTurnPlan
//     (which now accepts the union of both deployments' actions) and that
//     file's PLATFORM_TURN_INSTRUCTIONS / PLATFORM_TOOL_TURN_GUIDANCE exports
//     (moved there verbatim, unchanged text).
//   - the TURN-PLANNING FUNCTION merged onto lib/voice/twilio-voice.ts's
//     planReceptionTurn({ deployment: "platform", ... }) — same tool-round
//     engine (runVoiceTurnRound) the tenant deployment always used, offered
//     `platformFaqTools()` (now exported below, unchanged) instead of the
//     tenant's persona-scoped property/capture bundle.
// PROSPECT_ROLES (above) still lives here — capturePhoneProspect below still
// reads it, and it is re-exported nowhere else, so no import broke.

// ── Prospect capture (into the EXISTING growth funnel) ───────────────────────

/**
 * Capture a phone hand-raise into platform_prospects. Idempotent: by email when
 * the caller gave one (same key the web capture uses), otherwise by caller-ID
 * phone. A repeat caller updates their row, never duplicates. Source is
 * 'phone:reception' so the funnel can attribute the channel.
 */
export async function capturePhoneProspect(svc: any, input: {
  phone: string
  name?: string | null
  email?: string | null
  company?: string | null
  roleInterest?: string | null
  note?: string | null
}): Promise<{ id: string } | null> {
  const phone = input.phone.trim()
  if (!phone) return null
  const role = (PROSPECT_ROLES as readonly string[]).includes(input.roleInterest ?? "") ? input.roleInterest : "unknown"
  const fields = {
    name: input.name?.trim() || null,
    company: input.company?.trim() || null,
    role_interest: role,
    interest_note: input.note?.trim() || null,
    source: "phone:reception",
    updated_at: new Date().toISOString(),
  }

  if (input.email) {
    // Same idempotency key as the web capture — merges a caller who also
    // signed up online. If their phone is already on ANOTHER row (unique
    // index), fall through to the phone path instead of erroring the call.
    const { data, error } = await svc.from("platform_prospects")
      .upsert({ email: input.email, phone, ...fields }, { onConflict: "email" })
      .select("id").single()
    if (!error && data) return { id: (data as any).id }
  }

  const { data: existing } = await svc.from("platform_prospects").select("id").eq("phone", phone).maybeSingle()
  if (existing) {
    await svc.from("platform_prospects").update(fields).eq("id", (existing as any).id).then(undefined, () => {})
    return { id: (existing as any).id }
  }
  const { data: inserted, error } = await svc.from("platform_prospects")
    .insert({ phone, email: input.email ?? null, ...fields }).select("id").single()
  if (error || !inserted) return null
  return { id: (inserted as any).id }
}
