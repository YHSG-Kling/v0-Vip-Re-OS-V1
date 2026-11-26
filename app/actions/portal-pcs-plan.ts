"use server"

/**
 * app/actions/portal-pcs-plan.ts — THE PORTAL DOOR OF THE PCS / RELOCATION PLANNER (wave 153, lane 153K — convergence row 61).
 *
 * The one public endpoint: the person moving asks for their own move plan from the portal journey (the military persona's
 * "PCS Planning" stage). GATE FIRST (CLAUDE.md §4): requireContactAccess resolves the tenant from the CONTACT ROW and whether the
 * caller IS the person; only then does the service client run, inside lib/relocation/pcs-portal-door.ts, which refuses a staff
 * caller (the consent is the person's), refuses without consent, and records a stated report date through the canonical movement
 * writer. Nothing in the request body names a tenant.
 */

import { revalidatePath } from "next/cache"

export async function planMyPcsMove(input: {
  contactId: string
  consentGiven: boolean
  destinationLabel: string
  installationName?: string | null
  destinationState?: string | null
  reportDate?: string | null
  bahMonthly?: number | null
  vaInterest?: boolean
  spouseLicensedOccupation?: string | null
  currentHome?: { value?: number | null; mortgageBalance?: number | null; monthlyPayment?: number | null; expectedRent?: number | null } | null
}) {
  const contactId = String(input?.contactId ?? "")
  const { requireContactAccess, accessRefusal } = await import("@/lib/portal/require-contact-access")
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { ok: false as const, message: accessRefusal(access.error) }
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { planPcsMoveForPortalContact } = await import("@/lib/relocation/pcs-portal-door")
    const r = await planPcsMoveForPortalContact(createServiceClient(), { brokerageId: access.brokerageId, contactId, userId: access.userId, isContactSelf: access.isContactSelf }, input)
    if (!r.ok) return { ok: false as const, message: r.message }
    if (r.statedDate.status === "recorded") revalidatePath(`/portal/${contactId}/journey`)
    const dateLine = r.statedDate.status === "recorded" ? "Your report date is on file, so your agent's timing follows it."
      : r.statedDate.status === "replayed" ? "Your report date was already on file."
      : r.statedDate.status === "refused" ? "Your plan is ready, but your report date was not saved. Tell your agent the date in a message."
      : null
    if (r.statedDate.status === "refused") console.warn(`[portal-pcs-plan] contact ${contactId}: stated report date not recorded — ${r.statedDate.detail}`)
    return { ok: true as const, plan: r.plan, dateLine, notes: r.notes }
  } catch (e) {
    console.error("[portal-pcs-plan] threw:", e instanceof Error ? e.message : String(e))
    return { ok: false as const, message: "Your plan could not be built just now. Nothing was saved. Try again in a moment." }
  }
}
