"use server"

// THE FINAL-VERSION RECORD, READ (wave 145, lane 145Z — test:readerless-writes; owner ruling 20 "track the approved final
// version actually sent/published"). The doors write distribution_finals (lib/marketing/humanize-final.ts: the staged text and
// its brand line / logo, who was told, who approved it, what they accepted, what went out); this is the screen's read of that
// record — the Content Approvals page's "Final versions" tab. Tenant from the SESSION (§4), read on the session client (the
// m866 tenant-read policy), the seat checked first (the brokerage's operational admin roster — the people who approve and
// review what goes out). Fail closed: a refused read is said, never an empty list.
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { listDistributionFinals, DISTRIBUTION_FINAL_STATUSES, type DistributionFinalRecord, type DistributionFinalStatus } from "@/lib/marketing/humanize-final"

export async function getDistributionFinalsAction(input?: { status?: string | null; limit?: number }): Promise<
  { ok: true; finals: DistributionFinalRecord[] } | { ok: false; error: string }
> {
  const identity = await getAgentContext()
  if (!identity.isAuthenticated || !identity.brokerageId || !identity.userId) return { ok: false, error: "Not signed in to a brokerage" }
  if (!TENANT_ADMIN_USER_TYPES.has(identity.userType)) return { ok: false, error: "The final-version record is for the brokerage's approvers and compliance reviewers" }
  const status = input?.status && (DISTRIBUTION_FINAL_STATUSES as readonly string[]).includes(input.status) ? (input.status as DistributionFinalStatus) : null
  if (input?.status && !status) return { ok: false, error: `"${input.status}" is not a final-version status` }
  const supabase = await createClient()
  return listDistributionFinals(supabase as never, { brokerageId: identity.brokerageId, status, limit: input?.limit })
}
