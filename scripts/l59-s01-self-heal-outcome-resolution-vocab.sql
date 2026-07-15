-- l59-s01: EXCEPTION RESOLUTION VOCABULARY — the append-only ledger closes
-- exceptions by APPENDING, never mutating: 'resolved' (a human handled the
-- escalation) and 'dismissed' (a human judged the flag not-an-issue). A human
-- flagging a REPAIR as wrong appends outcome 'failed' (existing vocab) so the
-- confidence ratchet demotes that action instantly. cron_manager owns the ledger.
alter table public.self_heal_events drop constraint if exists self_heal_events_outcome_check;
alter table public.self_heal_events add constraint self_heal_events_outcome_check
  check (outcome in ('healed','failed','escalated','resolved','dismissed'));
