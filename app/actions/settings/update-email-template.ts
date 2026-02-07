'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function updateEmailTemplate(id: string, updates: any) {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('email_templates')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
    
  if (error) {
    console.error('[v0] Error updating email template:', error);
    return { error: 'Failed to update email template' };
  }
  
  return { data };
}
