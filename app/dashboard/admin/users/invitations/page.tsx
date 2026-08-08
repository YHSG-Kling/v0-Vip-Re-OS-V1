import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Mail, Clock, CheckCircle2, X, AlertTriangle, UserPlus } from "lucide-react"
import { listPendingInvitationsAction } from "@/app/actions/admin/invitations"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { InvitationsTable } from "./invitations-table"
import { SetupCompleteCard } from "./setup-complete-card"

export const dynamic = "force-dynamic"

function statusBadge(s: string) {
  switch (s) {
    case "pending":  return <Badge className="bg-amber-100 text-amber-800"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
    case "accepted": return <Badge className="bg-emerald-100 text-emerald-800"><CheckCircle2 className="h-3 w-3 mr-1" />Accepted</Badge>
    case "expired":  return <Badge className="bg-slate-100 text-slate-700"><AlertTriangle className="h-3 w-3 mr-1" />Expired</Badge>
    case "revoked":  return <Badge className="bg-red-100 text-red-800"><X className="h-3 w-3 mr-1" />Revoked</Badge>
    default:         return <Badge variant="outline">{s}</Badge>
  }
}

export default async function InvitationsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const r = await listPendingInvitationsAction()
  if (!r.ok) {
    return <div className="p-6 text-red-600">Failed to load invitations: {r.error}</div>
  }

  // Current brokerage onboarding status for the setup-complete card below.
  // Cookie client — RLS scopes both reads to the caller's own tenant; the page
  // never names a brokerage, and the action re-derives it from the session.
  // A refused read leaves the status null and the card shows the safe default
  // rather than claiming setup is finished.
  const { data: meRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  let onboardingStatus: string | null = null
  if (meRow?.brokerage_id) {
    const { data: brk } = await supabase
      .from("brokerages").select("onboarding_status").eq("id", meRow.brokerage_id).maybeSingle()
    onboardingStatus = (brk?.onboarding_status as string | null) ?? null
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            User invitations
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Track who&apos;s been invited and who&apos;s onboarded. Revoke pending invites that should never have been sent.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline">
            <Mail className="h-3 w-3 mr-1" />
            {r.pending_count} pending
          </Badge>
          <Badge className="bg-emerald-100 text-emerald-800">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            {r.accepted_count} accepted
          </Badge>
        </div>
      </div>

      <SetupCompleteCard initialStatus={onboardingStatus} pendingCount={r.pending_count ?? 0} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Invitation log</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <InvitationsTable initialRows={r.rows} statusBadge={statusBadge as unknown as (s: string) => React.ReactNode} />
        </CardContent>
      </Card>
    </div>
  )
}
