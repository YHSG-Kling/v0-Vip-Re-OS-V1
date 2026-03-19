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
  const { data: contact } = await supabase
    .from('contacts')
    .select('id')
    .eq('email', user.email)
    .single()

  if (contact) {
    redirect(`/portal/${contact.id}`)
  }

  // No contact found - show error page
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full p-8 bg-white rounded-lg shadow-lg text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Portal Access</h1>
        <p className="text-gray-600 mb-6">
          We could not find a contact profile associated with your account.
          Please contact your agent for assistance.
        </p>
        <a 
          href="/login" 
          className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Return to Login
        </a>
      </div>
    </div>
  )
}
