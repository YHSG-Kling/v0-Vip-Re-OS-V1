"use server"

// app/actions/contact-persona.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CONTACT-CARD DOORS FOR THE PERSONA STUDY AND THE PROTECTED-ATTRIBUTE READ (wave 148, lane 148C — owner ruling 1, 2026-11-01:
// "the read of protected or prohibited can be used to determine the person's persona so users can create ads and posts, etc.
// around that persona. The admin, platform, agent, team lead, broker, compliance, support, etc. should be able to read.").
//
// Every export is a public HTTP endpoint (CLAUDE.md §4) and async. The ACTOR and the TENANT come from the SESSION
// (resolveCallerIdentity) — never from an argument; the contact id is the only thing the caller names, and every read below is
// pinned to the session tenant (platform staff: the contact's own tenant, with the written justification the reader demands).
// Gate first, then the service client.
//
// WHO MAY READ WHAT is decided in ONE place — the reader's role × purpose matrix (lib/enrichment/protected-research-store.ts
// PROTECTED_READ_MATRIX): this door hands it the session seat and the purpose the person chose, and shows its refusal in words.

import { resolveCallerIdentity } from "@/lib/auth/require-caller"
import { createServiceClient } from "@/lib/supabase/service"

/** The m913 five-layer columns (written, not applied) — named once, degraded BY NAME to the legacy columns when absent. */
const FIVE_LAYER_SELECT = "persona_name, stated_needs, behavioural_evidence, inferred_interests, research_layer, marketing_persona, marketing_safe, service_profile, derivation, derived_at, updated_at"

/** The purposes the contact card offers — the reader refuses any it does not admit for the seat (named, ledgered). */
const CARD_READ_PURPOSES = ["customer_service", "persona_derivation", "research", "compliance_audit", "support_investigation"] as const

type Seat = { userId: string; userType: string | null; platformRole: string | null; brokerageId: string | null }

/** Session seat + the tenant this contact is read under. Not exported (a "use server" export is an endpoint). */
async function seatAndTenant(contactId: string): Promise<{ ok: true; seat: Seat; brokerageId: string; svc: ReturnType<typeof createServiceClient> } | { ok: false; error: string }> {
  if (!contactId || typeof contactId !== "string") return { ok: false, error: "contactId is required" }
  const id = await resolveCallerIdentity()
  if (!id.ok) return { ok: false, error: id.error }
  const seat: Seat = { userId: id.userId, userType: id.userType, platformRole: id.platformRole, brokerageId: id.brokerageId }
  const svc = createServiceClient()
  if (seat.brokerageId) return { ok: true, seat, brokerageId: seat.brokerageId, svc }
  // Platform staff sit above tenants: the contact's own tenant is the one read under (the reader still demands a justification).
  if (!seat.platformRole) return { ok: false, error: "Your account is not linked to a brokerage" }
  const { data, error } = await svc.from("contacts").select("brokerage_id").eq("id", contactId).maybeSingle()
  if (error) return { ok: false, error: `contact tenant unreadable: ${error.message}` }
  const b = (data as { brokerage_id?: string | null } | null)?.brokerage_id
  if (!b) return { ok: false, error: "contact not found" }
  return { ok: true, seat, brokerageId: b, svc }
}

/** Read one contact's protected / research attributes for a chosen purpose (the reader enforces role, scope, rights, audit). */
export async function readContactResearchAttributes(input: { contactId: string; purpose: string; purposeNote?: string | null }) {
  const g = await seatAndTenant(input?.contactId)
  if (!g.ok) return { ok: false as const, error: g.error }
  const purpose = String(input.purpose ?? "")
  if (!(CARD_READ_PURPOSES as readonly string[]).includes(purpose)) return { ok: false as const, error: `"${purpose}" is not a purpose this card offers (${CARD_READ_PURPOSES.join(", ")})` }
  const { readProtectedAttributes } = await import("@/lib/enrichment/protected-research-store")
  const read = await readProtectedAttributes(g.svc, {
    brokerageId: g.brokerageId, contactId: input.contactId, purpose, purposeNote: input.purposeNote ?? null,
    actor: { userId: g.seat.userId, userType: g.seat.userType, platformRole: g.seat.platformRole, brokerageId: g.seat.brokerageId },
  })
  if (!read.ok) return { ok: false as const, error: read.reason, refused: read.refused, evidenced: read.evidenced }
  return {
    ok: true as const, purpose: read.purpose, role: read.role, scope: read.scope, evidenced: read.evidenced,
    attributes: read.attributes.map((a) => ({ field: a.field, value: a.value == null ? null : String(a.value), protectedClass: a.protectedClass, basis: a.basis, dataRights: a.dataRights, source: a.provenance?.source ?? null, retrievedAt: a.freshness.retrievedAt, fresh: a.freshness.fresh, confidence: a.confidence })),
    withheld: read.withheld,
  }
}

/** Run the persona study for one contact (session actor, purpose persona_derivation — the reader re-checks the seat). */
export async function deriveContactPersona(input: { contactId: string }) {
  const g = await seatAndTenant(input?.contactId)
  if (!g.ok) return { ok: false as const, error: g.error }
  const { derivePersona } = await import("@/lib/contacts/persona-builder")
  const res = await derivePersona(g.svc, {
    brokerageId: g.brokerageId, contactId: input.contactId,
    actor: { userId: g.seat.userId, userType: g.seat.userType, platformRole: g.seat.platformRole, brokerageId: g.seat.brokerageId },
  })
  if (!res.ok) return { ok: false as const, error: res.error ?? "the persona could not be derived", notes: res.notes }
  return {
    ok: true as const, written: res.written, marketingSafe: res.marketingSafe, contactPersonaWritten: res.contactPersonaWritten,
    research: res.research, notes: res.notes, persona: JSON.parse(JSON.stringify(res.persona)) as Record<string, unknown>,
  }
}

/** The stored persona — layers 2–5 and the research layer's field NAMES (never values). Tenant-pinned. */
export async function loadContactPersona(input: { contactId: string }) {
  const g = await seatAndTenant(input?.contactId)
  if (!g.ok) return { ok: false as const, error: g.error }
  const full = await g.svc.from("client_detailed_personas")
    .select(`${FIVE_LAYER_SELECT}`)
    .eq("contact_id", input.contactId).eq("brokerage_id", g.brokerageId).maybeSingle()
  if (!full.error) return { ok: true as const, layered: true, persona: (full.data ?? null) as Record<string, unknown> | null }
  // m913 not applied: the legacy columns only — said, never shown as "no persona".
  const legacy = await g.svc.from("client_detailed_personas").select("persona_name, persona_type, buying_triggers, pain_points, ai_summary, updated_at")
    .eq("contact_id", input.contactId).eq("brokerage_id", g.brokerageId).maybeSingle()
  if (legacy.error) return { ok: false as const, error: `persona unreadable: ${legacy.error.message}` }
  return { ok: true as const, layered: false, note: `five-layer columns unavailable (${full.error.message}) — the five-layer persona migration is not applied yet`, persona: (legacy.data ?? null) as Record<string, unknown> | null }
}
