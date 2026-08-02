import { redirect } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { determinePortalView } from "@/lib/kernel/portal"
import { getAlertResults } from "@/app/actions/property-alerts/alert-actions"
import { AlertMatchList } from "./alert-match-list"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { ArrowLeft, BellRing } from "lucide-react"

/**
 * THE BUYER'S LANDING PAGE FOR A PROPERTY ALERT — it did not exist.
 *
 * lib/property-alerts/alert-notifier.ts builds `${APP_URL}/portal/alerts/${id}`
 * and uses it as the PRIMARY CTA of every alert email ("View All Matches"), as
 * the settings link, and as the entire body of the alert SMS. `app/portal/alerts`
 * has never existed — every portal route is `[contactId]`-scoped, because that
 * is how portal access is gated. So every buyer who tapped the link in an alert
 * we sent them got a 404.
 *
 * The second CTA was worse: it pointed at `/crm/contacts/{id}/tours`, an
 * AGENT-ONLY CRM route. Both are corrected in the notifier to contact-scoped
 * portal paths, and this is the page the first one now lands on.
 *
 * Auth is the portal's own model — determinePortalView resolves the session
 * against the contact — and the alert is then re-checked to belong to THIS
 * contact, so a valid portal session for one buyer cannot read another's alert
 * by swapping the id in the URL.
 */
export default async function PortalAlertPage({
  params,
}: {
  params: Promise<{ contactId: string; alertId: string }>
}) {
  const { contactId, alertId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/portal/login")

  const view = await determinePortalView(supabase, { contactId })
  if (!view) redirect("/portal/login")

  // The alert must belong to THIS contact. Without this, a buyer with a valid
  // portal session could read any alert in the system by editing the URL.
  const { data: alert } = await supabase
    .from("property_alerts")
    .select("id, alert_name, contact_id, frequency, is_active")
    .eq("id", alertId)
    .eq("contact_id", contactId)
    .maybeSingle()

  if (!alert) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <p className="text-sm text-muted-foreground">
              This alert is no longer available.
            </p>
            <Link href={`/portal/${contactId}/properties`}>
              <Button variant="outline" size="sm">Browse your matches</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  const res = await getAlertResults(alertId, { limit: 50 })
  const results = res.success ? (res.results as any[]) : []

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      <Link
        href={`/portal/${contactId}/properties`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> All properties
      </Link>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <BellRing className="h-5 w-5 text-primary" />
            {alert.alert_name ?? "Your property alert"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {results.length === 0
              ? "No matches yet — we'll let you know the moment something fits."
              : `${results.length} home${results.length === 1 ? "" : "s"} matching what you're looking for.`}
          </p>
        </CardHeader>
        <CardContent>
          {/* Opening a match marks it viewed — the signal the agent's unviewed
              badge reads. It had no caller anywhere, so the count only ever grew. */}
          <AlertMatchList contactId={contactId} results={results} />
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Want different homes?{" "}
        <Link href={`/portal/${contactId}/settings`} className="underline">
          Adjust your alert settings
        </Link>
      </p>
    </div>
  )
}
