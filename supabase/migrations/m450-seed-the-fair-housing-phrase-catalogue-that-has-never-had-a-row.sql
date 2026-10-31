-- m450 — THE FAIR HOUSING GATE HAS BEEN OPEN. SEED IT.
--
-- Found while triaging an "orphan" export in W44, and it is the case that
-- justifies the whole rule: `lib/seed-compliance-rules.ts` presented as dead code
-- (nothing calls seedComplianceRules()), so a "no caller → delete" sweep would
-- have removed it. Deleting it would have removed a Fair Housing control THAT WAS
-- ALREADY NOT RUNNING, and the deletion would have looked clean.
--
-- MEASURED LIVE BEFORE WRITING THIS:
--   prohibited_phrases  = 0 rows
--   compliance_rules    = 10 rows      (the sibling catalogue WAS seeded)
--
-- lib/application/compliance-monitoring.ts:481 iterates `prohibitedPhrases || []`.
-- With zero rows that loop body never executes, so the phrase scan returns no
-- issues and PASSES EVERY PIECE OF CONTENT. "perfect for families", "no
-- children", "adults only", "no Section 8" — all unflagged, on every listing
-- description and marketing asset that runs through it. app/actions/ai-chat.ts
-- reads the same empty table for outbound messages.
--
-- ── AND IT COULD NEVER HAVE WORKED, WHICH IS THE SHARPER HALF ────────────────
--
-- The seeder is not merely unwired. Its 17 Fair Housing rows carry
-- `severity: "blocking"`, and the live constraint is
--
--   prohibited_phrases_severity_check CHECK (severity = ANY (ARRAY['info','warning','critical']))
--
-- so every one of those inserts would have died with a 23514. Somebody calling
-- seedComplianceRules() by hand would have seeded the 8 non-blocking rows and
-- silently lost all 17 of the Fair Housing ones. "Never called" hid a second
-- defect underneath it.
--
-- ── WHY 'blocking' BECOMES 'critical' AND NOT THE OTHER WAY ROUND ───────────
--
-- Three vocabularies had to be reconciled and only one is authoritative:
--   · the COLUMN's CHECK        {info, warning, critical}
--   · scripts/check-vocabularies.ts:1190 DECLARES exactly
--     prohibited_phrases.severity = ["critical","info","warning"] — and that guard
--     is in the chain and green, so it is the repository's stated contract.
--   · the seeder                {info, warning, blocking}
-- The declared contract wins; the seeder's spelling is the outlier. Mapping is
-- blocking→critical (the CHECK's severest value), warning→warning, info→info.
-- Nothing is downgraded: the 17 rows that were meant to stop content are stored
-- at the highest severity the column admits.
--
-- The application side of that reconciliation is NOT here — a migration must not
-- be the only half of a two-sided fix. compliance-monitoring.ts decides
-- pass/fail on `severity === "blocking"`, which is its OWN issue vocabulary
-- (it emits blocking/warning/info as literals for three non-DB issue types), so a
-- DB row arriving as 'critical' has to be normalised at the boundary or the gate
-- still passes everything. That change ships with this migration in the same
-- commit; m451 asserts the pairing.
--
-- ── THE TABLE IS A PLATFORM CATALOGUE, BY CONSTRUCTION, NOT BY ASSUMPTION ────
--
-- Checked before choosing a scope, because the m442 lesson is that guessing a
-- tenant is how an unstamped row gets published to everyone:
--   · it has NO brokerage_id column at all — nothing to stamp, nothing to leak;
--   · SELECT is `true` TO authenticated — every tenant reads the same list, which
--     is correct: the Fair Housing Act is federal, not per-brokerage;
--   · INSERT/UPDATE/DELETE are gated on is_platform_admin() — platform writes only.
-- scripts/child-tenant-scope-simulator.ts:67 already records the intent in words:
-- "Fair-Housing phrase list — must be readable by every tenant".
--
-- So this is seeded HERE, in a migration, rather than behind a button. A federal
-- compliance control must not depend on somebody remembering to click something,
-- and it must be present in every environment from first boot. That is also why
-- the 25 rows are written out as data rather than left in a TypeScript file that
-- has to be invoked: `lib/seed-compliance-rules.ts` had no caller for a reason
-- nobody recorded, and the fix for "nothing runs it" is to stop needing anything
-- to run it.
--
-- CONTENT IS NOT INVENTED. All 25 phrases, patterns, categories and relative
-- severities are lifted verbatim from lib/seed-compliance-rules.ts — the authored
-- catalogue — with only the severity SPELLING mapped onto the stored vocabulary.
--
-- IDEMPOTENT on `phrase`: re-running refreshes the pattern/category/severity and
-- leaves `is_active` and `notes` alone, so a platform admin who deactivates a
-- phrase does not have it silently switched back on by the next deploy.

-- The unique key is what makes the upsert idempotent, and it is right on its own
-- terms too: two rows for the same phrase would double-report one violation.
create unique index if not exists prohibited_phrases_phrase_key
  on public.prohibited_phrases (phrase);

insert into public.prohibited_phrases (phrase, phrase_pattern, category, severity, notes)
values
  ('perfect for families', 'perfect\s+(for|4)\s+famil', 'fair_housing', 'critical', null),
  ('no children', 'no\s+children', 'fair_housing', 'critical', null),
  ('adults only', 'adults\s+only', 'fair_housing', 'critical', null),
  ('ideal for couples', 'ideal\s+(for|4)\s+couples', 'fair_housing', 'critical', null),
  ('great for young professionals', 'great\s+(for|4)\s+young\s+professional', 'fair_housing', 'critical', null),
  ('perfect for retirees', 'perfect\s+(for|4)\s+retiree', 'fair_housing', 'critical', null),
  ('close to church', 'close\s+to\s+(church|synagogue|mosque|temple)', 'fair_housing', 'critical', null),
  ('Christian neighborhood', '(christian|jewish|muslim|hindu)\s+neighborhood', 'fair_housing', 'critical', null),
  ('diverse neighborhood', 'diverse\s+neighborhood', 'fair_housing', 'warning', null),
  ('ethnic area', '(ethnic|minority|white|black|hispanic|asian)\s+(area|neighborhood)', 'fair_housing', 'critical', null),
  ('no wheelchairs', 'no\s+wheelchair', 'fair_housing', 'critical', null),
  ('able-bodied', 'able[\s-]?bodied', 'fair_housing', 'critical', null),
  ('bachelor pad', 'bachelor\s+pad', 'fair_housing', 'warning', null),
  ('man cave', 'man\s+cave', 'fair_housing', 'warning', null),
  ('guaranteed return', 'guaranteed\s+(return|profit|income)', 'marketing', 'critical', null),
  ('best agent', '(best|#1|number\s+one)\s+agent', 'marketing', 'warning', null),
  ('kickback', 'kickback|referral\s+fee\s+for\s+referral', 'respa', 'critical', null),
  ('referral fee', 'referral\s+fee', 'respa', 'warning', null),
  ('guaranteed approval', 'guaranteed\s+approval|approval\s+guaranteed', 'udaap', 'critical', null),
  ('no credit check needed', 'no\s+credit\s+check', 'udaap', 'critical', null),
  ('investment guaranteed to increase', '(investment|property|home)\s+(guaranteed|will)\s+(to\s+)?(increase|appreciate|go\s+up)', 'udaap', 'critical', null),
  ('I can help you', 'I\s+can\s+help|I\s+will\s+help|let\s+me\s+help', 'them_first', 'info', null),
  ('my expertise', 'my\s+expertise|my\s+experience|my\s+skills', 'them_first', 'info', null),
  ('master bedroom', 'master\s+(bedroom|suite|bath)', 'fair_housing', 'warning', null),
  ('no Section 8', 'no\s+section\s+8|section\s+8\s+not\s+accepted', 'fair_housing', 'critical', null)
on conflict (phrase) do update
  set phrase_pattern = excluded.phrase_pattern,
      category       = excluded.category,
      severity       = excluded.severity,
      updated_at     = now();

do $$
declare n int; n_fh int; n_crit int;
begin
  select count(*), count(*) filter (where category = 'fair_housing'),
         count(*) filter (where severity = 'critical')
    into n, n_fh, n_crit
  from public.prohibited_phrases where is_active;

  if n < 25 then
    raise exception 'm450: expected at least 25 active prohibited phrases, found %.', n;
  end if;
  raise notice 'm450: % active prohibited phrases seeded (% fair_housing, % critical). The phrase scan now has something to scan — it has been iterating an empty list since migration 051 created the table.', n, n_fh, n_crit;
end $$;
