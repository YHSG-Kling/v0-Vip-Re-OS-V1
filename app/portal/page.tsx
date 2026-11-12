import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

// /portal resolves to /portal/[contactId] for authenticated contacts
export default async function PortalPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?redirect=/portal')
  }

  // Check if user has a contact_id in metadata
  const contactId = user.user_metadata?.contact_id

  if (contactId) {
    redirect(`/portal/${contactId}`)
  }

  // Try to find a contact by email.
  //
  // An email address is not unique across tenants: the same person can be a client of
  // two brokerages. This used .single(), which both picked an arbitrary tenant's row
  // AND hard-errored when there was more than one — so a genuinely dual-tenant client
  // saw a crash rather than a portal. Take the match only when it is unambiguous; the
  // id-based lookups below (contact_user_id / user_id) are the reliable paths and run
  // either way.
  const { data: emailMatches } = await supabase
    .from('contacts')
    .select('id, brokerage_id')
    .eq('email', user.email)
    .limit(2)

  const emailRows = (emailMatches ?? []) as Array<{ id: string; brokerage_id: string | null }>
  if (emailRows.length === 1) {
    redirect(`/portal/${emailRows[0].id}`)
  }

  // Fallback 1: look up by contact_user_id
  const { data: contactByPortalUserId } = await supabase
    .from('contacts')
    .select('id')
    .eq('contact_user_id', user.id)
    .single()

  if (contactByPortalUserId) {
    redirect(`/portal/${contactByPortalUserId.id}`)
  }

  // Fallback 2: look up by user_id
  const { data: contactByUserId } = await supabase
    .from('contacts')
    .select('id')
    .eq('user_id', user.id)
    .single()

  if (contactByUserId) {
    redirect(`/portal/${contactByUserId.id}`)
  }

  // No contact found — fetch brokerage branding for a helpful error state.
  //
  // SCOPED TO THIS USER'S BROKERAGE. This read used to be
  // `.select('app_name').limit(1).maybeSingle()` with NO tenant filter, i.e.
  // "whichever settings row the database hands back first". The repo already
  // knew better one file over: app/actions/seller-open-house.ts:1113 carries the
  // comment "never 'the first settings row in the table'" and filters by
  // brokerage_id.
  //
  // It was latent only because global_settings had zero rows and because m457
  // has since removed the tenant-free "Admins and brokers can view settings"
  // policy that let an admin or broker read EVERY tenant's row. Relying on RLS
  // to scope a query the query itself declined to scope is how a leak survives a
  // policy change — so the filter is stated here too, in the query.
  const { data: viewer } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .maybeSingle()

  const { data: branding } = viewer?.brokerage_id
    ? await supabase
        .from('global_settings')
        .select('app_name')
        .eq('brokerage_id', viewer.brokerage_id)
        .maybeSingle()
    : { data: null }

  const brokerageName = branding?.app_name ?? null

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full p-8 bg-white rounded-lg shadow-lg text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">
          {brokerageName ?? 'Client Portal'}
        </h1>
        <p className="text-gray-600 mb-2">
          We couldn&apos;t find your profile — your agent may need to invite you.
        </p>
        <p className="text-sm text-gray-500 mb-6">
          If you believe this is an error, please reach out to your agent directly.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href="/login"
            className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Return to Login
          </a>
        </div>
      </div>
    </div>
  )
}
