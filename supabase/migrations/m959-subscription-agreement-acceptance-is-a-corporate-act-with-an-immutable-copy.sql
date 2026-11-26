-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151A ──
-- m959 — THE SUBSCRIPTION AGREEMENT IS ACCEPTED BY THE CORPORATE SUBSCRIBER'S SIGNATORY, OF A VERSION WITH A CONTENT
--        HASH, LEAVING AN IMMUTABLE COPY (wave 151, lane 151A — the owner's acceptance ruling, on the m481 survivor)
-- ─────────────────────────────────────────────────────────────────────────────
-- OWNER (wave 151): "complete ONLY what is missing: authoritative signatory identity (corporate subscriber signer ≠ any
-- arbitrary seat user), agreement version + content hash, affirmative acceptance with time/audit evidence, immutable
-- historical copy, retrievable download, reacceptance on a new version; drafts stay DRAFT — OWNER AND QUALIFIED LEGAL
-- COUNSEL REVIEW — NOT APPROVED FOR USE and a draft version cannot be activated as the accepted version."
--
-- MEASURED LIVE (2026-11-09, project hrvaqgvukzxfskkcrwbt, read-only): platform_contract_templates 0 rows,
-- tenant_contract_signatures 0 rows; the INSERT policy admits is_brokerage_admin() (team_lead + compliance_officer
-- included); no trigger on either table; is_brokerage_finance_admin() exists and reads
-- user_type in (admin, broker, broker_admin, broker_owner) OR a tenant-pinned grant OR is_tenant_principal_team_lead().
-- With 0 rows every CHECK and default below is safe to add.
--
-- Code half (same lane): lib/legal/subscription-agreement.ts (AGREEMENT_APPROVAL_STATUSES is the ONE constant behind the
-- approval_status CHECK; assessSignatoryAuthority is the app twin of the INSERT policy; the append-only rule is the
-- trigger below). Proof: scripts/subscription-acceptance-guard.ts (test:subscription-acceptance).
--
-- After apply: regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts (two new FKs), scripts/check-vocabularies.ts
-- (one new CHECK vocabulary) — generated caches, never hand-edited.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE TEMPLATE IS A VERSION WITH A CONTENT IDENTITY AND AN APPROVAL RECORD
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.platform_contract_templates
  add column if not exists version_label           text,
  add column if not exists content_sha256          text,
  add column if not exists approval_status         text not null default 'draft',
  add column if not exists approved_at             timestamptz,
  add column if not exists approved_by             uuid references public.users(id) on delete set null,
  add column if not exists approval_note           text,
  add column if not exists source_path             text,
  add column if not exists supersedes_template_id  uuid references public.platform_contract_templates(id) on delete set null;

-- ONE vocabulary: lib/legal/subscription-agreement.ts AGREEMENT_APPROVAL_STATUSES = ["draft", "approved"].
alter table public.platform_contract_templates drop constraint if exists platform_contract_templates_approval_status_check;
alter table public.platform_contract_templates
  add constraint platform_contract_templates_approval_status_check
  check (approval_status in ('draft', 'approved'));

-- A DRAFT IS NEVER THE ACTIVE (ACCEPTABLE) VERSION — the database says it, not only the activation door.
alter table public.platform_contract_templates drop constraint if exists platform_contract_templates_active_is_approved;
alter table public.platform_contract_templates
  add constraint platform_contract_templates_active_is_approved
  check ((not is_active) or approval_status = 'approved');

-- A new template is a draft until approved and then deliberately activated: it starts inactive.
alter table public.platform_contract_templates alter column is_active set default false;

create index if not exists idx_platform_contract_templates_supersedes
  on public.platform_contract_templates (supersedes_template_id) where supersedes_template_id is not null;

comment on column public.platform_contract_templates.content_sha256 is
  'sha256 of the normalized body_text (or of the stored document bytes). lib/legal/subscription-agreement.ts agreementContentHash. m959.';
comment on column public.platform_contract_templates.approval_status is
  'draft | approved — the owner/counsel approval RECORD (who/when/note beside it). Only an approved version may be active (CHECK). m959.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE ACCEPTANCE CARRIES ITS EVIDENCE AND AN IMMUTABLE COPY
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.tenant_contract_signatures
  add column if not exists version_label          text,
  add column if not exists content_sha256         text,
  add column if not exists accepted_body_text     text,
  add column if not exists accepted_document_path text,
  add column if not exists signatory              jsonb not null default '{}'::jsonb,
  add column if not exists accepted_ip            text,
  add column if not exists accepted_user_agent    text;

