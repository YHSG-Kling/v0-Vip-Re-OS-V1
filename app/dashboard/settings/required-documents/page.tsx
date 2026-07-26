import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { RequiredDocsSettingsClient } from "./required-docs-settings-client"
import { RequiredDocRowActions } from "./required-doc-row-actions"
import { getSupportedPresetStates } from "@/lib/compliance/required-doc-presets"

export const dynamic = "force-dynamic"

const ADMIN_ROLES = ["broker","broker_admin","admin","superadmin","compliance_manager","compliance_officer","team_lead","agent"]

export default async function RequiredDocsSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, team_id, user_type, first_name, last_name")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) redirect("/dashboard")
  if (!ADMIN_ROLES.includes(profile.user_type as string)) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card><CardHeader><CardTitle>Required documents</CardTitle></CardHeader>
        <CardContent>You don't have permission. Only broker / compliance_manager / compliance_officer / team_lead / agent can edit.</CardContent></Card>
      </div>
    )
  }

  // List all rules visible to this brokerage
  const { data: rules } = await supabase
    .from("brokerage_required_documents")
    .select("id, scope_type, scope_id, classification, deal_type, state_code, is_required, block_on_missing, description, created_at")
    .eq("brokerage_id", profile.brokerage_id)
    .order("scope_type", { ascending: false })
    .order("classification", { ascending: true })

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Required documents</h1>
        <p className="text-sm text-muted-foreground">
          The documents your deals must have on file before submitting to compliance. Rules cascade
          agent → team → brokerage (most specific wins per classification).
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Active rules ({(rules ?? []).length})</CardTitle></CardHeader>
        <CardContent>
          {(!rules || rules.length === 0) ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No rules yet. Pick your state below and click "Seed defaults" to load the US baseline plus your state's standard requirements.
            </p>
          ) : (
            <ul className="divide-y">
              {rules.map((r: any) => (
                <li key={r.id} className="py-3 flex items-start gap-3">
                  <Badge variant="outline" className="shrink-0 mt-0.5">
                    {r.scope_type}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium">{r.classification}</p>
                      <Badge variant="secondary" className="text-xs">{r.deal_type}</Badge>
                      {r.state_code && <Badge variant="secondary" className="text-xs">{r.state_code}</Badge>}
                      {r.block_on_missing
                        ? <Badge className="bg-red-100 text-red-900 text-xs">blocking</Badge>
                        : <Badge className="bg-amber-100 text-amber-900 text-xs">warning</Badge>}
                    </div>
                    {r.description && <p className="text-xs text-muted-foreground mt-1">{r.description}</p>}
                  </div>
                  <RequiredDocRowActions id={r.id as string} blockOnMissing={!!r.block_on_missing} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <RequiredDocsSettingsClient
        brokerageId={profile.brokerage_id as string}
        teamId={(profile.team_id as string | null) ?? null}
        userId={user.id}
        userType={profile.user_type as string}
        supportedStates={getSupportedPresetStates()}
      />
    </div>
  )
}
