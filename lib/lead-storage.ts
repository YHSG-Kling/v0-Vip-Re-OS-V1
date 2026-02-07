'use server'

import { createClient } from '@/lib/supabase/server'

export async function insertLead(leadData: any) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('leads')
    .insert(leadData)
    .select('id')
    .single()

  if (error) throw error
  return data.id
}

export async function checkLeadExists(params: {
  brokerageId: string
  sourcePlatform: string
  contentHash: string
}): Promise<boolean> {
  const supabase = await createClient()

  const { data } = await supabase
    .from('leads')
    .select('id')
    .eq('brokerage_id', params.brokerageId)
    .eq('source', params.sourcePlatform)
    .ilike('notes', `%${params.contentHash}%`)
    .limit(1)
    .single()

  return !!data
}