comment on column public.tenant_contract_signatures.signatory is
  'The authoritative signatory: {user_id, email, user_type, typed_name, typed_title, legal_entity{name,dba,licenseNumber,licenseState}, authority_basis[], multi_location}. Written by lib/legal/subscription-agreement.ts buildAcceptanceRow. m959.';
comment on column public.tenant_contract_signatures.accepted_body_text is
  'The agreement text exactly as accepted (immutable copy; re-hashed on download — acceptedCopyIntegrity). NULL for a stored-document acceptance, which carries accepted_document_path + content_sha256 instead. m959.';

-- APPEND-ONLY (the m696 pattern): an acceptance is a record, not a draft. m481 already gave it no UPDATE/DELETE policy; this
-- refuses the service role too. Referential actions (the cascade from a deleted brokerage) arrive nested and pass.
create or replace function public.tenant_contract_signatures_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  raise exception 'tenant_contract_signatures % is append-only: % refused — an acceptance is never edited or deleted; a new version is a new acceptance', old.id, tg_op
    using errcode = 'P0001';
end;
$$;

drop trigger if exists tenant_contract_signatures_append_only on public.tenant_contract_signatures;
create trigger tenant_contract_signatures_append_only
  before update or delete on public.tenant_contract_signatures
  for each row execute function public.tenant_contract_signatures_append_only();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. WHO MAY ACCEPT FOR THE BROKERAGE — the seat that may keep its books (RLS twin of assessSignatoryAuthority)
-- ─────────────────────────────────────────────────────────────────────────────
-- is_brokerage_finance_admin() (m472/m530/m604/m526): admin / broker / broker_admin / broker_owner by user_type OR a
-- tenant-pinned grant OR the principal lead of a team / solo subscription — never compliance_officer, never a team lead
-- inside a brokerage. The multi-location leadership-grant rule stays app-side (organization_members, C34).
drop policy if exists tenant_contract_signatures_insert on public.tenant_contract_signatures;
create policy tenant_contract_signatures_insert
  on public.tenant_contract_signatures for insert
  to authenticated
  with check (
    public.is_brokerage_finance_admin()
    and brokerage_id = public.current_user_brokerage_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Postconditions — raise, never trust.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare v_bad int; v_def text;
begin
  select count(*) into v_bad from information_schema.columns
  where table_schema = 'public' and table_name = 'platform_contract_templates'
    and column_name in ('version_label', 'content_sha256', 'approval_status', 'approved_at', 'approved_by', 'approval_note', 'source_path', 'supersedes_template_id');
  if v_bad <> 8 then raise exception 'm959: platform_contract_templates expected 8 new columns, found %', v_bad; end if;

  select count(*) into v_bad from information_schema.columns
  where table_schema = 'public' and table_name = 'tenant_contract_signatures'
    and column_name in ('version_label', 'content_sha256', 'accepted_body_text', 'accepted_document_path', 'signatory', 'accepted_ip', 'accepted_user_agent');
  if v_bad <> 7 then raise exception 'm959: tenant_contract_signatures expected 7 new columns, found %', v_bad; end if;

  select pg_get_constraintdef(oid) into v_def from pg_constraint
  where conrelid = 'public.platform_contract_templates'::regclass and conname = 'platform_contract_templates_active_is_approved';
  if v_def is null or v_def !~ 'approved' then raise exception 'm959: the draft-is-never-active CHECK is missing'; end if;

  select count(*) into v_bad from pg_trigger
  where tgrelid = 'public.tenant_contract_signatures'::regclass and tgname = 'tenant_contract_signatures_append_only' and not tgisinternal;
  if v_bad <> 1 then raise exception 'm959: the append-only trigger is missing'; end if;

  select count(*) into v_bad from pg_policies
  where schemaname = 'public' and tablename = 'tenant_contract_signatures' and cmd = 'INSERT'
    and with_check ~ 'is_brokerage_finance_admin' and with_check ~ 'current_user_brokerage_id';
  if v_bad <> 1 then raise exception 'm959: the acceptance INSERT policy is not pinned to the finance-admin predicate + tenant'; end if;

  select count(*) into v_bad from pg_policies
  where schemaname = 'public' and tablename = 'tenant_contract_signatures' and cmd in ('UPDATE', 'DELETE');
  if v_bad <> 0 then raise exception 'm959: an acceptance became editable — % UPDATE/DELETE policies', v_bad; end if;

  select count(*) into v_bad from public.platform_contract_templates where is_active and approval_status <> 'approved';
  if v_bad <> 0 then raise exception 'm959: % active templates are not approved', v_bad; end if;
end $$;
