// app/leads/[leadId]/page.tsx
// Minimal lead detail surface — shows identity + ISA state and the lead quick-actions panel.
// `leads` are platform OR brokerage-scoped (NEVER agent-assigned in the canonical flow). The
// QuickActions server actions enforce the matching auth gate so this page can render without
// per-row authorization in the page itself.
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { LeadQuickActions } from "@/components/lead/LeadQuickActions"
import { LeadReadinessPanel } from "@/components/lead/LeadReadinessPanel"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ leadId: string }>
}

export default async function LeadDetailPage({ params }: PageProps) {
  const { leadId } = await params
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) redirect("/login")

  const svc = createServiceClient()
  const { data: lead } = await svc.from("leads")
    .select("id, brokerage_id, first_name, last_name, email, phone, mailing_address, mailing_city, mailing_state, mailing_zip, email_verified, mailing_address_verified, lead_stage, lifecycle_state, ai_isa_owner, is_active, created_at")
    .eq("id", leadId).maybeSingle()
  if (!lead) {
    return <div className="p-6 text-sm text-muted-foreground">Lead not found.</div>
  }

  // ACCESS POLICY (owner): LEADS = BROKERAGE + PLATFORM ONLY. Page-level gate
  // (mirrors the canonical lead scoping rule used inside the server actions):
  // platform admin / staff → always. Brokerage-LEVEL roles (broker/admin family)
  // → only when brokerage_id matches. Agents, team leads, TCs and compliance
  // officers do NOT reach lead rows — agents work CONTACTS only (post-promotion).
  const { data: profile } = await svc.from("users")
    .select("user_type, platform_role, brokerage_id").eq("id", user.id).maybeSingle()
  const isPlatform = profile?.user_type === "superadmin" || isPlatformStaff(profile?.platform_role)
  const BROKERAGE_ROLES = new Set(["broker","broker_owner","broker_admin","admin"])
  const isBrokerageMatch =
    !!profile?.user_type && BROKERAGE_ROLES.has(profile.user_type)
    && !!profile?.brokerage_id && profile.brokerage_id === lead.brokerage_id
  const allowed = isPlatform || isBrokerageMatch
  if (!allowed) redirect("/dashboard")

  const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "(unnamed lead)"
  const addr = [lead.mailing_address, lead.mailing_city, lead.mailing_state, lead.mailing_zip].filter(Boolean).join(", ")

  return (
    <div className="p-6 space-y-4 max-w-3xl">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{fullName}</h1>
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
          <Badge variant="outline">{lead.lead_stage ?? "no stage"}</Badge>
          <Badge variant="outline">{lead.lifecycle_state ?? "unconsented"}</Badge>
          {lead.ai_isa_owner && <Badge variant="default">AI ISA owner</Badge>}
          {!lead.is_active && <Badge variant="destructive">Inactive</Badge>}
          {lead.brokerage_id
            ? <span>Brokerage-scoped</span>
            : <span>Platform-scoped</span>}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Identity</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1">
          <div className="flex gap-2"><span className="text-muted-foreground w-24">Email</span> <span>{lead.email ?? "—"}</span></div>
          <div className="flex gap-2"><span className="text-muted-foreground w-24">Phone</span> <span>{lead.phone ?? "—"}</span></div>
          <div className="flex gap-2"><span className="text-muted-foreground w-24">Address</span> <span>{addr || "—"}</span></div>
        </CardContent>
      </Card>

      <LeadReadinessPanel leadId={lead.id} />

      <LeadQuickActions
        leadId={lead.id}
        hasEmail={!!lead.email}
        hasAddress={!!lead.mailing_address}
        emailVerified={lead.email_verified ?? null}
        addressVerified={lead.mailing_address_verified ?? null}
      />
    </div>
  )
}
