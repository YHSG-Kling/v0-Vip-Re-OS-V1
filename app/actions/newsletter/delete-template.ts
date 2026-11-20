'use server'

import { createClient } from '@/lib/supabase/server'

export async function deleteTemplate(templateId: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')
  const { ledgerSessionAction, resultFamily } = await import("@/lib/kernel/action-ledger")
  return resultFamily(await ledgerSessionAction({ brokerageId: userData.brokerage_id, action: "marketing.newsletter_template.delete", actor: { type: "user", userId: user.id }, subject: { type: "newsletter_brokers_template", id: templateId }, riskClass: "IRREVERSIBLE", reasonCode: "HUMAN_REQUESTED" }, async () => {

  // Verify template belongs to user's brokerage
  const { data: template } = await supabase
    .from('newsletter_brokers_templates')
    .select('id')
    .eq('id', templateId)
    .eq('brokerage_id', userData.brokerage_id)
    .single()

  if (!template) throw new Error('Template not found or access denied')

  // Delete template (cascades will delete sections)
  const { error } = await supabase
    .from('newsletter_brokers_templates')
    .delete()
    .eq('id', templateId)

  if (error) throw new Error(`Failed to delete template: ${error.message}`)

  return {
    success: true,
    message: 'Template deleted successfully',
  }
  }))
}
