// lib/open-house/event-marketing.ts
// ─────────────────────────────────────────────────────────────────────────────
// C22 — the event's REGISTRATION PAGE + INVITATIONS, drafted by AI and APPROVED by a person before anything is published or sent
// (wave 148, lane 148H; owner: "automatic: event + branded registration page, invitations/assets for approval"; preamble:
// humans approve external publication). The model writes the words; the code supplies every fact (date, time, link, name) at
// send time (event-attendance.ts renderEventCopy) — so a fact is never the model's to invent.
//
// FAIR HOUSING: this IS public marketing copy (the registration page, the invitation, a social post) — the rules live IN the
// writing prompt (compliance-first, CLAUDE.md §5) and every string is scanned afterwards (lib/compliance-rules/fair-housing-
// patterns.ts detectFairHousingViolations). A high-severity finding blocks approval until the words change; warnings pass
// through to the approver.
//
// C32 TENANT BRAND (wave 149, lane 149F — owner ruling 15): the copy speaks in the CREATING tenant's name — the solo agent's, the
// team's or the brokerage's (THE brand cascade, lib/branding/resolve-brand-context.ts) — and never names the platform. TOMBSTONE:
// the prompt opened "You are the events director … inside VIPAgents, the AI team that works beside a real-estate brokerage" — it
// put the platform's name in the model's mouth and assumed every tenant is a brokerage (preamble: "never assume a brokerage").
// The platform's name now reaches the model only for a platform-owned event (brand_owner = 'platform', m947), and a platform
// name in a tenant event's copy is a BLOCKING finding (scanEventCopy → platformBrandHits).

import { z } from "zod"
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { EVENT_PRODUCER_REGISTRY, eventBrandOwner, isEventKind, isOnlineEvent, platformBrandHits, type EventBrand, type EventKind } from "./event-registry"

type Db = { from: (table: string) => any }

const EventMarketingDraftSchema = z.object({
  headline: z.string(),
  registration_intro: z.string(),
  what_you_will_learn: z.array(z.string()),
  invitation_subject: z.string(),
  invitation_body: z.string(),
  invitation_sms: z.string(),
  confirmation_subject: z.string(),
  confirmation_body: z.string(),
  // WAVE 149 (149F, C29): the words of a reminder — WHETHER and WHEN one is sent is the arbiter's (lib/open-house/event-touches.ts).
  reminder_subject: z.string(),
  reminder_body: z.string(),
  replay_attended_subject: z.string(),
  replay_attended_body: z.string(),
  replay_missed_subject: z.string(),
  replay_missed_body: z.string(),
  // WAVE 149 (149F, lane 148H Still open 3): the session handout's delivery note — written only for a kind that promises one.
  handout_subject: z.string().optional(),
  handout_body: z.string().optional(),
  social_post: z.string(),
  self_check: z.string(),
})
export type EventMarketingDraft = z.infer<typeof EventMarketingDraftSchema>

/** The strings a person reads (scanned for fair housing and the platform brand; `self_check` is the model's note to the approver, never published). */
export const PUBLISHED_COPY_FIELDS = [
  "headline", "registration_intro", "invitation_subject", "invitation_body", "invitation_sms", "confirmation_subject", "confirmation_body",
  "reminder_subject", "reminder_body", "replay_attended_subject", "replay_attended_body", "replay_missed_subject", "replay_missed_body", "social_post",
] as const
/** Published only when the kind promises a session handout. */
export const HANDOUT_COPY_FIELDS = ["handout_subject", "handout_body"] as const

export interface EventMarketingFacts {
  kind: EventKind
  title: string
  description: string | null
  propertyAddress: string | null
  dateLabel: string
  timeLabel: string
  timezone: string | null
  online: boolean
  provider: string | null
  /** C32: the tenant's own brand (or the platform's, on a platform-owned event only). */
  brand: Pick<EventBrand, "owner" | "displayName" | "agentName" | "website">
  deliverables: readonly string[]
}

