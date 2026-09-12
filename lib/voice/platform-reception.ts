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
  const [brand, tiers] = await Promise.all([
    loadProductBrand(svc),
    svc.from("subscription_tiers")
      .select("display_name, monthly_price_cents, max_agents, is_active")
      .eq("is_active", true).order("monthly_price_cents", { ascending: true })
      .then((r: any) => r.data ?? [], () => []),
  ])
  return {
    brandName: brand.name,
    tagline: brand.tagline,
    voicePitch: brand.voicePitch,
    receptionGreeting: brand.receptionGreeting,
    tierLines: composeTierLines(tiers),
    forwardNumber: (process.env.PLATFORM_RECEPTION_FORWARD_NUMBER ?? "").trim() || null,
    authToken,
  }
}

// ── The platform reception prompt (pure) ─────────────────────────────────────

export function buildPlatformReceptionPrompt(id: {
  brandName: string; tagline: string; tierLines: string[]; hasTransfer: boolean
  voicePitch?: string; receptionGreeting?: string
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

// ── Turn planning (platform contract: continue | prospect | transfer | hangup) ─

// TOMBSTONE (2026-08-27, §6 one-vocabulary): PROSPECT_ROLE_INTERESTS was a
// second spelling of the SAME five-value role vocabulary the growth funnel
// owns. Survivor: lib/platform/growth-funnel.ts:13 PROSPECT_ROLES — the list
// the DB CHECK (role_interest), validateProspectInput and the proposal tier
// mapping already key on. One list, so a new tier value cannot land in one
// speller and not the other (imported at the top of this file).

export type PlatformTurnAction =
  | { kind: "say" }
  | { kind: "prospect"; name: string | null; email: string | null; company: string | null; roleInterest: string; note: string | null }
  | { kind: "transfer" }
  | { kind: "hangup" }

export interface PlatformTurnPlan {
  say: string
  action: PlatformTurnAction
}

export const PLATFORM_TURN_INSTRUCTIONS = [
  "Respond with JSON ONLY, no prose around it:",
  '{ "say": "<what you speak next — one to three short sentences>",',
  '  "action": "continue" | "prospect" | "transfer" | "hangup",',
  '  "name": "<caller name, ONLY with action prospect>",',
  '  "email": "<caller email if they gave one, ONLY with action prospect>",',
  '  "company": "<their company/team if given, ONLY with action prospect>",',
  '  "role_interest": "solo_agent" | "team" | "brokerage" | "multi_location" | "unknown",',
  '  "note": "<one line on what they want, ONLY with action prospect>" }',
  "Rules: action 'prospect' once the caller has shared contact details and wants follow-up — their phone number is already captured from caller ID, so a name alone is enough.",
  "action 'transfer' ONLY for existing-customer support when a transfer is offered in your instructions.",
  "action 'hangup' when the caller says goodbye or the call is complete — say a warm close first.",
  "Otherwise action 'continue'.",
].join("\n")

/** PURE: parse the platform turn — malformed output degrades to a safe
 *  clarifier, never a crash mid-call; role_interest is normalized to the
 *  funnel's CHECK list; a garbage email is dropped rather than stored. */
export function parsePlatformTurnPlan(raw: string): PlatformTurnPlan {
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("no json")
    const p = JSON.parse(match[0]) as Record<string, string | undefined>
    const say = (p.say ?? "").trim().slice(0, 600)
    if (!say) throw new Error("empty say")
    const a = (p.action ?? "continue").toLowerCase()
    if (a === "transfer") return { say, action: { kind: "transfer" } }
    if (a === "hangup") return { say, action: { kind: "hangup" } }
    if (a === "prospect") {
      const email = (p.email ?? "").trim().toLowerCase()
      const role = (p.role_interest ?? "unknown").trim().toLowerCase()
      return {
        say,
        action: {
          kind: "prospect",
          name: (p.name ?? "").trim().slice(0, 120) || null,
          email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 200) : null,
          company: (p.company ?? "").trim().slice(0, 160) || null,
          roleInterest: (PROSPECT_ROLES as readonly string[]).includes(role) ? role : "unknown",
          note: (p.note ?? "").trim().slice(0, 400) || null,
        },
      }
    }
    return { say, action: { kind: "say" } }
  } catch {
    return { say: "Sorry — could you say that once more?", action: { kind: "say" } }
  }
}

/** One platform reception turn: transcript + utterance → the brain → plan. */
export async function planPlatformReceptionTurn(
  ctx: PlatformReceptionContext,
  transcript: string | null,
  callerUtterance: string,
  extraRules?: string,
): Promise<PlatformTurnPlan> {
  let { systemPrompt } = buildPlatformReceptionPrompt({
    brandName: ctx.brandName, tagline: ctx.tagline, tierLines: ctx.tierLines, hasTransfer: !!ctx.forwardNumber,
    voicePitch: ctx.voicePitch, receptionGreeting: ctx.receptionGreeting,
  })
  if (extraRules) systemPrompt = `${systemPrompt}\n\n${extraRules}`
  const { transcriptToMessages } = await import("@/lib/voice/reception-brain")
  const convo = transcriptToMessages(transcript).map((m) => `${m.role === "assistant" ? "AI" : "Caller"}: ${m.content}`).join("\n")
  const { generateTextRouted } = await import("@/lib/ai/models")
  const { text } = await generateTextRouted({
    feature: "voice_reception_turn",
    prompt: `${systemPrompt}\n\n${PLATFORM_TURN_INSTRUCTIONS}\n\nConversation so far:\n${convo || "(call just connected)"}\nCaller: ${callerUtterance}\n\nYour JSON:`,
    temperature: 0.4,
    maxTokens: 300,
  })
  return parsePlatformTurnPlan(text)
}

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
