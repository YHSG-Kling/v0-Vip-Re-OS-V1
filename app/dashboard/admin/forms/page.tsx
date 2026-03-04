import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import FormsManagerClient from './FormsManagerClient'

export default async function AdminFormsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('user_type, brokerage_id')
    .eq('user_id', user.id)
    .single()

  if (!profile || !['admin', 'broker', 'superadmin'].includes(profile.user_type)) {
    redirect('/dashboard')
  }

  const { data: forms } = await supabase
    .from('lead_capture_forms')
    .select('id, name, slug, is_active, submission_count, created_at, fields, tcpa_disclosure_text, redirect_url, thank_you_message')
    .eq('brokerage_id', profile.brokerage_id)
    .order('created_at', { ascending: false })

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''

  return (
    <FormsManagerClient
      forms={forms ?? []}
      brokerageId={profile.brokerage_id}
      baseUrl={baseUrl}
    />
  )
}
