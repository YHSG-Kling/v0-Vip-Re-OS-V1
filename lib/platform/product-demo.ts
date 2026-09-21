// lib/platform/product-demo.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PRODUCT DEMO A PLATFORM AI AGENT CAN GIVE — PURE (lane 77B, owner
// verbatim: "the platform should also offer the same ai agents like the live
// agent using d-id because the platform can use those ai agents as a demo'd
// product").
//
// The platform's live agent IS the product: the same D-ID Express v4 live
// agent every subscriber's website, widget and portal gets. So the cheapest
// demo is the one already running — the prospect is talking to it. What this
// module adds is the NARRATIVE the agent can give when asked "what does it
// actually do?": a scripted walkthrough per topic, grounded in the customer-
// care capability catalogue (lib/ai-isa/capability-catalogue.ts — the tools a
// tenant's agent really has, injected here so this module stays pure and
// never restates the catalogue, CLAUDE.md §6) and in the LIVE plan bullets
// (subscription_tiers.marketing_bullets — never a hardcoded feature list).
//
// COST POSTURE (docs/avatar-provider-recommendation-2026-09.md, wave 76D):
// D-ID streaming ≈ $0.50/min at Scale; a rendered avatar clip ≈ $1/min. A demo
// therefore NEVER renders anything and NEVER calls a model: the walkthrough
// is static text the live agent speaks, and "show me" plays a pre-rendered
// sample clip the platform already paid for once (product_brand.liveAgent.
// demoClipUrl) — a public mp4 URL the widget embeds when the agent's reply
// carries the [[CLIP:<url>]] token. No clip configured → the agent describes,
// honestly, and offers the live demo on a rep's calendar.

import type { CapabilityId } from "@/lib/ai-isa/capability-catalogue"

export const PRODUCT_DEMO_TOPICS = [
  "overview", "reception_isa", "live_agent", "video_marketing", "deals_portal", "recruiting_ops",
] as const
export type ProductDemoTopic = (typeof PRODUCT_DEMO_TOPICS)[number]

export function isProductDemoTopic(v: unknown): v is ProductDemoTopic {
  return typeof v === "string" && (PRODUCT_DEMO_TOPICS as readonly string[]).includes(v)
}

export interface ProductDemoScript {
  topic: ProductDemoTopic
  label: string
  /** One sentence: what this part of the OS runs for a subscriber. */
  whatItRuns: string
  /** The walkthrough beats, in order — spoken one at a time, never as a list read aloud. */
  walkthrough: string[]
  /** Catalogue capabilities this topic demonstrates (labels resolved at call time). */
  capabilityIds: readonly CapabilityId[]
}

export const PRODUCT_DEMO_SCRIPTS: Record<ProductDemoTopic, ProductDemoScript> = {
  overview: {
    topic: "overview",
    label: "The whole OS in one minute",
    whatItRuns: "an accountable AI team — reception, follow-up, marketing, deals, recruiting and reporting — from one command center",
    walkthrough: [
      "Every lead that comes in is answered in seconds by an AI ISA that qualifies it — contact info, intent, timeline — before an agent ever touches it. Leads belong to the brokerage; agents get contacts once they're real.",
      "The live agent you're talking to right now is the same one a subscriber's website, embeddable widget and client portal get — their own face and voice, on camera, answering from their own brand voice and knowledge base.",
      "Deals, marketing video, social posts, recruiting and vendor management each have an AI manager that does the work and hands off to a human only when a decision needs one.",
    ],
    capabilityIds: ["record_qualification", "schedule_callback", "book_listing_appointment"],
  },
  reception_isa: {
    topic: "reception_isa",
    label: "AI reception + ISA follow-up",
    whatItRuns: "the phone line, the website chat and every inbound lead, answered and qualified around the clock",
    walkthrough: [
      "A caller reaches the brokerage's number and the AI receptionist answers in the brokerage's own name — it knows the live inventory, the office hours and the service areas.",
      "It qualifies without sounding like a form: one question at a time, mirrors their words, records what it learns — name, intent, the property they're selling or the criteria they're buying on, a timeline bucket, financing.",
      "Then it offers ONE follow-up that fits: a callback from the agent, matching listings, a home-value review with the agent, or a no-obligation listing appointment booked live on the agent's real calendar at least a week out — the agent just confirms.",
      "If someone wants a person right away, it transfers or creates a durable callback task the AI ISA actually places when it's time.",
    ],
    capabilityIds: ["record_qualification", "schedule_callback", "send_matching_listings", "schedule_home_value_review", "book_listing_appointment", "request_showing"],
  },
  live_agent: {
    topic: "live_agent",
    label: "The live agent (this)",
    whatItRuns: "a face-to-face AI agent on the website, the embeddable widget and the client portal",
    walkthrough: [
      "You're looking at it. A subscriber records a short consent statement and a bit of footage once, and their twin is built — their face, their cloned voice, their personality.",
      "It runs on the website for anonymous visitors, on any third-party site through an embed, and inside the client portal where it already knows the client's transaction, milestones and listing.",
      "Visitors can type, talk by voice, or go face-to-face — and if the video leg ever drops it falls back to text chat with the same brain, never a dead button.",
      "Every minute is metered to the tenant and every conversation lands in their CRM as a contact with what was learned.",
    ],
    capabilityIds: ["get_my_context", "search_our_listings", "get_listing_details"],
  },
  video_marketing: {
    topic: "video_marketing",
    label: "Video + social marketing",
    whatItRuns: "explainer videos, market updates, listing reels and social posts, written compliance-first and rendered autonomously",
    walkthrough: [
      "The marketing manager writes scripts with fair-housing baked into the writing prompt, not bolted on after — and the spoken lines are written to sound like a person, not an AI.",
      "Personal videos use the agent's twin; the rest run as voiceover-narrated reels because that's twenty times cheaper per minute — the OS spends the avatar budget only where the agent's face is the point.",
      "Newsletters, market reports and process explainers go out to the right contacts on the right channel, with every send compliance-gated at the wire.",
    ],
    capabilityIds: ["send_newsletter", "send_market_report", "send_explainer_video"],
  },
  deals_portal: {
    topic: "deals_portal",
    label: "Deals + the client portal",
    whatItRuns: "transaction coordination with a client portal that shows every milestone the agent chooses to share",
    walkthrough: [
      "Under contract, the deal coordinator tracks milestones, documents and vendors, and nudges whoever's late — client-visible milestones show up in the portal automatically.",
      "Clients can ask their questions in the portal, by text or face-to-face with the live agent, and the answer is grounded in their own transaction — never another client's.",
      "Vendors and lenders get their own seat and see only their own work, never the brokerage's financials.",
    ],
    // get_my_vendor_status is a VENDOR SEAT tool (lib/ai-isa/user-type-tools.ts,
    // lane 77A — "vendors are not contact type, they are user type"), not a
    // customer-care capability, so the demo names only catalogue ids here and
    // the vendor seat is described in the walkthrough line above.
    capabilityIds: ["get_my_context", "request_vendor_referral"],
  },
  recruiting_ops: {
    topic: "recruiting_ops",
    label: "Recruiting, retention + operations",
    whatItRuns: "agent recruiting and 90-day onboarding, retention signals, vendor management and reporting",
    walkthrough: [
      "The recruiting manager sources and works recruits, and every new agent gets a phased 90-day journey with a deterministic daily plan — three priorities and one lesson, from their real state.",
      "Falling behind is caught early and a gated intervention goes to the broker before the agent churns.",
      "Referrals in and out are captured and tracked, vendors are managed with a bench, and reporting rolls up to the command center where the owner sees the whole business.",
    ],
    capabilityIds: ["capture_referral", "request_vendor_referral"],
  },
}

