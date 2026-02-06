'use server';

import { createClient } from '@/lib/supabase/server';
import { validateEmailTemplate } from '@/app/lib/settings/settings-validator';
import { extractVariables } from '@/app/lib/settings/email-template-renderer';
import { revalidatePath } from 'next/cache';

export async function createEmailTemplate(data: any) {
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
    return { error: 'Only admins can create email templates' };
  }

  const validationErrors = validateEmailTemplate(data);
  if (validationErrors.length > 0) {
    return { error: validationErrors.join(', ') };
  }

  // Extract variables from template body
  const variables = extractVariables(data.body);

  const { error } = await supabase.from('email_templates').insert([
    {
      ...data,
      brokerage_id: userProfile.brokerage_id,
      variables: JSON.stringify(variables),
      is_active: true,
    },
  ]);

  if (error) {
    console.error('[v0] Failed to create email template:', error);
    return { error: 'Failed to create email template' };
  }

  revalidatePath('/settings/email-templates');
  return { success: true };
}
