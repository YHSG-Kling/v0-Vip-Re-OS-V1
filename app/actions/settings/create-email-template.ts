'use server';

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

const CREATE_ROLES = ['broker', 'broker_owner', 'broker_admin', 'admin', 'super_admin', 'superadmin'];

export async function createEmailTemplate(template: any) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const { data: u } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle();
  if (!u?.brokerage_id) return { error: 'Unauthorized' };
  if (!CREATE_ROLES.includes(u.user_type ?? '')) return { error: 'Forbidden' };

  // Strip any caller-supplied id / brokerage_id / slug from the payload so we
  // can't forge rows into other brokerages; the slug is derived server-side.
  const { id: _id, brokerage_id: _b, slug: _s, ...safe } = template ?? {};

  const name = String(safe.name ?? '').trim();
  if (!name) return { error: 'Template name is required' };

  const svc = createServiceClient();

  // email_templates.slug is NOT NULL and unique per (brokerage_id, slug). The
  // form never sent one, so every create failed with a not-null violation —
  // which is why saved templates never appeared. Derive a unique slug from the
  // name (append -2, -3, … within the brokerage on collision).
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'template';
  const { data: taken } = await svc
    .from('email_templates')
    .select('slug')
    .eq('brokerage_id', u.brokerage_id)
    .ilike('slug', `${base}%`);
  const used = new Set((taken ?? []).map((r: any) => r.slug));
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;

  const { data, error } = await svc
    .from('email_templates')
    .insert({
      ...safe,
      name,
      slug,
      brokerage_id: u.brokerage_id,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    console.error('[settings] Error creating email template:', error);
    return { error: 'Failed to create email template' };
  }

  return { data };
}