/** @proofSeam scripts/event-producer-registry-guard.ts scores this prompt against the expert rubric (with a one-line control) */
export const EVENT_MARKETING_SYSTEM = [
  "ROLE AND MANDATE: You are the events director and lead copywriter for ONE real-estate business — the HOST named in the facts. The host may be a solo agent, a team or a brokerage; write as their own events team, in their name. You write the words for ONE event they are hosting — its registration page, its invitation (email + text), the confirmation a registrant receives, a reminder, the follow-up that delivers the recording (and the handout, when one is promised), and one social post. Your words are the host's first impression on a neighbour who might buy, sell or simply want to understand their market. Be kind, warm, specific and genuinely useful: it is about THEM — their questions, their next step — never about the agent's sales numbers.",
  "BRAND (non-negotiable): the ONLY business named anywhere in the copy is the host brand given in HOSTED BY (and the host agent's name when given). Never name the software, platform, CRM, AI system or any technology vendor behind the host — the host's audience is hearing from the host, not from a tool. If the facts say PLATFORM EVENT, the host IS the platform and its name is the brand. A host website, when given, is the one address you may mention.",
  "THE PERSON YOU SERVE: someone deciding whether this hour is worth their time. Tell them, concretely, what they will see or learn and what they will leave with. Invite, never pressure: no countdown clocks, no 'only 3 seats left' unless it is a fact you were given, no guilt.",
  "FACTS YOU MAY RELY ON — and ONLY these: the event kind, title, description, property address (for a property event), date, time and timezone labels, whether it is online and on which host, the host brand, the host agent's name, the host website, and the deliverables listed. NEVER invent a price, a feature of the home, a statistic, a guest, a giveaway, a discount, a school name or a neighbourhood claim. If something would help but was not given, leave it out.",
  "PLACEHOLDERS — the system fills these at send time; use them exactly, never a made-up value: {{first_name}}, {{event_title}}, {{date_time}}, {{join_link}} (the person's PERSONAL join link — it belongs in the confirmation and the reminder of an online event, and nowhere public), {{replay_link}} (the recording — it belongs in both replay messages), {{handout_link}} (the handout — only in the handout message).",
  "FAIR HOUSING (this is public marketing copy — the rule is part of the writing, not a later scan): describe the event, the home and the help — never the people. No words about who should or should not attend or live somewhere (family status, age, religion, race, colour, national origin, sex, disability, or any state-protected class), no 'perfect for young families', 'exclusive', 'safe neighbourhood', 'walking distance to church', no steering. Everyone is welcome; say so naturally when it fits. Accessible-format requests are welcome — invite them to reply.",
  "COMPLIANCE NOTES: the text invitation is ≤ 300 characters and ends with 'Reply STOP to opt out.'; every email body closes with a one-line, low-key way to reply with questions. Do not promise a recording in the invitation unless 'replay_recording' is among the deliverables — then say 'we'll send the recording to everyone who registers'.",
  "THE DECISION YOU OWN: the angle (why this hour matters to this person now), the headline, and 3–5 'what you'll learn / see' bullets grounded in the facts. A creative brief: make a webinar feel like a helpful neighbour's kitchen-table talk, a virtual open house feel like a personal walkthrough with someone who knows the home, an education session feel like the class you wish you'd had before your last move, a client gathering feel like a genuine thank-you with no pitch at all. You do NOT decide when anything is sent — the reminder is written once; whether and when it goes is decided later from the person's situation.",
  "OUTPUT CONTRACT — JSON only, every field a string except what_you_will_learn (an array of 3–5 short strings): headline (≤ 80 chars), registration_intro (≤ 600 chars, the page's opening paragraph), what_you_will_learn, invitation_subject (≤ 70), invitation_body (≤ 900, may use {{first_name}} and {{event_title}}, ends by pointing to the registration page — the system appends the link), invitation_sms (≤ 300, ends 'Reply STOP to opt out.'), confirmation_subject, confirmation_body (≤ 700; for an online event it MUST contain {{join_link}} and {{date_time}}), reminder_subject, reminder_body (≤ 500, a friendly nudge that MUST contain {{date_time}} — and {{join_link}} for an online event; no countdown pressure), replay_attended_subject, replay_attended_body (thank them for joining; MUST contain {{replay_link}}), replay_missed_subject, replay_missed_body (no guilt — 'sorry we missed you, here it is'; MUST contain {{replay_link}}), handout_subject + handout_body (ONLY when 'session_handout' is a deliverable; the body MUST contain {{handout_link}}), social_post (≤ 400, no personal data, no links — the system adds the page link), self_check (one sentence to the human approver: anything you were unsure of or left out on purpose).",
  "ESCALATION: if the facts are too thin to write honestly (no title, no date), still return valid JSON, keep every message short and factual, and say exactly what is missing in self_check — a person approves this before anyone sees it.",
].join("\n\n")

