-- m454 — OWNER RULING: "the users can also add in their settings prohibited words."
--
-- m450 seeded the FEDERAL catalogue. This adds the tenant layer the ruling asks
-- for, as one catalogue rather than two: brokerage_id NULL = the platform's
-- Fair Housing list (every tenant reads it, only the platform writes it),
-- brokerage_id set = that brokerage's own additions.
--
-- ONE table, so there stays ONE scanner, ONE severity vocabulary and ONE place a
-- phrase can be. Two tables would have meant two readers to keep in step, and
-- the reader is where this whole defect class lives.
--
-- ── THE TRAP THIS MIGRATION EXISTS TO CLOSE ────────────────────────────────
--
-- m442's lesson, and it points the opposite way here. A nullable tenant column
-- read as `brokerage_id IS NULL OR brokerage_id = mine` normally means an
-- UNSTAMPED ROW IS PUBLISHED TO EVERY TENANT — the severity inversion.
--
-- Here that visibility is CORRECT and deliberate: the Fair Housing Act is
-- federal, so NULL genuinely means "everyone", and it must.
--
-- Which moves the whole danger to the WRITE side. If a brokerage can insert a
-- row with brokerage_id NULL, it publishes its private word list to every other
-- tenant — and worse, it can then edit or DELETE the federal phrases, which is
-- precisely the "a brokerage deletes the phrase that flags its own copy" failure
-- m451 claim 4 was written against. So every tenant write below carries
-- `brokerage_id IS NOT NULL` in BOTH the USING and the WITH CHECK. USING stops
-- them reaching a federal row; WITH CHECK stops them turning their own row into
-- one. Neither alone is enough:
--   · WITH CHECK alone would let them DELETE a federal row (a FOR DELETE policy
--     has no WITH CHECK at all — only USING governs it).
--   · USING alone would let them UPDATE their own row's brokerage_id to NULL,
--     because when WITH CHECK is absent Postgres reuses USING, which the row
--     still satisfied BEFORE the update.
--
-- PROVEN LIVE before anything was built on it, impersonating broker@vip.demo (a
-- real non-platform admin) inside a DO block that raises and therefore rolls
-- back by construction — residue re-counted afterwards at 0:
--   own-insert allowed=t | null-insert blocked=t | federal rows deleted=0
--   | escalation-to-federal blocked=t | federal count 25->25

alter table public.prohibited_phrases
  add column if not exists brokerage_id uuid references public.brokerages(id) on delete cascade;

comment on column public.prohibited_phrases.brokerage_id is
  'NULL = federal/platform Fair Housing catalogue, readable by every tenant and writable only by platform staff. Non-NULL = that brokerage''s own added words, readable and writable only by them. A tenant can never write a NULL row — see m454.';

-- The old key was UNIQUE (phrase) across the whole table, which would stop two
-- different brokerages ever adding the same word — and stop any brokerage adding
-- a word the platform already lists, which is a reasonable thing to want (their
-- own severity, their own alternative). Replaced with one unique key per scope.
-- NOTE: it is a CONSTRAINT, not a bare index, so m450's
-- `create unique index if not exists` was a silent no-op against it.
alter table public.prohibited_phrases
  drop constraint if exists prohibited_phrases_phrase_key;

create unique index if not exists prohibited_phrases_platform_phrase_key
  on public.prohibited_phrases (phrase) where brokerage_id is null;

create unique index if not exists prohibited_phrases_tenant_phrase_key
  on public.prohibited_phrases (brokerage_id, phrase) where brokerage_id is not null;

create index if not exists idx_prohibited_phrases_brokerage
  on public.prohibited_phrases (brokerage_id) where brokerage_id is not null;

-- ── POLICIES ───────────────────────────────────────────────────────────────
drop policy if exists prohibited_phrases_select on public.prohibited_phrases;
drop policy if exists prohibited_phrases_insert on public.prohibited_phrases;
drop policy if exists prohibited_phrases_update on public.prohibited_phrases;
drop policy if exists prohibited_phrases_delete on public.prohibited_phrases;

-- READ: the federal list plus your own. Deliberately NOT `has_brokerage_access`
-- alone — that returns false for a NULL argument, which would hide the entire
-- Fair Housing catalogue from every tenant and reopen the gate m450 closed.
create policy prohibited_phrases_select on public.prohibited_phrases
  for select to authenticated
  using (brokerage_id is null or public.has_brokerage_access(brokerage_id));

-- WRITE: platform staff own the federal list. A brokerage's own admins and
-- compliance officers own their own rows, and only ever rows that carry their
-- tenant — `brokerage_id is not null` is the clause that keeps them off the
-- federal list, in every command.
create policy prohibited_phrases_insert on public.prohibited_phrases
  for insert to authenticated
  with check (
    public.is_platform_admin()
    or (
      brokerage_id is not null
      and public.has_brokerage_access(brokerage_id)
      and (public.is_brokerage_admin() or public.is_compliance_officer_role())
    )
  );

create policy prohibited_phrases_update on public.prohibited_phrases
  for update to authenticated
  using (
    public.is_platform_admin()
    or (
      brokerage_id is not null
      and public.has_brokerage_access(brokerage_id)
      and (public.is_brokerage_admin() or public.is_compliance_officer_role())
    )
  )
  with check (
    public.is_platform_admin()
    or (
      brokerage_id is not null
      and public.has_brokerage_access(brokerage_id)
      and (public.is_brokerage_admin() or public.is_compliance_officer_role())
    )
  );

create policy prohibited_phrases_delete on public.prohibited_phrases
  for delete to authenticated
  using (
    public.is_platform_admin()
    or (
      brokerage_id is not null
      and public.has_brokerage_access(brokerage_id)
      and (public.is_brokerage_admin() or public.is_compliance_officer_role())
    )
  );

do $$
declare n_platform int;
begin
  select count(*) into n_platform from public.prohibited_phrases where brokerage_id is null;
  raise notice 'm454: % federal phrases remain platform-owned; brokerages may now add their own in settings and can reach nothing but their own rows.', n_platform;
end $$;
