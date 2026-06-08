-- m186: audiences are multi-platform + carry provider identity.
-- Until now "facebook_custom_audiences" only modeled Meta retargeting (custom
-- lists). Real estate needs the full funnel: custom (consented CRM → retargeting),
-- lookalike (seeded from a custom audience → cold prospecting), and saved/
-- prospecting (interest+geo, no upload) — on Meta AND Google.

alter table public.facebook_custom_audiences
  add column if not exists target_platform text not null default 'facebook'
    check (target_platform in ('facebook','instagram','google','linkedin','tiktok')),
  add column if not exists external_audience_id text,               -- the provider's audience id after sync
  add column if not exists lookalike_seed_audience_id uuid references public.facebook_custom_audiences(id) on delete set null;

comment on column public.facebook_custom_audiences.external_audience_id is
  'The ad platform''s audience id returned after a successful sync (Meta custom-audience id / Google user-list id).';
comment on column public.facebook_custom_audiences.lookalike_seed_audience_id is
  'For audience_type=lookalike: the source custom audience this lookalike/similar is seeded from.';

create index if not exists idx_fca_platform on public.facebook_custom_audiences (target_platform, status);
