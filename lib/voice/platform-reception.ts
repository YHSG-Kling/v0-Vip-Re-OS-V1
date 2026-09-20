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
import { buildQualificationPrompt } from "@/lib/ai-isa/qualification-playbook"
import type { BrandPlaybookContext } from "@/lib/ai-isa/brand-playbook-context"
import type { ProductBrand } from "@/lib/platform/product-brand"
import { upsertPlatformProspect } from "@/lib/platform/prospect-capture"
import { buildPlatformProspectTools, type PlatformProspectToolContext } from "@/lib/platform/prospect-agent-tools"

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
  /** Lane 76B — the platform's own brand kit (ctaUrl for the signup link,
   *  name for the texts), resolved by the same loadProductBrand call. */
  productBrand: ProductBrand
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
export async function resolvePlatformReceptionContext(
  svc: any,
  /** Lane 76B — the website prospect chat rides the SAME context without a
   *  Twilio account (no signature to validate); the phone line still
   *  requires the master auth token. */
  opts: { requireTwilio?: boolean } = {},
): Promise<PlatformReceptionContext | null> {
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? ""
  if (!authToken && opts.requireTwilio !== false) return null
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
    productBrand: brand,
  }
}

// ── The platform reception prompt (pure) ─────────────────────────────────────

export function buildPlatformReceptionPrompt(id: {
  brandName: string; tagline: string; tierLines: string[]; hasTransfer: boolean
  voicePitch?: string; receptionGreeting?: string
  brand?: BrandPlaybookContext | null
  /** Lane 76B — the SAME brain answers the website prospect chat; only the
   *  medium-specific lines differ. Defaults to the phone line. */
  channel?: "voice" | "chat"
}): { firstMessage: string; systemPrompt: string } {
  // NO HARDCODED COPY (owner rule): the greeting question + product pitch are
  // SETTINGS (product_brand.receptionGreeting / .voicePitch — resolved with
  // defaults by resolveProductBrand); only the legal preamble is composed here.
  const channel = id.channel ?? "voice"
  const greeting = (id.receptionGreeting ?? "").trim() || "How can I help you today?"
  const rawFirst = channel === "voice"
    ? `Thanks for calling ${id.brandName} — I'm the AI assistant. ${greeting}`
    : `Hi — I'm the ${id.brandName} AI assistant. ${greeting}`
  const firstMessage = channel === "voice" ? withAiCallDisclosures(rawFirst, { recorded: true }) : rawFirst

  const systemPrompt = [
    channel === "voice"
      ? `You are the AI reception assistant answering the main phone line for ${id.brandName} — ${id.tagline}. This is the PLATFORM's own line: callers are either prospects curious about the product or existing customers who need support.`
      : `You are the AI assistant on the public website of ${id.brandName} — ${id.tagline}. This is the PLATFORM's own site: visitors are prospects curious about the product (a brokerage, team, or agent evaluating it) or existing customers who need support. You are an AI and say so if asked.`,
    channel === "voice"
      ? "Tone: warm, professional, concise. Keep answers short — this is a phone call, not an essay."
      : "Tone: warm, professional, concise. Keep answers short — two or three sentences per message, one question at a time.",
    `WHAT THE PRODUCT IS: ${(id.voicePitch ?? "").trim() || `${id.brandName} — ${id.tagline}`}.`,
    `CURRENT PLANS (the ONLY pricing you may state — read from the live plan catalog):\n${id.tierLines.map((l) => `- ${l}`).join("\n")}`,
    // "this goes for the platform ai agents" (wave 74) — the shared
    // conversational discipline (never salesy, one question at a time,
    // value before ask) plus (lane 76B) the PLATFORM's own qualification
    // goals and the three exits — NOT the real-estate buyer/seller goal
    // list: a platform prospect is asking about the SOFTWARE, not a property.
    buildQualificationPrompt({ surface: "platform_reception", brand: id.brand }),
    channel === "voice"
      ? "FOR PROSPECTS: learn who they are and what they run, answer honestly from what you know above, save what you learn with save_prospect as you go, and when they're ready offer ONE of the three exits (a live demo, the signup link, or a person). Their phone number is already captured from caller ID. If you have no tools on this turn, use the 'prospect' action once they've shared a name or email so they are never lost."
      : "FOR PROSPECTS: learn who they are and what they run, answer honestly from what you know above, save what you learn with save_prospect as you go (ask for a work email early — it is how we follow up), and when they're ready offer ONE of the three exits (a live demo, the signup link, or a person).",
    id.hasTransfer
      ? "FOR EXISTING CUSTOMERS NEEDING SUPPORT: offer to connect them to the team right away (action 'transfer')."
      : channel === "voice"
        ? "FOR EXISTING CUSTOMERS NEEDING SUPPORT: no live transfer is available on this line — take their name, company, and a short description of the issue, tell them the team will follow up quickly, then close. Never claim you can transfer."
        : "FOR EXISTING CUSTOMERS NEEDING SUPPORT: take their name, company, and a short description of the issue and use request_human_handoff so a person follows up. Never claim you can transfer them live.",
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

/** Lane 76B — the FULL platform tool round: the tenant-free FAQ lookup above
 *  PLUS the prospect funnel bundle (save / demo slots / book demo / signup
 *  link / human handoff — lib/platform/prospect-agent-tools.ts). One bundle
 *  for both platform surfaces (this voice line and the website prospect
 *  chat, app/api/platform/prospect-chat/route.ts). */
export async function platformReceptionTools(ctx: PlatformProspectToolContext): Promise<Record<string, unknown>> {
  const [faq, prospect] = await Promise.all([platformFaqTools(), buildPlatformProspectTools(ctx)])
  return { ...faq, ...prospect }
}

// TOMBSTONE (2026-08-27, §6 one-vocabulary): PROSPECT_ROLE_INTERESTS was a
// second spelling of the SAME five-value role vocabulary the growth funnel
// owns. Survivor: lib/platform/growth-funnel.ts:13 PROSPECT_ROLES — the list
// the DB CHECK (role_interest), validateProspectInput and the proposal tier
// mapping already key on. One list, so a new tier value cannot land in one
// speller and not the other (lane 76B: now read through
// lib/platform/prospect-capture.ts::buildProspectColumnPatch, the ONE writer).

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
// ── Prospect capture (into the EXISTING growth funnel) ───────────────────────

/** The platform_prospects.source value the phone line writes on first touch. */
export const PHONE_RECEPTION_PROSPECT_SOURCE = "phone:reception"

/**
 * Capture a phone hand-raise into platform_prospects. Idempotent: by email when
 * the caller gave one (same key the web capture uses), otherwise by caller-ID
 * phone. A repeat caller updates their row, never duplicates. Source is
 * 'phone:reception' so the funnel can attribute the channel.
 *
 * TOMBSTONE (lane 76B): the email-upsert / phone-update / insert body that
 * stood here was one of THREE spellings of the same platform_prospects writer
 * (with app/actions/superadmin/platform-growth.ts's two web captures).
 * Survivor: lib/platform/prospect-capture.ts::upsertPlatformProspect — the ONE
 * writer (id → email → phone keys, details merge, never nulls a known fact).
 * This wrapper keeps the voice routes' call shape and the phone-line source.
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
  const saved = await upsertPlatformProspect(svc, {
    phone, email: input.email ?? null, name: input.name ?? null, company: input.company ?? null,
    roleInterest: input.roleInterest ?? null, note: input.note ?? null, source: PHONE_RECEPTION_PROSPECT_SOURCE,
  })
  return saved ? { id: saved.id } : null
}
