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

  // Try to find a contact by email
  const { data: contactByEmail } = await supabase
    .from('contacts')
    .select('id')
    .eq('email', user.email)
    .single()

  if (contactByEmail) {
    redirect(`/portal/${contactByEmail.id}`)
  }

  // Fallback 1: look up by portal_user_id
  const { data: contactByPortalUserId } = await supabase
    .from('contacts')
    .select('id')
    .eq('portal_user_id', user.id)
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

  // No contact found — fetch brokerage branding for a helpful error state
  // We try global_settings for any brokerage contact info to surface to the user
  const { data: branding } = await supabase
    .from('global_settings')
    .select('brokerage_name, support_email, support_phone, app_name')
    .limit(1)
    .maybeSingle()

  const brokerageName = branding?.brokerage_name ?? branding?.app_name ?? null
  const supportEmail = branding?.support_email ?? null
  const supportPhone = branding?.support_phone ?? null

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
        {(supportEmail || supportPhone) && (
          <div className="mb-6 p-4 bg-gray-50 rounded-lg text-sm text-gray-700 space-y-1">
            {supportEmail && (
              <p>
                Email:{' '}
                <a href={`mailto:${supportEmail}`} className="text-blue-600 hover:underline">
                  {supportEmail}
                </a>
              </p>
            )}
            {supportPhone && (
              <p>
                Phone:{' '}
                <a href={`tel:${supportPhone}`} className="text-blue-600 hover:underline">
                  {supportPhone}
                </a>
              </p>
            )}
          </div>
        )}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href="mailto:?subject=Portal%20Access%20Request"
            className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Contact Your Agent
          </a>
          <a
            href="/login"
            className="inline-flex items-center justify-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
          >
            Return to Login
          </a>
        </div>
      </div>
    </div>
  )
}
