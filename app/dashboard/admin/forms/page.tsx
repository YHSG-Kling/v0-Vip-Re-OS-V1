import { redirect } from 'next/navigation'
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { toCanonicalRoleOrDefault } from '@/lib/security'
import { createClient } from '@/lib/supabase/server'
import { CHECK_VOCABULARIES } from '@/scripts/check-vocabularies'
import FormsManagerClient from './FormsManagerClient'
import { isAdminOrBroker } from '@/lib/auth/resolve-user-role'
import { RoleGateNotice } from '@/app/components/shared/role-gate-notice'

// The "who fills this form" selector's options come from the SAME live
// vocabulary the submit route's reader (app/api/forms/submit/route.ts Step 4b)
// checks a declared value against — never a hand-typed second list (CLAUDE.md
// §6). scripts/check-vocabularies.ts is machine-generated from the live
// `contacts_contact_type_check` constraint.
const CONTACT_TYPE_VOCABULARY = CHECK_VOCABULARIES.contacts.contact_type

export default async function AdminFormsPage() {
  // Kernel OS: getAgentContext — canonical identity
  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect('/login')

  const userRole = toCanonicalRoleOrDefault(ctx.userType, 'agent')
  // Lane 89D: `['admin', 'broker', 'superadmin'].includes(userRole)` was two
  // live spellings plus a dead arm (§4: no live row stores user_type='superadmin'),
  // so a broker_owner / broker_admin / compliance_officer clicking "Forms
  // Manager" in the admin sidebar was bounced to /dashboard without a word.
  // ONE roster predicate; the refusal is stated in place.
  if (!isAdminOrBroker({ user_type: userRole })) {
    return (
      <RoleGateNotice
        surface="The Forms Manager"
        audience="your broker, brokerage admins, team leads and compliance officer"
      />
    )
  }
  if (!ctx.brokerageId) redirect('/dashboard/onboarding')

  const supabase = await createClient()

  const { data: forms } = await supabase
    .from('lead_capture_forms')
    .select('id, name, slug, is_active, submission_count, created_at, fields, tcpa_disclosure_text, redirect_url, thank_you_message, settings')
    .eq('brokerage_id', ctx.brokerageId)
    .order('created_at', { ascending: false })

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''

  return (
    <FormsManagerClient
      forms={forms ?? []}
      brokerageId={ctx.brokerageId}
      baseUrl={baseUrl}
      contactTypeVocabulary={CONTACT_TYPE_VOCABULARY}
    />
  )
}