/** The token the live agent may append to a reply so the widget plays the
 *  pre-rendered sample clip — a URL the platform already paid to render once,
 *  never a new render per conversation. */
export const DEMO_CLIP_TOKEN_RE = /\[\[CLIP:(https?:\/\/[^\]\s]+)\]\]/

export function demoClipToken(url: string): string {
  return `[[CLIP:${url}]]`
}

/** PURE: pull the clip URL out of an agent reply and return the spoken text without it. */
export function splitDemoClipToken(text: string): { text: string; clipUrl: string | null } {
  const m = DEMO_CLIP_TOKEN_RE.exec(text)
  if (!m) return { text, clipUrl: null }
  return { text: text.replace(DEMO_CLIP_TOKEN_RE, "").replace(/\s{2,}/g, " ").trim(), clipUrl: m[1] ?? null }
}

export interface ProductDemoContext {
  brandName: string
  /** LIVE plan bullets (subscription_tiers.marketing_bullets), when loaded. */
  tierBullets?: string[]
  /** product_brand.liveAgent.demoClipUrl — a pre-rendered public mp4, or null. */
  clipUrl?: string | null
  /** Only a visual surface (the live agent / the web chat) can show a clip — voice cannot. */
  surfaceCanShowClip: boolean
}

export interface ProductDemoResult {
  topic: ProductDemoTopic
  label: string
  summary: string
  walkthrough: string[]
  capabilities: Array<{ id: string; label: string; usefulFor: string }>
  planHighlights: string[]
  /** Present ONLY when a clip exists and the surface can show it. */
  clipUrl: string | null
  /** The verbatim token to append to the reply when clipUrl is present. */
  clipToken: string | null
  /** What to say when nothing can be shown — never a fabricated "here's a video". */
  ifNoClip: string
}

/**
 * PURE: the demo for a topic. `catalogue` is injected (lib/ai-isa/capability-
 * catalogue.ts::CAPABILITY_CATALOGUE) so labels are the catalogue's own —
 * never a second spelling.
 */
export function describeProductDemo(
  topicRaw: string | null | undefined,
  ctx: ProductDemoContext,
  catalogue: ReadonlyArray<{ id: string; label: string; usefulFor: string }>,
): ProductDemoResult {
  const topic: ProductDemoTopic = isProductDemoTopic(topicRaw) ? topicRaw : "overview"
  const script = PRODUCT_DEMO_SCRIPTS[topic]
  const byId = new Map(catalogue.map((c) => [c.id, c]))
  const capabilities = script.capabilityIds
    .map((id) => byId.get(id))
    .filter((c): c is { id: string; label: string; usefulFor: string } => !!c)
    .map((c) => ({ id: c.id, label: c.label, usefulFor: c.usefulFor }))
  const clipUrl = ctx.surfaceCanShowClip && ctx.clipUrl && /^https?:\/\//.test(ctx.clipUrl) ? ctx.clipUrl : null
  return {
    topic,
    label: script.label,
    summary: `${ctx.brandName} runs ${script.whatItRuns}.`,
    walkthrough: script.walkthrough,
    capabilities,
    planHighlights: (ctx.tierBullets ?? []).slice(0, 6),
    clipUrl,
    clipToken: clipUrl ? demoClipToken(clipUrl) : null,
    ifNoClip: clipUrl
      ? ""
      : "No sample clip is configured on this surface — describe it from the walkthrough and offer the live demo on a rep's calendar (find_demo_slots) if they want to see it running on their own data.",
  }
}
