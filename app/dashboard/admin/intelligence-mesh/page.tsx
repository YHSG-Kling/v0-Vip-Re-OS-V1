import { redirect } from "next/navigation"
import Link from "next/link"
import { ChevronLeft, Brain } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { getBrokerageInsights } from "@/app/actions/brokerage-intelligence"
import { IntelligenceMeshClient } from "./intelligence-mesh-client"

/**
 * /dashboard/admin/intelligence-mesh
 *
 * Broker / admin / team_lead surface. Lists open + recently-dismissed +
 * superseded brokerage intelligence insights with one-click adopt.
 */
export default async function IntelligenceMeshPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()

  const allowed = new Set(["superadmin","broker","broker_admin","admin","team_lead"])
  if (!allowed.has(profile?.user_type ?? "")) redirect("/dashboard")

  // Load all open + recently dismissed for triage
  const [openRes, dismissedRes] = await Promise.all([
    getBrokerageInsights({ status: "open",      limit: 30 }),
    getBrokerageInsights({ status: "dismissed", limit: 15 }),
  ])

  // Hydrate brokerage agent list for the per-insight adopt picker.
  let agents: Array<{ id: string; first_name: string | null; last_name: string | null }> = []
  if (profile?.brokerage_id) {
    const { data: agentRows } = await supabase
      .from("users")
      .select("id, first_name, last_name")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("user_type", "agent")
    agents = (agentRows ?? []) as typeof agents
  }

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-border bg-background sticky top-0 z-10">
        <Link
          href="/dashboard/admin"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Admin
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium text-foreground flex items-center gap-1.5">
          <Brain className="h-4 w-4 text-violet-600" />
          Brokerage Intelligence Mesh
        </span>
      </div>

      <div className="flex-1 overflow-auto p-6 max-w-5xl space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Patterns mined from your brokerage&apos;s data</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Top-quartile agent behaviors vs. bottom-quartile, with the playbook required to close the gap. Adopt a pattern in one click — every selected agent inherits the winning configuration.
          </p>
        </div>

        <IntelligenceMeshClient
          open={openRes.insights ?? []}
          dismissed={dismissedRes.insights ?? []}
          agents={agents.map((a) => ({
            id: a.id,
            name: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Unnamed agent",
          }))}
        />
      </div>
    </div>
  )
}
