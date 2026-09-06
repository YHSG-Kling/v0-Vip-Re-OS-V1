import { redirect } from 'next/navigation'
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { toCanonicalRoleOrDefault } from '@/lib/security'
import { createClient } from '@/lib/supabase/server'
import FormsManagerClient from './FormsManagerClient'

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
  if (!['admin', 'broker', 'superadmin'].includes(userRole)) redirect('/dashboard')
  if (!ctx.brokerageId) redirect('/dashboard/onboarding')

  const supabase = await createClient()

  const { data: forms } = await supabase
    .from('lead_capture_forms')
    .select('id, name, slug, is_active, submission_count, created_at, fields, tcpa_disclosure_text, redirect_url, thank_you_message')
    .eq('brokerage_id', ctx.brokerageId)
    .order('created_at', { ascending: false })

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''

  return (
    <FormsManagerClient
      forms={forms ?? []}
      brokerageId={ctx.brokerageId}
      baseUrl={baseUrl}
    />
  )
}
