"use server"

/**
 * app/actions/contacts/segment-membership.ts — THE DIRECT DOOR onto
 * `contact_segments`.
 *
 * The workflow steps (lib/workflow/adapters/segment-ops.ts) are the AUTOMATED
 * way on and off a marketing segment. This is the MANUAL one: an agent looking
 * at a contact who says "take me off the seller list" needs to be able to do it
 * now, without building a workflow. Before this existed, nothing in the product
 * — automated or manual — could write `removed_at`, so a segment-targeted
 * campaign kept reaching every contact ever added.
 *
 * ── TENANCY (§4) ────────────────────────────────────────────────────────────
 * `brokerageId` is NOT an input. It is read off the contact row that
 * `assertCanActOnContact` returns, and that gate resolves the caller through
 * getAgentContext (re-validating any impersonation grant on this call) before
 * it hands anything back. A body-supplied brokerage on a service client is the
 * IDOR shape this repo keeps finding; the only way to reach a membership here
 * is to be allowed to act on the contact that owns it.
 *
 * The gate's default intent is "write" — deliberately not overridden, so a
 * read_only act-as grant and non-impersonating platform staff are both refused.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Not an opt-out. Removing someone from a list is audience curation; consent
 * lives in `contact_suppression_list` / `contacts.email_unsubscribed` and is
 * enforced on every send by lib/kernel/compliance/check-suppression.ts. The
 * boundary and the reasoning are written up at the survivor,
 * lib/marketing/segment-membership.ts.
 */

import { revalidatePath } from "next/cache"
import { assertCanActOnContact } from "@/lib/auth/contact-access"
import { removeContactFromSegment } from "@/lib/marketing/segment-membership"

export async function removeContactFromSegmentAction(input: {
  contactId: string
  segmentId: string
}): Promise<{ ok: true; alreadyRemoved: boolean } | { ok: false; error: string }> {
  if (!input?.contactId || !input?.segmentId) {
    return { ok: false, error: "Contact and segment are both required." }
  }

  const gate = await assertCanActOnContact(input.contactId)
  if (!gate.ok) return { ok: false, error: gate.error }

  // Fail closed: a contact with no brokerage cannot be tenant-scoped, and an
  // untenanted UPDATE on a service client is exactly the seam this gate exists
  // to shut. Refuse rather than widen the predicate.
  const brokerageId = gate.contact.brokerage_id
  if (!brokerageId) {
    return { ok: false, error: "This contact has no brokerage — refusing an untenanted segment write." }
  }

  const result = await removeContactFromSegment({
    contactId: input.contactId,
    segmentId: input.segmentId,
    brokerageId,
  })

  // §3: zero matched rows resolves identically to a successful write, so the
  // library resolves what zero MEANT and the answer is passed through honestly
  // instead of being rendered as "removed".
  if (!result.success) {
    return { ok: false, error: result.error ?? "The segment membership could not be closed." }
  }

  revalidatePath(`/crm/contacts/${input.contactId}`)
  return { ok: true, alreadyRemoved: result.state === "already_removed" }
}
