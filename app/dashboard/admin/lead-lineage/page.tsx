import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import LeadLineageClient, { type Lead } from './lead-lineage-client'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Lead Lineage OS | Admin',
  description: 'Every inbound signal from raw record to lifetime relationship',
}

export default async function LeadLineagePage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users')
    .select('user_type, brokerage_id')
    .eq('id', user.id)
    .single()

  if (!['admin', 'broker', 'superadmin'].includes(profile?.user_type ?? '')) {
    redirect('/dashboard')
  }

  const brokerageId = profile!.brokerage_id!

  const { data: leads, error } = await supabase
    .from('leads')
    .select(`
      id,
      first_name,
      last_name,
      email,
      phone,
      source,
      lead_score,
      lifecycle_state,
      status,
      created_at,
      converted_at,
      agent_id,
      enrichment_status,
      enrichment_provider,
      dedupe_status,
      minimum_viable_for_isa,
      mailing_address,
      mailing_city,
      mailing_state,
      mailing_zip,
      mailing_address_verified,
      tcpa_consent,
      tcpa_consent_at,
      tcpa_consent_source,
      ai_isa_owner,
      handed_to_agent_at,
      raw_record_id,
      ai_isa_qualifications (
        id,
        qualification_score,
        stage,
        notes,
        qualified_at,
        last_outreach_at,
        assigned_to_agent_id
      ),
      contacts (
        id,
        contact_type,
        created_at
      )
    `)
    .eq('brokerage_id', brokerageId)
    .order('created_at', { ascending: false })
    .limit(150)

  if (error) {
    console.error('[lead-lineage] Error loading leads:', error.message)
  }

  return (
    <main className="flex flex-col gap-6 p-6 max-w-[1600px] mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 text-balance">Lead Lineage OS</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every inbound signal from raw record to lifetime relationship
        </p>
      </div>

      <LeadLineageClient
        leads={(leads as Lead[]) ?? []}
        brokerageId={brokerageId}
      />
    </main>
  )
}
