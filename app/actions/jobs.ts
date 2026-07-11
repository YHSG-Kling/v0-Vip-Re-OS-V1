"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runJob, type JobKey, type JobRunResult } from "@/lib/kernel/jobs"

/** Run a one-click job for the signed-in agent. RLS-scoped listing check
 *  first (a cross-tenant listing id resolves to nothing), then the job
 *  rides the service client exactly like the crons that share its rails. */
export async function runJobAction(input: { job: JobKey; listingId?: string | null }): Promise<JobRunResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, job: input.job, results: [], error: "Not authenticated" }

  const { data: profile } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = (profile as { brokerage_id: string | null } | null)?.brokerage_id
  if (!brokerageId) return { ok: false, job: input.job, results: [], error: "No brokerage on your profile" }

  if (input.listingId) {
    const { data: visible } = await supabase
      .from("listings").select("id").eq("id", input.listingId).maybeSingle()
    if (!visible) return { ok: false, job: input.job, results: [], error: "Listing not found" }
  }

  return runJob(createServiceClient(), {
    job: input.job,
    brokerageId,
    agentUserId: user.id,
    listingId: input.listingId ?? null,
  })
}
