/**
 * lib/lead-intelligence/visitor-email-capture.ts — THE consented website-visitor email capture and
 * THE visitor-identify match (wave 103, lane 103D; m706; owner answer 1, 2026-10-05: "YES build
 * CONSENTED website-visitor email capture (the identify loop fires only on a consent artifact)").
 *
 * SURVIVORS THIS EXTENDS, NEVER REPLACES (OS-CONSTITUTION LAW 1 / 2):
 *   · the behavioral_signals writer — app/actions/lead-intelligence.ts trackBehavior, the public
 *     visitor pixel behind POST /api/track/visitor (tenant from the slug, never the body). It is the
 *     ONE capture door: it calls captureConsentedVisitorEmail below for a visit that carries an email.
 *     The widget's capture form (POST /api/widget/capture-lead) is the same door — it hands its
 *     visitor id and the consent artifact it already wrote to trackBehavior.
 *   · the consent writer — lib/kernel/compliance/require-contact-consent.ts persistContactConsent,
 *     the ONE contact_consent_events inserter every door uses (forms, widget, open house, ads). It now
 *     returns the artifact's id; this module stores an email ONLY against that id.
 *   · the identify match — resolveIdentity (lead-intelligence.ts) matched `email_captured` to a
 *     tenant contact and stamped identified / contact_id; wave 102.1 (lane 102E) put the person
 *     evidence writer behind it. Both now live HERE as resolveSignalIdentity (the session-gated
 *     resolveIdentity delegates), so the public capture door and the staff action share one match.
 *   · person evidence — lib/kernel/person-identity.ts (resolvePerson / linkPersonEvidence), the
 *     `behavioral_signal` entity reserved in m697.
 *
 * FAIL CLOSED (CLAUDE.md §4): no consent → nothing stored, no match, no evidence. The rule is the
 * pure visitorEmailCaptureVerdict (the proof executes it) and m706's CHECK repeats it at the database
 * (email_captured IS NULL OR consent_event_id IS NOT NULL). A consent artifact handed in by id is READ
 * back (same tenant, consented = true) before anything is stored — a made-up id stores nothing.
 *
 * Not server-only: proof-driven with an injected client (scripts/person-identity-guard.ts). Every
 * read/write destructures `{ data, error }` (§3); the signal update is `.select()`ed and counted.
 */

import { persistContactConsent } from "@/lib/kernel/compliance/require-contact-consent"

type Client = { from: (table: string) => any }

// ── The rule ─────────────────────────────────────────────────────────────────────────────────────

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type VisitorEmailCaptureVerdict =
  | { ok: true; email: string }
  | { ok: false; reason: "no_consent" | "invalid_email" }

/**
 * PURE — may this email be stored at all? ONLY an explicit `consented === true` (a ticked box the
 * caller turned into a consent artifact), never a bare form field, never a truthy string.
 * @proofSeam scripts/person-identity-guard.ts executes this rule directly (positive control: a capture
 * without consent stores nothing).
 */
export function visitorEmailCaptureVerdict(input: { email: unknown; consented: unknown }): VisitorEmailCaptureVerdict {
  if (input.consented !== true) return { ok: false, reason: "no_consent" }
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : ""
  if (!email || email.length > 254 || !EMAIL_SHAPE.test(email)) return { ok: false, reason: "invalid_email" }
  return { ok: true, email }
}

/** PostgREST ilike takes `%` / `_` as wildcards — an address is matched literally. */
function ilikeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// ── The identify match (the survivor, moved here from resolveIdentity) ───────────────────────────

export interface ResolveSignalIdentityInput {
  brokerageId: string
  signalId: string
  /** users.id of the human who ran the resolution; null for the public capture door (system actor). */
  actorUserId: string | null
}

export type ResolveSignalIdentityResult =
  | { identified: true; contact: Record<string, unknown>; method: "email_match" }
  | { identified: false; reason: "signal_not_found" | "no_email" | "no_contact_match" | "read_refused" | "link_refused"; error?: string }

/**
 * THE visitor-identify match: the signal's consented email → the tenant's contact with that email →
 * behavioral_signals.identified / contact_id → the person evidence (contact + behavioral_signal,
 * email_exact, source visitor_identify). Tenant from the CALLER's already-resolved context (a session
 * brokerage or the slug-resolved pixel tenant), pinned on both reads.
 */
