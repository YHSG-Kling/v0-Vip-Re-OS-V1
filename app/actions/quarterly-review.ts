"use server"

/**
 * app/actions/quarterly-review.ts — thin principal-gated wrapper over the
 * ONE QBR loader (lib/intelligence/quarterly-review-loader.ts) shared with
 * the spoken quarterly_review verb. Tier-parity principal access.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isTenancyPrincipal } from "@/lib/kernel/tenancy-principal"
import { loadQuarterlyReview } from "@/lib/intelligence/quarterly-review-loader"
import type { QuarterlyReview } from "@/lib/intelligence/quarterly-review"
import type { PulseEntry } from "@/lib/intelligence/adoption-pulse"

export async function getQuarterlyReviewAction(): Promise<
  | { ok: true; review: QuarterlyReview; pulse: PulseEntry[] }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  // user_type, never legacy users.role — PRINCIPAL_ROLES is user_type vocabulary.
  const { data: me } = await supabase.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  const brokerageId = (me as any)?.brokerage_id as string | null
  if (!brokerageId) return { ok: false, error: "No brokerage" }
  const svc = createServiceClient()
  const principal = await isTenancyPrincipal(svc, { userId: user.id, brokerageId, role: String((me as any)?.user_type ?? "") })
  if (!principal) return { ok: false, error: "Principals only" }

  const { review, pulse } = await loadQuarterlyReview(svc, brokerageId)
  return { ok: true, review, pulse }
}
