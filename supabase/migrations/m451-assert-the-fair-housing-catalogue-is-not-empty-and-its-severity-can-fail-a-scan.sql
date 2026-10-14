-- m451 — asserts m450. Separate file: a `raise` rolls back its own transaction.
--
-- ── CLAIM 1 — THE CATALOGUE IS NOT EMPTY (HARD) ─────────────────────────────
--
-- The defect this closes was not a wrong row, it was NO rows: the phrase scan
-- iterated `prohibitedPhrases || []` and therefore passed every piece of content
-- ever put through it. An empty compliance catalogue is indistinguishable, at the
-- call site, from a clean scan. That is the failure mode worth an assertion —
-- silence that reads as approval.
--
-- The floor is deliberately the FAIR HOUSING subset and not the total: somebody
-- could satisfy a bare count by adding marketing phrases while the protected-class
-- list stayed empty, and the protected-class list is the one with statutory teeth.
do $$
declare n_total int; n_fh int;
begin
  select count(*), count(*) filter (where category = 'fair_housing')
    into n_total, n_fh
  from public.prohibited_phrases where is_active;

  if n_total = 0 then
    raise exception 'm451: prohibited_phrases is EMPTY. lib/application/compliance-monitoring.ts iterates this table to scan listing and marketing copy; with no rows it finds nothing and reports every piece of content as passing. An empty compliance catalogue is not a neutral state — it is a gate that says yes to everything.';
  end if;
  if n_fh < 10 then
    raise exception 'm451: only % active fair_housing phrase(s). The protected-class list is the statutory half of this catalogue — a count satisfied by marketing or RESPA phrases while fair_housing is thin means the Fair Housing scan is effectively off.', n_fh;
  end if;
end $$;

-- ── CLAIM 2 — EVERY STORED SEVERITY IS ONE THE COLUMN ADMITS (HARD) ─────────
--
-- The seeder carried `severity: "blocking"` on all 17 Fair Housing rows while the
-- live CHECK admits only {info, warning, critical}. Anyone who had called
-- seedComplianceRules() by hand would have taken a 23514 on every one of those
-- rows and seeded ONLY the 8 harmless ones — a catalogue that looked populated
-- and had lost exactly the phrases that matter.
--
-- The CHECK already enforces this on write. This claim exists because the value
-- must ALSO be one the application can act on (claim 3), and asserting the two
-- together is what stops the pair drifting apart again.
do $$
declare bad text;
begin
  select string_agg(distinct severity, ', ') into bad
  from public.prohibited_phrases
  where severity not in ('info', 'warning', 'critical');

  if bad is not null then
    raise exception 'm451: prohibited_phrases holds severity value(s) the column vocabulary does not admit: %. scripts/check-vocabularies.ts declares this column as [critical, info, warning].', bad;
  end if;
end $$;

-- ── CLAIM 3 — AT LEAST ONE PHRASE CAN ACTUALLY FAIL A SCAN (HARD) ───────────
--
-- THE CLAIM THAT MATTERS, and the one a seed alone would not satisfy.
--
-- compliance-monitoring.ts computes `passed` as
--     issues.filter(i => i.severity === "blocking").length === 0
-- against its OWN grade vocabulary {info, warning, blocking}, while this table
-- stores {info, warning, critical}. The two intersect on info and warning and
-- NOT on the value that stops content. m450 stores 'critical' for every phrase
-- the authored catalogue marked blocking, and the reader maps critical→blocking
-- at the boundary.
--
-- So: if this table ever holds only info/warning rows, the scan can find
-- violations and still return passed:true. A catalogue that cannot fail anything
-- is the same defect as an empty one wearing rows.
do $$
declare n_crit int;
begin
  select count(*) into n_crit
  from public.prohibited_phrases where is_active and severity = 'critical';

  if n_crit = 0 then
    raise exception 'm451: no active phrase carries severity ''critical'', so NOTHING in this catalogue can fail a content scan. compliance-monitoring.ts grades a violation as blocking only for critical rows; with none, every scan returns passed:true no matter what it finds. This is the empty-catalogue defect with rows in it.';
  end if;
end $$;

-- ── CLAIM 4 — IT STAYS A PLATFORM CATALOGUE (HARD) ─────────────────────────
--
-- The Fair Housing Act is federal. Every tenant must read the same list, and no
-- tenant may edit it — otherwise a brokerage could quietly delete the phrase that
-- flags its own copy. Asserted as a CONSTRUCT: readable by authenticated with no
-- tenant predicate, and no write reachable without a platform check.
--
-- This also pins the reason m450 chose a migration over a button: a control that
-- every tenant depends on cannot be seeded per tenant, and must not be optional.
do $$
declare sel_pred text; bad_writes int;
begin
  select coalesce(qual,'') into sel_pred
  from pg_policies where schemaname='public' and tablename='prohibited_phrases' and cmd='SELECT'
  limit 1;

  if sel_pred is null then
    raise exception 'm451: prohibited_phrases has no SELECT policy. scripts/child-tenant-scope-simulator.ts records the requirement in words: "Fair-Housing phrase list — must be readable by every tenant." A tenant that cannot read it is a tenant whose content is never scanned.';
  end if;
  if sel_pred ~ '(brokerage_id|current_user_brokerage_id|has_brokerage_access)' then
    raise exception 'm451: the prohibited_phrases read has acquired a TENANT predicate (%). This is a federal catalogue with no brokerage_id column; scoping it means some brokerage stops being scanned.', sel_pred;
  end if;

  select count(*) into bad_writes
  from pg_policies
  where schemaname='public' and tablename='prohibited_phrases'
    and cmd in ('INSERT','UPDATE','DELETE','ALL')
    and 'service_role' <> all(roles)
    and coalesce(qual,'') || ' ' || coalesce(with_check,'') !~ '(is_platform_admin|is_platform_staff|can_read_tenant_financials)';

  if bad_writes > 0 then
    raise exception 'm451: % write polic(ies) on prohibited_phrases are not gated on a platform check. A brokerage that can edit this list can delete the phrase that flags its own listing copy.', bad_writes;
  end if;
end $$;

do $$
begin
  raise notice 'm451: the Fair Housing catalogue holds rows, every severity is one the column admits, at least one phrase can actually fail a scan, and the list stays readable by every tenant and writable by none of them.';
end $$;
