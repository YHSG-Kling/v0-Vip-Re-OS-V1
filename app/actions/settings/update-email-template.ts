'use server';

import { createClient } from '@/lib/supabase/server';
import { validateEmailTemplate } from '@/app/lib/settings/settings-validator';
import { extractVariables } from '@/app/lib/settings/email-template-renderer';
import { revalidatePath } from 'next/cache';

export async function updateEmailTemplate(id: string, data: any) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: 'Unauthorized' };
  }

  const { data: userProfile } = await supabase
    .from('users')
    .select('user_type, brokerage_id')
    .eq('id', user.id)
    .single();

  if (!userProfile || userProfile.user_type !== 'admin') {
    return { error: 'Only admins can update email templates' };
  }

  const validationErrors = validateEmailTemplate(data);
  if (validationErrors.length > 0) {
    return { error: validationErrors.join(', ') };
  }

  // Extract variables from template body
  const variables = extractVariables(data.body);

  const { error } = await supabase
    .from('email_templates')
    .update({
      ...data,
      variables: JSON.stringify(variables),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('brokerage_id', userProfile.brokerage_id);

  if (error) {
    console.error('[v0] Failed to update email template:', error);
    return { error: 'Failed to update email template' };
  }

  revalidatePath('/settings/email-templates');
  return { success: true };
}
