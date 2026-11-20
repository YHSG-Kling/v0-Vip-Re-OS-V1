import { redirect } from 'next/navigation'
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { toCanonicalRoleOrDefault } from '@/lib/security'
import FormsManagerClient from './FormsManagerClient'
import { isAdminOrBroker } from '@/lib/auth/resolve-user-role'
import { RoleGateNotice } from '@/app/components/shared/role-gate-notice'

/**
 * TOMBSTONE (wave 142, lane 142E — orphan doctrine §1.1): this page used to read `lead_capture_forms` and
 * render a SECOND lead-capture builder (field editor, "who fills this form", /api/admin/forms create + PATCH,
 * /forms/[slug] + /api/forms/submit capture) on the SAME table as the lead-magnet builder. SURVIVOR:
 * app/dashboard/marketing/lead-magnets/page.tsx (MagnetBuilder / MagnetDraftReview) on the kernel command set
 * lib/kernel/lead-magnets.ts — draft → human review → publish → capture with delivery, handoff, consent,
 * attribution and sequences. What was unique here moved there: the declared persona
 * (lib/lead-magnets/form-contact-types.ts → settings.default_contact_type, honoured by captureFormSubmission)
 * and the "Custom Form" questions editor (already on the builder). The public /forms/[slug] door stays and now
 * captures through the ONE kernel command. This page keeps the TRANSACTION-FORMS tab (a different function:
 * the forms provider's template library) and points lead capture at its survivor.
 */
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

  return <FormsManagerClient />
}
