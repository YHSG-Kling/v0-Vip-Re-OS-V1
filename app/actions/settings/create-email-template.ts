'use server';

import { createServiceClient } from '@/lib/supabase/service';
// ★ ACT-AS WRITE SEAM ★ — effective (impersonated) identity for the gate;
// read_only impersonation refused before the service-client insert, which this
// gate alone protects. Role predicate (user_type) unchanged.
import { resolveWriteContext } from '@/lib/platform/acting-context';

const CREATE_ROLES = ['broker', 'broker_owner', 'broker_admin', 'admin', 'super_admin', 'superadmin'];

export async function createEmailTemplate(template: any) {
  const ctx = await resolveWriteContext();
  if (!ctx.ok) return { error: ctx.error };
  if (!ctx.brokerageId) return { error: 'Unauthorized' };
  if (!CREATE_ROLES.includes(ctx.userType ?? '')) return { error: 'Forbidden' };
  const u = { brokerage_id: ctx.brokerageId };

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
