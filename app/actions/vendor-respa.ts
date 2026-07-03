"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import {
  recordVendorDisclosureAcknowledgment,
  logVendorDisclosureShown,
} from "@/lib/compliance/vendor-respa"

/**
 * Client acknowledges an AfBA (Affiliated Business Arrangement) RESPA disclosure before a settlement
 * vendor's contact info is revealed. Records the immutable acknowledgment on the compliance ledger.
 * Called from the portal RespaAckGate. Returns { ok } so the gate can reveal contact on success.
 */
export async function acknowledgeVendorDisclosureAction(input: {
  contactId: string
  vendorId: string
  disclosureType: "afba" | "preferred_settlement" | "preferred_general"
}): Promise<{ ok: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Resolve the contact's brokerage (portal contacts are the acting party here).
  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("id, brokerage_id")
    .eq("id", input.contactId)
    .maybeSingle()
  const brokerageId = (contact as { brokerage_id?: string } | null)?.brokerage_id
  if (!brokerageId) return { ok: false }

  // Log the disclosure as shown (idempotent per day) then record the acknowledgment.
  await logVendorDisclosureShown(svc, {
    brokerageId,
    vendorId: input.vendorId,
    contactId: input.contactId,
    actorUserId: user?.id ?? null,
    actorRole: "client",
    disclosureType: input.disclosureType,
  })
  const { recorded } = await recordVendorDisclosureAcknowledgment(svc, {
    brokerageId,
    vendorId: input.vendorId,
    contactId: input.contactId,
    actorUserId: user?.id ?? null,
    actorRole: "client",
    disclosureType: input.disclosureType,
  })
  return { ok: recorded }
}
