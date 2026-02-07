'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function createEmailTemplate(template: any) {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('email_templates')
    .insert({
      ...template,
      is_active: true,
    })
    .select()
    .single();
    
  if (error) {
    console.error('[v0] Error creating email template:', error);
    return { error: 'Failed to create email template' };
  }
  
  return { data };
}
