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

import { z } from "zod"
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { EVENT_PRODUCER_REGISTRY, isEventKind, isOnlineEvent, type EventKind } from "./event-registry"

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
  replay_attended_subject: z.string(),
  replay_attended_body: z.string(),
  replay_missed_subject: z.string(),
  replay_missed_body: z.string(),
  social_post: z.string(),
  self_check: z.string(),
})
export type EventMarketingDraft = z.infer<typeof EventMarketingDraftSchema>

/** The strings a person reads (scanned for fair housing; `self_check` is the model's note to the approver, never published). */
export const PUBLISHED_COPY_FIELDS = [
  "headline", "registration_intro", "invitation_subject", "invitation_body", "invitation_sms", "confirmation_subject", "confirmation_body",
  "replay_attended_subject", "replay_attended_body", "replay_missed_subject", "replay_missed_body", "social_post",
] as const

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
  brokerageName: string
  agentName: string | null
  deliverables: readonly string[]
}

/** @proofSeam scripts/event-producer-registry-guard.ts scores this prompt against the wave-148 expert rubric (with a one-line control) */
export const EVENT_MARKETING_SYSTEM = [
  "ROLE AND MANDATE: You are the events director and lead copywriter inside VIPAgents, the AI team that works beside a real-estate brokerage. You write the words for ONE event the brokerage is hosting — its registration page, its invitation (email + text), the confirmation a registrant receives, the follow-up that delivers the recording, and one social post. Your words are the brokerage's first impression on a neighbour who might buy, sell or simply want to understand their market. Be kind, warm, specific and genuinely useful: it is about THEM — their questions, their next step — never about the agent's sales numbers.",
  "THE PERSON YOU SERVE: someone deciding whether this hour is worth their time. Tell them, concretely, what they will see or learn and what they will leave with. Invite, never pressure: no countdown clocks, no 'only 3 seats left' unless it is a fact you were given, no guilt.",
  "FACTS YOU MAY RELY ON — and ONLY these: the event kind, title, description, property address (for a property event), date, time and timezone labels, whether it is online and on which host, the brokerage name, the host agent's name, and the deliverables listed. NEVER invent a price, a feature of the home, a statistic, a guest, a giveaway, a discount, a school name or a neighbourhood claim. If something would help but was not given, leave it out.",
  "PLACEHOLDERS — the system fills these at send time; use them exactly, never a made-up value: {{first_name}}, {{event_title}}, {{date_time}}, {{join_link}} (the person's PERSONAL join link — it belongs in the confirmation of an online event, and nowhere public), {{replay_link}} (the recording — it belongs in both replay messages).",
  "FAIR HOUSING (this is public marketing copy — the rule is part of the writing, not a later scan): describe the event, the home and the help — never the people. No words about who should or should not attend or live somewhere (family status, age, religion, race, colour, national origin, sex, disability, or any state-protected class), no 'perfect for young families', 'exclusive', 'safe neighbourhood', 'walking distance to church', no steering. Everyone is welcome; say so naturally when it fits. Accessible-format requests are welcome — invite them to reply.",
  "COMPLIANCE NOTES: the text invitation is ≤ 300 characters and ends with 'Reply STOP to opt out.'; every email body closes with a one-line, low-key way to reply with questions. Do not promise a recording in the invitation unless 'replay_recording' is among the deliverables — then say 'we'll send the recording to everyone who registers'.",
  "THE DECISION YOU OWN: the angle (why this hour matters to this person now), the headline, and 3–5 'what you'll learn / see' bullets grounded in the facts. A creative brief: make a webinar feel like a helpful neighbour's kitchen-table talk, a virtual open house feel like a personal walkthrough with someone who knows the home, an education session feel like the class you wish you'd had before your last move.",
  "OUTPUT CONTRACT — JSON only, every field a string except what_you_will_learn (an array of 3–5 short strings): headline (≤ 80 chars), registration_intro (≤ 600 chars, the page's opening paragraph), what_you_will_learn, invitation_subject (≤ 70), invitation_body (≤ 900, may use {{first_name}} and {{event_title}}, ends by pointing to the registration page — the system appends the link), invitation_sms (≤ 300, ends 'Reply STOP to opt out.'), confirmation_subject, confirmation_body (≤ 700; for an online event it MUST contain {{join_link}} and {{date_time}}), replay_attended_subject, replay_attended_body (thank them for joining; MUST contain {{replay_link}}), replay_missed_subject, replay_missed_body (no guilt — 'sorry we missed you, here it is'; MUST contain {{replay_link}}), social_post (≤ 400, no personal data, no links — the system adds the page link), self_check (one sentence to the human approver: anything you were unsure of or left out on purpose).",
  "ESCALATION: if the facts are too thin to write honestly (no title, no date), still return valid JSON, keep every message short and factual, and say exactly what is missing in self_check — a person approves this before anyone sees it.",
].join("\n\n")

function buildEventMarketingPrompt(f: EventMarketingFacts): string {
  const spec = EVENT_PRODUCER_REGISTRY[f.kind]
  return [
    `EVENT KIND: ${spec.label} (${f.kind}) — ${spec.rationale}`,
    `TITLE: ${f.title}`,
    f.description ? `DESCRIPTION (the agent's own words): ${f.description}` : "DESCRIPTION: none given",
    f.propertyAddress ? `PROPERTY: ${f.propertyAddress}` : "PROPERTY: not a single-property event",
    `WHEN: ${f.dateLabel}${f.timeLabel ? `, ${f.timeLabel}` : ""}${f.timezone ? ` (${f.timezone})` : ""}`,
    `WHERE: ${f.online ? `online${f.provider === "zoom" ? " on Zoom (each registrant gets a personal link)" : f.provider === "youtube" ? " as a YouTube Live broadcast (registrants receive the watch link)" : " (the link is sent after registering)"}` : "in person"}`,
    `HOSTED BY: ${f.agentName ? `${f.agentName}, ` : ""}${f.brokerageName}`,
    `DELIVERABLES PROMISED: ${f.deliverables.length ? f.deliverables.join(", ") : "none"}`,
    "Write the copy now, following the output contract exactly.",
  ].join("\n")
}

