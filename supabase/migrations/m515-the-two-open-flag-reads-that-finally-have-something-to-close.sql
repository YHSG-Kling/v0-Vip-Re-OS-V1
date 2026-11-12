-- m515 — THE TWO "WHAT IS STILL OPEN" READS THAT FINALLY HAVE SOMETHING TO CLOSE.
--
-- Two boolean columns are read as `.eq(…, false)` by the surfaces that decide
-- whether a transaction is at risk and whether a CMA's comps can be trusted:
--
--   compliance_alerts.resolved   lib/application/compliance-monitoring.ts:71
--                                (checkComplianceStatusService — `overallStatus`
--                                is 'at_risk' whenever ANY unresolved alert exists)
--   comp_risk_flags.is_resolved  app/actions/seller-cma.ts:243
--                                (the Comp Risk Flags card on the CMA report tab)
--
-- Both DEFAULT false. Nothing in the tree ever set either to true, so an alert
-- could be raised and never cleared: `overallStatus` stuck at 'at_risk' forever,
-- and a comp risk the agent had already handled kept shouting from the report.
-- It failed CLOSED — no false assurance was ever displayed — but a light that
-- cannot go out is a light nobody reads, and that is how a real alert gets
-- missed.
--
-- Wave 14 builds the resolve path (resolveComplianceAlertService /
-- resolveCompRiskFlagService) and the two surfaces that reach it, so from now on
-- these predicates SELECT A SHRINKING SET rather than an ever-growing one. Both
-- are unindexed partial reads on tables the compliance panel and the CMA report
-- hit on every load.
--
-- ── WHY THIS MIGRATION ADDS NO COLUMNS ──────────────────────────────────────
--
-- WHO cleared a compliance flag and WHEN is part of the fact — a compliance
-- artefact marked cleared with no actor and no timestamp asserts a human
-- judgement that cannot be attributed or dated, which is the same defect class
-- as a call stamped `compliance_passed` by a gate that never ran (m510).
--
-- The first draft of this migration added resolved_at / resolved_by /
-- resolution_note to comp_risk_flags. That was withdrawn, because it would have
-- created THREE BRAND-NEW WRITERLESS-UNTIL-APPLIED COLUMNS — the exact class of
-- defect this wave exists to burn down — and because the facts already have a
-- canonical home:
--
--   compliance_alerts  ALREADY carries resolved_at + resolved_by (verified live).
--                      They were declared with the boolean and, like the boolean,
--                      never written. The service now writes all three together.
--
--   comp_risk_flags    carries is_resolved alone, and the attribution goes to
--                      public.audit_log — user_id / action / entity_type /
--                      entity_id / after — which is the tree's ONE audit ledger
--                      (lib/application/compliance-monitoring.ts:13
--                      logAuditEventService) and is queryable across every
--                      compliance artefact instead of per-table. Both resolve
--                      paths write it, so the two sides are attributable in the
--                      SAME place and in the same vocabulary.
--
-- NO BACKFILL, and nothing is marked resolved here. There is no evidence
-- anywhere about who dealt with any existing flag, and inventing an actor for a
-- compliance record is precisely the lie this work exists to make impossible.

begin;

-- "Show me what is still open", on both tables — now that the sets can shrink.
create index if not exists idx_comp_risk_flags_open
  on public.comp_risk_flags (cma_id)
  where is_resolved = false;

create index if not exists idx_compliance_alerts_open
  on public.compliance_alerts (transaction_id)
  where resolved = false;

comment on column public.compliance_alerts.resolved is
  'Cleared by a human. Written together with resolved_at + resolved_by by resolveComplianceAlertService — a cleared alert can never lack its actor or its moment. The clearing is also recorded in audit_log (action compliance_alert.resolved).';

comment on column public.comp_risk_flags.is_resolved is
  'Cleared by a human via resolveCompRiskFlagService. This table carries no actor column by design: WHO and WHEN live in audit_log (action comp_risk_flag.resolved, entity_type comp_risk_flag, entity_id = this row id), the one audit ledger, rather than in three per-table columns.';

-- AN AFTER-ASSERTION, NOT A HOPE.
do $$
declare
  missing text;
begin
  select string_agg(want.idx, ', ')
    into missing
  from (values ('idx_comp_risk_flags_open'), ('idx_compliance_alerts_open')) as want(idx)
  where not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = want.idx
  );
  if missing is not null then
    raise exception 'm515 did not land: missing index(es) %', missing;
  end if;
end $$;

commit;