export async function resolveSignalIdentity(client: Client, input: ResolveSignalIdentityInput): Promise<ResolveSignalIdentityResult> {
  const { data: signal, error: signalErr } = await client
    .from("behavioral_signals")
    .select("id, brokerage_id, email_captured, consent_event_id, identified, contact_id")
    .eq("id", input.signalId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (signalErr) return { identified: false, reason: "read_refused", error: signalErr.message }
  if (!signal) return { identified: false, reason: "signal_not_found" }
  // The rule again at the reader: an email with no consent artifact is never matched (m706's CHECK
  // makes the state unreachable live; an older row or an in-memory fixture is refused here).
  const email = typeof signal.email_captured === "string" && signal.consent_event_id ? signal.email_captured.trim().toLowerCase() : ""
  if (!email) return { identified: false, reason: "no_email" }

  // Only match within the caller's brokerage.
  const { data: contact, error: contactErr } = await client
    .from("contacts")
    .select("*")
    .eq("brokerage_id", input.brokerageId)
    .ilike("email", ilikeLiteral(email))
    .limit(1)
    .maybeSingle()
  if (contactErr) return { identified: false, reason: "read_refused", error: contactErr.message }
  if (!contact) return { identified: false, reason: "no_contact_match" }

  const { data: linked, error: identifyErr } = await client
    .from("behavioral_signals")
    .update({ identified: true, contact_id: contact.id })
    .eq("id", signal.id)
    .eq("brokerage_id", input.brokerageId)
    .select("id")
  if (identifyErr) {
    console.error(`[visitor-email-capture] visitor identified but the signal was NOT linked to the contact: ${identifyErr.message}`)
    return { identified: false, reason: "link_refused", error: identifyErr.message }
  }
  if (!linked || linked.length === 0) return { identified: false, reason: "link_refused", error: "signal update matched no row" }

  await recordBehavioralSignalIdentity(client, { brokerageId: input.brokerageId, signalId: signal.id as string, contact, actorUserId: input.actorUserId })
  return { identified: true, contact, method: "email_match" }
}

// PERSON IDENTITY (wave 102.1, lane 102E; moved here from app/actions/lead-intelligence.ts in wave
// 103, lane 103D, so the public capture door shares it) — THIS is where the `behavioral_signal`
// evidence reserved in m697 gets its writer: the identified visitor is linked to the CONTACT's person
// (the contact by email_exact, the signal by email_exact, because an email_captured match is what
// identified it). Tenant = the caller's context the match above was already pinned to; actor = the
// human who ran the resolution, or the system for the public door (LAW 5). No chokepoint event exists
// here, so the one person.identity_linked event is emitted. Best-effort: the signal link above already
// landed and is never un-reported.
async function recordBehavioralSignalIdentity(
  client: Client,
  input: { brokerageId: string; signalId: string; contact: { id: string; first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null }; actorUserId: string | null },
): Promise<void> {
  try {
    const { resolvePerson, linkPersonEvidence } = await import("@/lib/kernel/person-identity")
    const person = await resolvePerson(client as any, {
      brokerageId: input.brokerageId,
      firstName: input.contact.first_name ?? null, lastName: input.contact.last_name ?? null,
      email: input.contact.email ?? null, phone: input.contact.phone ?? null,
    })
    if (!person.ok) {
      if (person.reason !== "no_identity_anchor") console.warn(`[visitor-email-capture] person identity not resolved for the identified visitor: ${person.reason}`)
      return
    }
    const actor = input.actorUserId ? { type: "user" as const, userId: input.actorUserId } : { type: "system" as const, userId: null }
    const common = { brokerageId: input.brokerageId, personId: person.personId, source: "visitor_identify", actor, identity: person.identity }
    const a = await linkPersonEvidence(client as any, { ...common, entityType: "contact", entityId: input.contact.id, matchMethod: "email_exact", matchScore: 1, detail: { behavioral_signal_id: input.signalId } })
    const b = await linkPersonEvidence(client as any, { ...common, entityType: "behavioral_signal", entityId: input.signalId, matchMethod: "email_exact", matchScore: 1, detail: { contact_id: input.contact.id, identified_by: "email_captured" } })
    for (const r of [a, b]) if (!r.ok) console.warn(`[visitor-email-capture] behavioral_signal person evidence not recorded: ${r.reason}`)
  } catch (err) {
    console.warn("[visitor-email-capture] person identity threw (signal link unaffected):", err instanceof Error ? err.message : String(err))
  }
}

// ── The capture door ─────────────────────────────────────────────────────────────────────────────

export type VisitorEmailConsent =
  /** The visitor ticked the box on THIS request: the artifact is written here through the one writer. */
  | { consented: boolean; consentText?: string | null; consentSource: string; ipAddress?: string | null; userAgent?: string | null; agentId?: string | null }
  /** The caller already wrote the artifact through the one writer on this request (the widget form). */
  | { consentEventId: string }

export interface CaptureConsentedVisitorEmailInput {
  brokerageId: string
  signalId: string
  email: unknown
  consent: VisitorEmailConsent
  /** users.id of a human actor; null for the public door. */
  actorUserId: string | null
}

export type CaptureConsentedVisitorEmailResult =
  | { stored: true; email: string; consentEventId: string; identity: ResolveSignalIdentityResult }
  | { stored: false; reason: "no_consent" | "invalid_email" | "consent_not_recorded" | "consent_artifact_not_found" | "store_refused"; error?: string }

const DEFAULT_CONSENT_TEXT = "Website visitor consent — the visitor agreed to be contacted by email about their real estate needs."

/**
 * THE ONE writer of behavioral_signals.email_captured / email_captured_at / consent_event_id (m706).
 * Order: the rule → the consent artifact (written, or read back by id) → the signal → the identify
 * match. Nothing is stored before the artifact exists; a refused artifact write stores nothing.
 */
export async function captureConsentedVisitorEmail(client: Client, input: CaptureConsentedVisitorEmailInput): Promise<CaptureConsentedVisitorEmailResult> {
  const byId = "consentEventId" in input.consent
  const verdict = visitorEmailCaptureVerdict({ email: input.email, consented: byId ? true : (input.consent as { consented: boolean }).consented })
  if (!verdict.ok) return { stored: false, reason: verdict.reason }

  // 1. The consent artifact — through the ONE consent writer, or an id read back from its ledger.
  let consentEventId: string | null = null
  if (byId) {
    const id = (input.consent as { consentEventId: string }).consentEventId
    const { data: artifact, error: artifactErr } = await client
      .from("contact_consent_events")
      .select("id, brokerage_id, consented")
      .eq("id", id)
      .eq("brokerage_id", input.brokerageId)
      .eq("consented", true)
      .maybeSingle()
    if (artifactErr) return { stored: false, reason: "consent_artifact_not_found", error: artifactErr.message }
    if (!artifact) return { stored: false, reason: "consent_artifact_not_found" }
    consentEventId = artifact.id as string
  } else {
    const c = input.consent as Exclude<VisitorEmailConsent, { consentEventId: string }>
    const written = await persistContactConsent({
      brokerageId: input.brokerageId,
      agentId: c.agentId ?? null,
      contactId: null,
      leadId: null,
      consentText: c.consentText?.trim() || DEFAULT_CONSENT_TEXT,
      consentSource: c.consentSource,
      consented: true,
      ipAddress: c.ipAddress ?? null,
      userAgent: c.userAgent ?? null,
    })
    consentEventId = written.consentEventId
    if (!consentEventId) return { stored: false, reason: "consent_not_recorded", error: written.error }
  }

  // 2. The signal — tenant-pinned, counted.
  const { data: stored, error: storeErr } = await client
    .from("behavioral_signals")
    .update({ email_captured: verdict.email, email_captured_at: new Date().toISOString(), consent_event_id: consentEventId })
    .eq("id", input.signalId)
    .eq("brokerage_id", input.brokerageId)
    .select("id")
  if (storeErr) return { stored: false, reason: "store_refused", error: storeErr.message }
  if (!stored || stored.length === 0) return { stored: false, reason: "store_refused", error: "signal update matched no row in this tenant" }

  // 3. The identify loop fires on the artifact.
  const identity = await resolveSignalIdentity(client, { brokerageId: input.brokerageId, signalId: input.signalId, actorUserId: input.actorUserId })
  return { stored: true, email: verdict.email, consentEventId, identity }
}