export interface CopyFinding { field: string; phrase: string; severity: "high" | "medium" | "low"; fix: string }

/** PURE — scan every published field; also the placeholder rules a send depends on (a confirmation without the join link is no confirmation). */
export function scanEventCopy(draft: Partial<Record<string, unknown>>, ctx: { online: boolean }): { findings: CopyFinding[]; blocking: boolean; missing: string[] } {
  const findings: CopyFinding[] = []
  const missing: string[] = []
  for (const field of PUBLISHED_COPY_FIELDS) {
    const v = draft[field]
    if (typeof v !== "string" || !v.trim()) { missing.push(field); continue }
    for (const hit of detectFairHousingViolations(v)) findings.push({ field, phrase: hit.phrase, severity: hit.severity, fix: hit.fix })
  }
  if (ctx.online && typeof draft.confirmation_body === "string" && !draft.confirmation_body.includes("{{join_link}}")) missing.push("confirmation_body: {{join_link}}")
  for (const f of ["replay_attended_body", "replay_missed_body"] as const) if (typeof draft[f] === "string" && !(draft[f] as string).includes("{{replay_link}}")) missing.push(`${f}: {{replay_link}}`)
  if (typeof draft.invitation_sms === "string" && !/reply stop/i.test(draft.invitation_sms)) missing.push("invitation_sms: 'Reply STOP to opt out.'")
  return { findings, blocking: findings.some((x) => x.severity === "high") || missing.length > 0, missing }
}

export interface DraftDeps {
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
    .select("id, brokerage_id, agent_id, event_type, title, description, property_address, event_date, start_time, end_time, timezone, virtual_provider, marketing_assets")
    .eq("id", eventId).maybeSingle()
  if (error) return { ok: false, error: `event read refused: ${error.message}` }
  if (!ev?.brokerage_id || !isEventKind(ev.event_type)) return { ok: false, error: "event not found" }
  const [{ data: brk }, agentName] = await Promise.all([
    svc.from("brokerages").select("name").eq("id", ev.brokerage_id).maybeSingle(),
    (async () => {
      if (!ev.agent_id) return null
      const { data: a } = await svc.from("agents").select("user_id").eq("id", ev.agent_id).eq("brokerage_id", ev.brokerage_id).maybeSingle()
      if (!a?.user_id) return null
      const { data: u } = await svc.from("users").select("first_name, last_name").eq("id", a.user_id).maybeSingle()
      return [u?.first_name, u?.last_name].filter(Boolean).join(" ") || null
    })(),
  ])
  const online = isOnlineEvent(ev.event_type, ev.virtual_provider)
  const facts: EventMarketingFacts = {
    kind: ev.event_type, title: ev.title?.trim() || (ev.property_address ? `${EVENT_PRODUCER_REGISTRY[ev.event_type as EventKind].label} at ${ev.property_address}` : EVENT_PRODUCER_REGISTRY[ev.event_type as EventKind].label),
    description: ev.description ?? null, propertyAddress: ev.property_address ?? null,
    dateLabel: ev.event_date ? new Date(`${String(ev.event_date).slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "date to be confirmed",
    timeLabel: ev.start_time ? `${String(ev.start_time).slice(0, 5)}${ev.end_time ? `–${String(ev.end_time).slice(0, 5)}` : ""}` : "",
    timezone: ev.timezone ?? null, online, provider: ev.virtual_provider ?? null,
    brokerageName: (brk as { name?: string | null } | null)?.name?.trim() || "our brokerage", agentName,
    deliverables: EVENT_PRODUCER_REGISTRY[ev.event_type as EventKind].deliverables,
  }
  const now = (deps.now ?? (() => new Date()))().toISOString()
  let draft: EventMarketingDraft | null = null
  let failure: string | null = null
  try {
    const generate = deps.generate ?? (async (req) => {
      const { generateObjectRouted } = await import("@/lib/ai/models")
      const { object } = await generateObjectRouted({ feature: "social_post_generation", brokerageId: req.brokerageId, system: req.system, prompt: req.prompt, schema: EventMarketingDraftSchema, temperature: 0.7, maxTokens: 2200 })
      return object as EventMarketingDraft
    })
    draft = EventMarketingDraftSchema.parse(await generate({ brokerageId: ev.brokerage_id, system: EVENT_MARKETING_SYSTEM, prompt: buildEventMarketingPrompt(facts) }))
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e)
  }
  const prior = (ev.marketing_assets ?? {}) as Record<string, unknown>
  const scan = draft ? scanEventCopy(draft, { online }) : { findings: [], blocking: true, missing: [...PUBLISHED_COPY_FIELDS] }
  const status = draft && !scan.blocking ? "awaiting_approval" : "needs_revision"
  const assets = { ...prior, status, draft: draft ?? prior.draft ?? null, fair_housing: scan.findings, missing: scan.missing, drafted_at: now, ...(failure ? { draft_error: failure.slice(0, 300) } : { draft_error: null }) }
  const { data: upd, error: uErr } = await svc.from("open_house_events").update({ marketing_assets: assets }).eq("id", ev.id).eq("brokerage_id", ev.brokerage_id).select("id")
  if (uErr || !Array.isArray(upd) || upd.length !== 1) return { ok: false, error: `draft not stored: ${uErr?.message ?? "matched no row"}` }
  return { ok: true, status, findings: scan.findings, missing: scan.missing }
}
