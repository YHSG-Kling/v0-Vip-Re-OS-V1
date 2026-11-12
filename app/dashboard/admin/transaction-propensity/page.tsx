import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Flame, TrendingUp } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { rankContactsByPropensity } from "@/lib/ai-isa/transaction-propensity"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

/**
 * LIKELY TO TRANSACT (90 days) — the AI ISA's signal-fusion ranking. Independent
 * signals (intent, engagement, equity, life events, referral, recency) fused into one
 * transparent score so the ISA (and the broker) know WHO to re-engage first. Every
 * score carries its top contributing reasons — no black box.
 */
function bandTone(band: string): string {
  return band === "hot" ? "bg-red-100 text-red-800"
    : band === "warm" ? "bg-amber-100 text-amber-800"
    : band === "cool" ? "bg-blue-100 text-blue-800"
    : "bg-slate-100 text-slate-600"
}

export default async function TransactionPropensityPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return <div className="p-6 text-red-600">Brokerage not configured</div>
  if (!isAdminOrBroker({ user_type: profile.user_type ?? "" })) {
    return <div className="p-6 text-red-600">Forbidden</div>
  }

  // Only surface contacts with a real signal (score ≥ 25 = cool+).
  const ranked = await rankContactsByPropensity({ brokerageId: profile.brokerage_id, limit: 100, minScore: 25 })

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Flame className="h-6 w-6 text-red-500" /> Likely to Transact — next 90 days
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          The AI ISA fuses intent, engagement, equity, life events, referral and recency into one
          transparent score. Re-engage the top of the list first.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4" /> {ranked.length} prioritized contact{ranked.length === 1 ? "" : "s"}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {ranked.length === 0 ? (
            <p className="text-sm text-muted-foreground">No contacts with a meaningful transaction signal yet. As enrichment + engagement accrue, they rank here.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-3">Contact</th>
                  <th className="py-2 pr-3">Score</th>
                  <th className="py-2 pr-3">Band</th>
                  <th className="py-2 pr-3">Why</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((r) => (
                  <tr key={r.contactId} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{r.name}</td>
                    <td className="py-2 pr-3 font-semibold">{r.result.score}</td>
                    <td className="py-2 pr-3"><Badge className={bandTone(r.result.band)}>{r.result.band}</Badge></td>
                    <td className="py-2 pr-3 text-muted-foreground">{r.result.topReasons.join(" · ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
