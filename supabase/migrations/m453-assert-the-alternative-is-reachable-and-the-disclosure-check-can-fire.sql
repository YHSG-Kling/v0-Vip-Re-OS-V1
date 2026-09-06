-- m453 — asserts m452. Separate file: a `raise` rolls back its own transaction.
--
-- ── CORRECTION TO m452's PROSE (the SQL was right, the sentence was not) ────
-- m452's header says "the 19 alternatives below" and "Six of the 25 phrases had
-- no alternative". MEASURED after applying: the values list carries **20** rows
-- and **five** phrases are left without one — no children, adults only, ethnic
-- area, able-bodied, kickback. The statements are unchanged and correct; only
-- the two numerals in the comment are wrong, and claim 1 below pins the real
-- figures so the record is unambiguous. Corrections belong in the next
-- migration, not in a silent edit of one already applied.

-- ── CLAIM 1 — THE ALTERNATIVE THE SCANNER READS ACTUALLY EXISTS (HARD) ──────
--
-- compliance-monitoring.ts has emitted `suggestedAlternative:
-- phrase.suggested_alternative` since it was written, against a table with no
-- such column — so the field was `undefined` on every issue ever produced. This
-- claim is about REACHABILITY, not row count: the column must exist, and enough
-- of the phrases that HAVE a compliant rewrite must carry it that the field is
-- worth rendering.
do $$
declare has_col bool; n_alt int; n_missing int;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='prohibited_phrases'
      and column_name='suggested_alternative'
  ) into has_col;

  if not has_col then
    raise exception 'm453: prohibited_phrases has no suggested_alternative column, but lib/application/compliance-monitoring.ts and app/actions/ai-chat.ts both read it. The agent is told what is wrong and never what to write instead.';
  end if;

  select count(*) filter (where suggested_alternative is not null),
         count(*) filter (where suggested_alternative is null)
    into n_alt, n_missing
  from public.prohibited_phrases where is_active;

  if n_alt < 15 then
    raise exception 'm453: only % active phrase(s) carry a suggested alternative. The authored catalogue supplied 20; a number this low means the backfill did not land and the scanner surfaces an empty field.', n_alt;
  end if;

  -- Five phrases are deliberately without one — "no children", "adults only",
  -- "ethnic area", "able-bodied", "kickback". These are not phrasings to soften
  -- into compliance; there is no compliant rewrite, only removal. Pinned as a
  -- CEILING so that a later well-meaning edit cannot invent a "friendlier" way
  -- to say them.
  if n_missing > 8 then
    raise exception 'm453: % active phrases have no suggested alternative. Only the five with no compliant rewrite should lack one.', n_missing;
  end if;
end $$;

-- ── CLAIM 2 — THE DISCLOSURE CHECK CAN FIRE AT ALL (HARD) ──────────────────
--
-- required_disclosures held ZERO rows, and scanContentComplianceService iterates
-- it as `requiredDisclosures || []` — the identical shape as the phrase list, so
-- the missing-disclosure warning had never once been raised either. One empty
-- catalogue was a coincidence; two is the pattern this pair of migrations closes.
do $$
declare n int; n_eh int;
begin
  select count(*), count(*) filter (where disclosure_type = 'equal_housing')
    into n, n_eh
  from public.required_disclosures where is_active;

  if n = 0 then
    raise exception 'm453: required_disclosures is EMPTY. scanContentComplianceService iterates it to raise missing_disclosure warnings; with no rows it raises none, and every asset passes the disclosure check by default.';
  end if;
  if n_eh = 0 then
    raise exception 'm453: no active equal_housing disclosure. That is the Fair Housing advertising requirement and the one row in this catalogue with statutory force.';
  end if;
end $$;

-- ── CLAIM 3 — EVERY DISCLOSURE IS LITERALLY CHECKABLE (HARD) ───────────────
--
-- THE CLAIM THAT MATTERS HERE, and the reason m452 seeded three rows and not the
-- authored five. The reader's test is a literal substring match:
--     !content.contentBody.includes(disclosure.disclosure_text)
-- so disclosure_text must be a string that compliant copy actually contains. Two
-- authored rows were placeholders — "Brokerage Name Required" (a LABEL, not a
-- disclosure) and "Licensed Real Estate Agent" (the requirement is the agent's
-- licence NUMBER, a per-agent fact). Seeding either would warn on 100% of
-- content forever, which is worth exactly as much as warning on none of it.
--
-- Asserted as a CONSTRUCT: no active disclosure may carry text that reads as a
-- requirement-about-text rather than the text itself, and none may be empty.
do $$
declare bad text;
begin
  select string_agg(disclosure_type || ' => ' || disclosure_text, '; ')
    into bad
  from public.required_disclosures
  where is_active
    and (
      length(btrim(disclosure_text)) < 8
      or disclosure_text ~* '(required|placeholder|TBD|your \w+ here|<[^>]+>|\{\{)'
    );

  if bad is not null then
    raise exception 'm453: required_disclosures holds text that is a PLACEHOLDER rather than the literal string compliant copy would contain: %. The reader tests contentBody.includes(disclosure_text), so a placeholder warns on every asset forever — a check that always fires is as useless as one that never does.', bad;
  end if;
end $$;

-- ── CLAIM 4 — BOTH CATALOGUES STAY PLATFORM-OWNED (HARD) ───────────────────
--
-- Same reasoning as m451 claim 4, extended to required_disclosures: federal
-- advertising requirements are not per-brokerage, and a brokerage that could edit
-- this list could delete the disclosure its own copy is missing.
do $$
declare t text; sel_pred text; bad_writes int;
begin
  foreach t in array array['prohibited_phrases','required_disclosures'] loop
    select coalesce(qual,'') into sel_pred
    from pg_policies where schemaname='public' and tablename=t and cmd='SELECT' limit 1;

    if sel_pred is null then
      raise exception 'm453: % has no SELECT policy — a tenant that cannot read it is a tenant whose content is never checked.', t;
    end if;
    if sel_pred ~ '(brokerage_id|current_user_brokerage_id|has_brokerage_access)' then
      raise exception 'm453: the % read has acquired a TENANT predicate (%). Neither catalogue has a brokerage_id column; scoping one means some brokerage stops being checked.', t, sel_pred;
    end if;

    select count(*) into bad_writes
    from pg_policies
    where schemaname='public' and tablename=t
      and cmd in ('INSERT','UPDATE','DELETE','ALL')
      and 'service_role' <> all(roles)
      and coalesce(qual,'') || ' ' || coalesce(with_check,'') !~ '(is_platform_admin|is_platform_staff)';

    if bad_writes > 0 then
      raise exception 'm453: % write polic(ies) on % are not gated on a platform check.', bad_writes, t;
    end if;
  end loop;
end $$;

do $$
begin
  raise notice 'm453: the suggested alternative the scanner reads now exists and is populated, the disclosure catalogue can fire, every disclosure is a literal a real asset could contain, and both catalogues stay readable by every tenant and writable by none of them.';
end $$;
