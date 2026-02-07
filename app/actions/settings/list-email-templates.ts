'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function listEmailTemplates() {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .order('created_at', { ascending: false });
    
  if (error) {
    console.error('[v0] Error fetching email templates:', error);
    throw new Error('Failed to fetch email templates');
  }
  
  return data || [];
}
