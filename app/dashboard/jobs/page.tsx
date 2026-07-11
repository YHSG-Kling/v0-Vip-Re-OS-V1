/**
 * app/dashboard/jobs/page.tsx — THE JOBS SURFACE (program item #2):
 * agents think in JOBS, not managers. Three one-click plays over the
 * rails that already run autonomously — each card names what the AI team
 * will do in plain language, runs it on demand with every existing gate
 * intact, and reports back what ACTUALLY happened (real runner counts,
 * idempotent by construction — re-running can't double-produce).
 */
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { JOB_CATALOG } from "@/lib/kernel/jobs"
import { JobsClient } from "./jobs-client"
import { createServiceClient } from "@/lib/supabase/service"
import { rankSphereActions } from "@/lib/sphere/next-best-actions"

export const dynamic = "force-dynamic"

export default async function JobsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // The agent's active listings for the listing-kit picker (RLS-scoped).
  const { data: listings } = await supabase
    .from("listings")
    .select("id, address, city, lifecycle_stage")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(50)

  // THE RANKED SPHERE LIST (program item #4) — who to work today and WHY,
  // from real signals (life events, value checks, anniversaries, quiet
  // clients). Scoped to the agent when they have an agents row.
  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const { data: agentRow } = await supabase.from("agents").select("id").eq("user_id", user.id).maybeSingle()
  const sphereActions = profile?.brokerage_id
    ? await rankSphereActions(createServiceClient(), {
        brokerageId: profile.brokerage_id,
        agentId: (agentRow as { id: string } | null)?.id ?? null,
        limit: 6,
      }).catch(() => [])
    : []

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Jobs</h1>
      <p className="text-sm text-muted-foreground mt-1">
        One click, the whole team moves. Every job runs through the same approval gates as always — nothing publishes or spends without you.
      </p>
      <JobsClient
        catalog={JOB_CATALOG}
        listings={((listings ?? []) as Array<{ id: string; address: string | null; city: string | null }>).map((l) => ({
          id: l.id,
          label: [l.address, l.city].filter(Boolean).join(", ") || l.id,
        }))}
        sphereActions={sphereActions}
      />
    </div>
  )
}
