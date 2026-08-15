import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { listNotificationRules } from '@/app/actions/settings/list-notification-rules'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Settings, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { ProhibitedPhrasesPanel } from '@/app/dashboard/settings/components/prohibited-phrases-panel'

/**
 * Compliance settings.
 *
 * The "Notification Preferences" card used to render four HARDCODED strings
 * ("New violation detected", "Pending approval > 24hrs", …) each with a
 * "Configure" button that did nothing — it described a preference store that
 * does not exist under those names. The real store is `notification_rules`
 * (listNotificationRules → lib/kernel/notification-rules), edited by the real
 * rules manager at /settings/notifications. This page now shows the rules that
 * actually exist for compliance events and hands each one to that editor.
 */

/** trigger_event values the kernel actually emits for compliance-shaped events
 *  (lib/kernel/events.ts: COMPLIANCE_VIOLATION, AUTHORITY_BLOCKED,
 *  BRAND_COMPLIANCE_FAILED/PASSED) plus certification/licence wording used by
 *  brokerage rules. Matching is substring-based because rule authors type the
 *  trigger by hand in NotificationRulesForm. */
const COMPLIANCE_TRIGGER_HINTS = [
  'compliance',
  'violation',
  'authority_blocked',
  'certification',
  'license',
  'approval',
  'audit',
]

export default async function ComplianceSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const allRules = await listNotificationRules()
  const complianceRules = allRules.filter((r) =>
    COMPLIANCE_TRIGGER_HINTS.some(
      (hint) =>
        r.trigger_event?.toLowerCase().includes(hint) ||
        r.rule_name?.toLowerCase().includes(hint),
    ),
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/compliance">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="w-6 h-6" />
          Compliance Settings
        </h1>
      </div>
      {/* THE BROKERAGE'S OWN PROHIBITED WORDS.
          Owner's ruling: "the users can also add in their settings prohibited
          words." This is the compliance settings surface the settings command
          strip already points at (settings-command-strip.tsx: Compliance →
          /compliance/settings), so the words live where a broker looking for
          compliance settings actually lands — rather than behind a second,
          parallel compliance route.
          It matters that they are HERE and not only on /dashboard/settings:
          that page redirects any user_type outside broker/admin, while the RLS
          write predicate on prohibited_phrases also admits
          is_compliance_officer_role() — compliance_officer / compliance_manager.
          Those roles can reach this page and no other settings surface. The
          panel itself resolves the caller and the brokerage from the session and
          hides its controls when the caller may not write. */}
      <ProhibitedPhrasesPanel />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compliance Notification Rules</CardTitle>
          <CardDescription>
            Rules on this brokerage whose trigger looks like a compliance event. Editing,
            adding and deactivating happen in the notification rules manager.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {complianceRules.length === 0 ? (
            // Stated as OBSERVED, not diagnosed: listNotificationRules returns an
            // empty array both when a brokerage has no rules and when the reader
            // is refused, and this page cannot tell those apart.
            <p className="text-sm text-gray-500">
              No compliance notification rules were returned for this account
              {allRules.length > 0
                ? ` (${allRules.length} rule${allRules.length === 1 ? '' : 's'} returned in total, none matching a compliance trigger).`
                : '.'}{' '}
              Rules are listed and edited in the notification rules manager.
            </p>
          ) : (
            complianceRules.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between py-2 border-b last:border-0 gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{rule.rule_name}</p>
                  <p className="text-xs text-gray-500 truncate">
                    on {rule.trigger_event} · {rule.notification_type} · to {rule.recipient_role}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={rule.is_active ? 'default' : 'outline'} className="text-xs">
                    {rule.is_active ? 'Active' : 'Paused'}
                  </Badge>
                  <Link href="/settings/notifications">
                    <Button variant="outline" size="sm">Configure</Button>
                  </Link>
                </div>
              </div>
            ))
          )}
          <Link href="/settings/notifications">
            <Button variant="outline" size="sm" className="mt-2">
              Open Notification Rules
            </Button>
          </Link>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Full Platform Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <Link href="/settings/general">
            <Button variant="outline" size="sm">Open Platform Settings</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