function buildEventMarketingPrompt(f: EventMarketingFacts): string {
  const spec = EVENT_PRODUCER_REGISTRY[f.kind]
  return [
    f.brand.owner === "platform" ? "PLATFORM EVENT: the host is the platform itself (its own name is the brand)." : "TENANT EVENT: name only the host brand below — never the software behind it.",
    `EVENT KIND: ${spec.label} (${f.kind}) — ${spec.rationale}`,
    `TITLE: ${f.title}`,
    f.description ? `DESCRIPTION (the agent's own words): ${f.description}` : "DESCRIPTION: none given",
    f.propertyAddress ? `${spec.listing === "required" ? "PROPERTY" : "VENUE"}: ${f.propertyAddress}` : "PROPERTY: not a single-property event",
    `WHEN: ${f.dateLabel}${f.timeLabel ? `, ${f.timeLabel}` : ""}${f.timezone ? ` (${f.timezone})` : ""}`,
    `WHERE: ${f.online ? `online${f.provider === "zoom" ? " on Zoom (each registrant gets a personal link)" : f.provider === "youtube" ? " as a YouTube Live broadcast (registrants receive the watch link)" : " (the link is sent after registering)"}` : "in person"}`,
    `HOSTED BY: ${f.brand.agentName ? `${f.brand.agentName}, ` : ""}${f.brand.displayName}`,
    f.brand.website ? `HOST WEBSITE: ${f.brand.website}` : "HOST WEBSITE: none given",
    `DELIVERABLES PROMISED: ${f.deliverables.length ? f.deliverables.join(", ") : "none"}`,
    "Write the copy now, following the output contract exactly.",
  ].join("\n")
}

export interface CopyFinding { field: string; phrase: string; severity: "high" | "medium" | "low"; fix: string }

/**
 * PURE — scan every published field: fair housing; the platform's brand on a TENANT event (C32 — blocking); and the placeholder
 * rules a send depends on (a confirmation without the join link is no confirmation).
 */
export function scanEventCopy(
  draft: Partial<Record<string, unknown>>,
  ctx: { online: boolean; brandOwner?: string | null; platformNames?: readonly string[]; promisesHandout?: boolean },
): { findings: CopyFinding[]; blocking: boolean; missing: string[] } {
  const findings: CopyFinding[] = []
  const missing: string[] = []
  const tenantEvent = eventBrandOwner(ctx.brandOwner) === "tenant"
  const fields: readonly string[] = ctx.promisesHandout ? [...PUBLISHED_COPY_FIELDS, ...HANDOUT_COPY_FIELDS] : PUBLISHED_COPY_FIELDS
  const scanText = (field: string, v: string) => {
    for (const hit of detectFairHousingViolations(v)) findings.push({ field, phrase: hit.phrase, severity: hit.severity, fix: hit.fix })
    if (tenantEvent) for (const p of platformBrandHits(v, ctx.platformNames ?? [])) findings.push({ field, phrase: p, severity: "high", fix: "a tenant event speaks only in the host's own brand — remove the platform's name" })
  }
  for (const field of fields) {
    const v = draft[field]
    if (typeof v !== "string" || !v.trim()) { missing.push(field); continue }
    scanText(field, v)
  }
  // The bullets render on the public page too.
  if (Array.isArray(draft.what_you_will_learn)) for (const b of draft.what_you_will_learn) if (typeof b === "string") scanText("what_you_will_learn", b)
  if (ctx.online && typeof draft.confirmation_body === "string" && !draft.confirmation_body.includes("{{join_link}}")) missing.push("confirmation_body: {{join_link}}")
  if (typeof draft.reminder_body === "string" && !draft.reminder_body.includes("{{date_time}}")) missing.push("reminder_body: {{date_time}}")
  if (ctx.online && typeof draft.reminder_body === "string" && !draft.reminder_body.includes("{{join_link}}")) missing.push("reminder_body: {{join_link}}")
  for (const f of ["replay_attended_body", "replay_missed_body"] as const) if (typeof draft[f] === "string" && !(draft[f] as string).includes("{{replay_link}}")) missing.push(`${f}: {{replay_link}}`)
  if (ctx.promisesHandout && typeof draft.handout_body === "string" && !draft.handout_body.includes("{{handout_link}}")) missing.push("handout_body: {{handout_link}}")
  if (typeof draft.invitation_sms === "string" && !/reply stop/i.test(draft.invitation_sms)) missing.push("invitation_sms: 'Reply STOP to opt out.'")
  return { findings, blocking: findings.some((x) => x.severity === "high") || missing.length > 0, missing }
}

