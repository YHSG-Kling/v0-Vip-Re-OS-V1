-- m245: per-brokerage CDA template FIELD DEFINITIONS. Brokerages have different CDA
-- forms, so each template's fillable fields are bound to a SOURCE — the commission
-- waterfall, the transaction, an agent-entered input, or a static value — which lets
-- the OS AUTO-FILL each brokerage's own CDA form from the live waterfall instead of a
-- generic tally. Resolved values are stored on the CDA in field_values (jsonb).
create table if not exists brokerage_cda_template_fields (
  id            uuid primary key default gen_random_uuid(),
  brokerage_id  uuid not null,
  template_id   uuid not null references brokerage_cda_templates(id) on delete cascade,
  field_key     text not null,
  label         text,
  source        text not null default 'agent_input'
                  check (source in ('waterfall','transaction','agent_input','static')),
  source_key    text,
  field_type    text not null default 'text'
                  check (field_type in ('currency','percent','date','text')),
  static_value  text,
  required      boolean not null default false,
  display_order integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists idx_cda_template_fields_key
  on brokerage_cda_template_fields (template_id, field_key);
create index if not exists idx_cda_template_fields_template
  on brokerage_cda_template_fields (brokerage_id, template_id, display_order);

alter table closing_disclosure_agreement
  add column if not exists field_values jsonb not null default '{}'::jsonb;

comment on table brokerage_cda_template_fields is
  'Per-brokerage CDA form field definitions bound to waterfall/transaction/agent-input sources, so the OS auto-fills each brokerage''s own CDA form from the live commission waterfall.';
