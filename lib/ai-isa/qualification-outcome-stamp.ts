/**
 * lib/ai-isa/qualification-outcome-stamp.ts — THE writer of the two ISA outcomes nobody wrote
 * (wave 91 lane 91A; 90C's open item).
 *
 * ai_isa_qualifications.qualification_result carries five values (live CHECK). Three had writers
 * (qualified / needs_follow_up — lib/ai-isa/qualification-evaluator.ts; not_qualified —
 * lib/kernel/ai-isa.ts evaluateIsaEligibility). `no_response` and `appointment_set` had NONE, while
 * the ISA radar's "stalled" tile (app/dashboard/isa/page.tsx), the analytics "appointment set" row,
 * the campaigns' Qualification Outcomes, the newly-converted panel's "Confirm appointment" action and
 * two manager counters (lib/managers/deliberation.ts, cross-referral.ts) all read them — a blind meter
 * that could only ever say 0.
 *
 * THE OUTCOME PATHS that now stamp through here (one writer, one vocabulary — §6):
 *   · no_response     — lib/ai-isa/ghost-reengagement.ts runGhostReengagement: an unconverted lead
 *                       the ghost detector swept (idle past the brokerage's threshold) with NO reply
 *                       on record;
 *   · appointment_set — lib/ai-isa/listing-appointment.ts bookListingAppointment (the ISA's booked
 *                       hold), lib/ai-isa/book-seller-appointment.ts bookSellerListingAppointment, and
 *                       lib/kernel/ai-isa.ts recordAiIsaOutcome(outcome 'appointment_set').
 *
 * THE RULE (pure — lib/ai-isa/qualification-core.ts nextQualificationResult): the LATEST row for the
 * person (lead first, then contact) is updated; appointment_set overwrites anything but itself;
 * no_response only overwrites "still being worked" (null / needs_follow_up) — a verdict is never
 * downgraded. No row yet → one is inserted (the radar counts people the ISA worked, not only people
 * the evaluator happened to score). qualified_at is the outcome's timestamp (the outcomes reader
 * windows on it).
 *
 * HONEST: every read and write destructures its error; the update is `.select("id")`-counted (a
 * zero-row update is a refusal, CLAUDE.md §3). Server-only; the caller hands a VERIFIED brokerageId
 * (its own row's tenant) and the service client.
 */
import "server-only"
import { nextQualificationResult, type QualificationResult } from "./qualification-core"

export type QualificationOutcomeStampResult =
  | { ok: true; mode: "inserted" | "updated" | "unchanged"; rowId: string | null; result: QualificationResult | null }
  | { ok: false; error: string }

export async function stampQualificationOutcome(
  svc: any,
  args: { brokerageId: string; leadId?: string | null; contactId?: string | null; result: QualificationResult; note?: string | null },
): Promise<QualificationOutcomeStampResult> {
  const { brokerageId, result } = args
  const leadId = args.leadId ?? null
  const contactId = args.contactId ?? null
  if (!brokerageId) return { ok: false, error: "qualification stamp refused: no brokerageId" }
  if (!leadId && !contactId) return { ok: false, error: "qualification stamp refused: neither a lead nor a contact to stamp" }

  // The latest row for the person — lead side first (the ISA works leads), then the contact side.
  let latest: { id: string; qualification_result: string | null } | null = null
  for (const [col, id] of [["lead_id", leadId], ["contact_id", contactId]] as const) {
    if (!id || latest) continue
    const { data, error } = await svc
      .from("ai_isa_qualifications")
      .select("id, qualification_result, qualified_at")
      .eq("brokerage_id", brokerageId)
      .eq(col, id)
      .order("qualified_at", { ascending: false })
      .limit(1)
    // A refused read is not "no row" — inserting on it could double the person.
    if (error) return { ok: false, error: `qualification read refused: ${error.message}` }
    const row = ((data ?? []) as Array<{ id: string; qualification_result: string | null }>)[0]
    if (row) latest = row
  }

  const now = new Date().toISOString()
  if (!latest) {
    const { data, error } = await svc
      .from("ai_isa_qualifications")
      .insert({
        brokerage_id: brokerageId,
        lead_id: leadId,
        contact_id: contactId,
        qualification_result: result,
        qualified_at: now,
        notes: args.note ? String(args.note).slice(0, 2000) : null,
      })
      .select("id")
      .maybeSingle()
    if (error) return { ok: false, error: `qualification insert refused: ${error.message}` }
    if (!data) return { ok: false, error: "qualification insert returned no row" }
    return { ok: true, mode: "inserted", rowId: (data as { id: string }).id, result }
  }

  const next = nextQualificationResult(latest.qualification_result, result)
  if (!next) return { ok: true, mode: "unchanged", rowId: latest.id, result: (latest.qualification_result as QualificationResult | null) ?? null }

  const patch: Record<string, unknown> = { qualification_result: next, qualified_at: now }
  if (contactId) patch.contact_id = contactId
  const { data: updated, error: upErr } = await svc
    .from("ai_isa_qualifications")
    .update(patch)
    .eq("id", latest.id)
    .eq("brokerage_id", brokerageId)
    .select("id")
  if (upErr) return { ok: false, error: `qualification update refused: ${upErr.message}` }
  if (!(updated ?? []).length) return { ok: false, error: `qualification update matched no row (${latest.id} in brokerage ${brokerageId})` }
  return { ok: true, mode: "updated", rowId: latest.id, result: next }
}