// ─── C32: THE EVENT'S BRAND ─────────────────────────────────────────────────

export interface EventBrandDeps {
  /** THE brand cascade (lib/branding/resolve-brand-context.ts resolveBrandContext) — a seam only for the proof (it is server-only). */
  brandContext?: (args: { brokerageId: string; teamId: string | null; agentUserId: string | null }) => Promise<{ displayName: string; brokerageName: string; agentName?: string | null; display: { websiteWordmark: string | null }; visual: { logoUrl: string | null; primaryColor: string }; fairHousing: { shortDisclosure: string } }>
  /** The platform's own brand kit (lib/platform/product-brand.ts loadProductBrand) — read only for a platform-owned event. */
  productBrand?: (svc: Db) => Promise<{ name: string; ctaUrl: string; logoUrl: string | null; primaryColor: string }>
}

/**
 * THE brand an event speaks in (C32). Tenant event: THE cascade for the event's tenant + the creating user's team + the creating
 * user (a solo agent's motto / a team's logo / the brokerage's), with the consent's legal entity beside it. Platform event (only
 * `brand_owner = 'platform'`): the platform's brand kit. A cascade that cannot be read falls back to the tenant row's own name —
 * never to the platform's (the failure that would leak "VIPAgents" onto a tenant's page is exactly the one this refuses).
 */
export async function resolveEventBrand(svc: Db, ev: { id: string; brokerage_id: string; agent_id?: string | null; created_by?: string | null }, deps: EventBrandDeps = {}): Promise<EventBrand> {
  // brand_owner is read on its own: before m947 is applied the column is absent (PGRST204 / 42703) and the answer is 'tenant'.
  const { data: ownerRow, error: ownerErr } = await svc.from("open_house_events").select("brand_owner").eq("id", ev.id).eq("brokerage_id", ev.brokerage_id).maybeSingle()
  const owner = ownerErr ? "tenant" : eventBrandOwner((ownerRow as { brand_owner?: unknown } | null)?.brand_owner)
  if (owner === "platform") {
    const load = deps.productBrand ?? (async (s: Db) => (await import("@/lib/platform/product-brand")).loadProductBrand(s))
    const p = await load(svc)
    return { owner, displayName: p.name, brokerageName: p.name, agentName: null, website: p.ctaUrl.replace(/^https?:\/\/(www\.)?/i, "") || null, logoUrl: p.logoUrl, primaryColor: p.primaryColor, fairHousingLine: null }
  }
  const { resolveConsentBrand } = await import("@/lib/contact-pipeline/contact-capture")
  const legal = await resolveConsentBrand(svc as never, { brokerageId: ev.brokerage_id, agentId: ev.agent_id ?? null })
  let teamId: string | null = null
  if (ev.created_by) {
    const { data: u } = await svc.from("users").select("team_id").eq("id", ev.created_by).eq("brokerage_id", ev.brokerage_id).maybeSingle()
    teamId = (u as { team_id?: string | null } | null)?.team_id ?? null
  }
  try {
    const cascade = deps.brandContext ?? (async (a: { brokerageId: string; teamId: string | null; agentUserId: string | null }) => (await import("@/lib/branding/resolve-brand-context")).resolveBrandContext(a))
    const c = await cascade({ brokerageId: ev.brokerage_id, teamId, agentUserId: ev.created_by ?? null })
    return {
      owner, displayName: c.displayName, brokerageName: legal, agentName: c.agentName ?? null, website: c.display.websiteWordmark,
      logoUrl: c.visual.logoUrl, primaryColor: c.visual.primaryColor, fairHousingLine: c.fairHousing.shortDisclosure,
    }
  } catch (e) {
    console.warn(`[event-marketing] brand cascade unreadable for event ${ev.id} — the tenant's own name stands: ${e instanceof Error ? e.message : String(e)}`)
    return { owner, displayName: legal, brokerageName: legal, agentName: null, website: null, logoUrl: null, primaryColor: null, fairHousingLine: null }
  }
}

