import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Phone, ShieldCheck } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { DialBatchClient } from "./dial-batch-client"

export const dynamic = "force-dynamic"

/**
 * VOICE ISA DIAL-BATCH GATE — the AI ISA's governed outbound calling. The ISA proposes a
 * batch of CONSENTED high-propensity contacts to call; a human approves; consent is
 * RE-CHECKED at approval before any dial. Voice is contacts-only (explicit TCPA consent +
 * ISA re-engage permission) so the rule is unambiguous.
 */
export default async function VoiceDialBatchesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return <div className="p-6 text-red-600">Brokerage not configured</div>
  if (!["broker", "broker_admin", "admin", "superadmin", "team_lead"].includes(profile.user_type ?? "")) {
    return <div className="p-6 text-red-600">Forbidden</div>
  }

  const svc = createServiceClient()
  const { data: batches } = await svc
    .from("ai_isa_call_batches")
    .select("id, status, script, target_contacts, proposed_count, dialed_count, proposed_at, completed_at")
    .eq("brokerage_id", profile.brokerage_id)
    .order("proposed_at", { ascending: false })
    .limit(50)

  const rows = (batches ?? []).map((b: any) => ({
    id: b.id, status: b.status, script: b.script,
    proposedCount: b.proposed_count ?? 0, dialedCount: b.dialed_count,
    proposedAt: b.proposed_at, completedAt: b.completed_at,
    targets: (b.target_contacts ?? []) as Array<{ name: string; propensity_score: number }>,
  }))

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Phone className="h-6 w-6 text-indigo-600" /> AI ISA Dial Batches
        </h1>
        <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1">
          <ShieldCheck className="h-3.5 w-3.5 text-green-600" />
          Only TCPA-consented, ISA-reengage-permitted contacts are dialed — and consent is re-checked the
          moment you approve, so a contact who opts out in the meantime is silently dropped.
        </p>
      </div>
      <DialBatchClient initialBatches={rows} />
    </div>
  )
}