// ─── RULINGS 11 + 12: THE REGISTRATION PAGE ON THE TENANT'S WEBSITE, AND ITS QR ────────────────────────────────────────────

/**
 * The event's public front door. A registration kind lives INSIDE the tenant's own website (app/site/[slug]/events/[eventId] —
 * the tenant storefront survivor, lib/kernel/tenant-creation.ts tenantWebsitePath; on a connected custom domain the proxy serves
 * the same path); a tenant with no site slug falls back to the platform-origin page /open-house/<id>/register. A kiosk kind's
 * front door is its sign-in page. Relative path; the caller prefixes the public origin.
 */
export async function eventFrontDoorPath(svc: Db, ev: { id: string; brokerage_id: string; event_type: string | null }): Promise<string> {
  if (!isEventKind(ev.event_type)) return `/open-house/${ev.id}/register`
  if (EVENT_PRODUCER_REGISTRY[ev.event_type].registration.door?.fn !== "POST" || EVENT_PRODUCER_REGISTRY[ev.event_type].registration.door?.file !== "app/api/open-house/register/route.ts") return `/open-house/${ev.id}/signin`
  const { data: b } = await svc.from("brokerages").select("slug").eq("id", ev.brokerage_id).maybeSingle()
  const slug = String((b as { slug?: string | null } | null)?.slug ?? "").trim()
  if (!slug) return `/open-house/${ev.id}/register`
  const { tenantWebsitePath } = await import("@/lib/kernel/tenant-creation")
  return `${tenantWebsitePath(slug)}/events/${ev.id}`
}

/**
 * RULING 11 — every published event carries a QR code to its registration page: minted through THE one QR minter
 * (lib/marketing/tracked-qr.ts mintTrackedQr — the qr_codes registry, scan-tracked, idempotent on openHouseQrLabel(eventId)),
 * owned by the event's tenant and host agent, then stamped on open_house_events.qr_code_id. A refused mint or stamp is said.
 */
export async function ensureEventQr(svc: Db, ev: { id: string; brokerage_id: string; agent_id?: string | null; listing_id?: string | null; event_type: string | null }, deps: { mint?: typeof import("@/lib/marketing/tracked-qr").mintTrackedQr } = {}): Promise<{ ok: true; scanUrl: string; targetUrl: string; imageUrl: string } | { ok: false; error: string }> {
  try {
    const { siteUrl } = await import("@/lib/platform/site-url")
    const origin = siteUrl()
    if (!origin) return { ok: false, error: "no public origin configured (NEXT_PUBLIC_APP_URL) — a QR to a relative address would scan to nowhere" }
    const path = await eventFrontDoorPath(svc, ev)
    const tq = await import("@/lib/marketing/tracked-qr")
    const mint = deps.mint ?? tq.mintTrackedQr
    const registration = path.includes("/events/") || path.endsWith("/register")
    const minted = await mint({
      brokerageId: ev.brokerage_id, agentId: ev.agent_id ?? null, label: tq.openHouseQrLabel(ev.id),
      destinationType: registration ? "landing_page" : "book_meeting", targetUrl: `${origin}${path}`, listingId: ev.listing_id ?? null,
      purpose: ev.event_type === "open_house" ? "open_house" : "event", origin,
    }, svc as never)
    if (!minted) return { ok: false, error: "the QR code was not minted — the registry write was refused" }
    const { data: upd, error } = await svc.from("open_house_events").update({ qr_code_id: minted.qrCodeId }).eq("id", ev.id).eq("brokerage_id", ev.brokerage_id).select("id")
    if (error || !Array.isArray(upd) || upd.length !== 1) return { ok: false, error: `QR minted but not attached to the event: ${error?.message ?? "matched no row"}` }
    return { ok: true, scanUrl: minted.scanUrl, targetUrl: minted.targetUrl, imageUrl: minted.qrCodeDataUrl }
  } catch (e) {
    return { ok: false, error: `QR not minted: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export interface DraftDeps extends EventBrandDeps {
  generate?: (req: { brokerageId: string; system: string; prompt: string }) => Promise<EventMarketingDraft>
  now?: () => Date
}

export type DraftResult = { ok: true; status: "awaiting_approval" | "needs_revision"; findings: CopyFinding[]; missing: string[] } | { ok: false; error: string }

/**
 * Draft (or re-draft) the event's copy and hold it for approval. A model failure stores the failure — never stand-in static copy;
 * the approver may then write the words themselves (approval accepts edits, re-scanned).
 */
export async function draftEventMarketing(svc: Db, eventId: string, deps: DraftDeps = {}): Promise<DraftResult> {
  const { data: ev, error } = await svc.from("open_house_events")
    .select("id, brokerage_id, agent_id, created_by, event_type, title, description, property_address, event_date, start_time, end_time, timezone, virtual_provider, marketing_assets")
    .eq("id", eventId).maybeSingle()
  if (error) return { ok: false, error: `event read refused: ${error.message}` }
  if (!ev?.brokerage_id || !isEventKind(ev.event_type)) return { ok: false, error: "event not found" }
  const brand = await resolveEventBrand(svc, ev, deps)
  const spec = EVENT_PRODUCER_REGISTRY[ev.event_type as EventKind]
  const online = isOnlineEvent(ev.event_type, ev.virtual_provider)
  const facts: EventMarketingFacts = {
    kind: ev.event_type, title: ev.title?.trim() || (ev.property_address ? `${spec.label} at ${ev.property_address}` : spec.label),
    description: ev.description ?? null, propertyAddress: ev.property_address ?? null,
    dateLabel: ev.event_date ? new Date(`${String(ev.event_date).slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "date to be confirmed",
    timeLabel: ev.start_time ? `${String(ev.start_time).slice(0, 5)}${ev.end_time ? `–${String(ev.end_time).slice(0, 5)}` : ""}` : "",
    timezone: ev.timezone ?? null, online, provider: ev.virtual_provider ?? null,
    brand: { owner: brand.owner, displayName: brand.displayName, agentName: brand.agentName, website: brand.website },
    deliverables: spec.deliverables,
  }
  const now = (deps.now ?? (() => new Date()))().toISOString()
  let draft: EventMarketingDraft | null = null
  let failure: string | null = null
  try {
    const generate = deps.generate ?? (async (req) => {
      const { generateObjectRouted } = await import("@/lib/ai/models")
      const { object } = await generateObjectRouted({ feature: "social_post_generation", brokerageId: req.brokerageId, system: req.system, prompt: req.prompt, schema: EventMarketingDraftSchema, temperature: 0.7, maxTokens: 2600 })
      return object as EventMarketingDraft
    })
    draft = EventMarketingDraftSchema.parse(await generate({ brokerageId: ev.brokerage_id, system: EVENT_MARKETING_SYSTEM, prompt: buildEventMarketingPrompt(facts) }))
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e)
  }
  const prior = (ev.marketing_assets ?? {}) as Record<string, unknown>
  const scanCtx = { online, brandOwner: brand.owner, promisesHandout: spec.deliverables.includes("session_handout") }
  const scan = draft ? scanEventCopy(draft, scanCtx) : { findings: [], blocking: true, missing: [...PUBLISHED_COPY_FIELDS] }
  const status = draft && !scan.blocking ? "awaiting_approval" : "needs_revision"
  const assets = { ...prior, status, draft: draft ?? prior.draft ?? null, fair_housing: scan.findings, missing: scan.missing, drafted_at: now, brand: { owner: brand.owner, display_name: brand.displayName }, ...(failure ? { draft_error: failure.slice(0, 300) } : { draft_error: null }) }
  const { data: upd, error: uErr } = await svc.from("open_house_events").update({ marketing_assets: assets }).eq("id", ev.id).eq("brokerage_id", ev.brokerage_id).select("id")
  if (uErr || !Array.isArray(upd) || upd.length !== 1) return { ok: false, error: `draft not stored: ${uErr?.message ?? "matched no row"}` }
  return { ok: true, status, findings: scan.findings, missing: scan.missing }
}
