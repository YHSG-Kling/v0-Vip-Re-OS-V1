-- m240 — TRANSACTION STATUS↔STAGE SYNC TRIGGER (mirror of m239 for the deal lifecycle)
-- ─────────────────────────────────────────────────────────────────────────────
-- transactions.stage (the post-contract deal machine: UNDER_CONTRACT → INSPECTION → APPRAISAL →
-- FINANCING_PENDING → CLOSING_PREP → CLOSED/LOST) and transactions.status (the coarse value readers
-- filter on: lead/qualifying/active/under_contract/closing/closed/lost). The two app writers
-- (advanceStage + the override path) already sync via STAGE_TO_STATUS_MAP, but there was NO DB-level
-- enforcement — so a bypass (or a pre-fix row) could drift. The live data already had a CLOSING_PREP
-- deal stuck at status='under_contract' instead of 'closing'.
--
-- Enforce it at the DB, like listings (m239): a BEFORE INSERT/UPDATE trigger maps stage → status. Only
-- acts on a stage CHANGE (a status-only update — e.g. a manual 'lost' that doesn't move the stage — is
-- left alone); on INSERT it only fills status when the inserter left it null (pre-contract rows with a
-- null stage keep their lead/qualifying/active status untouched).
--
-- INVARIANT: the CASE mirrors lib/transactions/transaction-stages.ts STAGE_TO_STATUS_MAP. Change both
-- together. All mapped values are valid per the transactions.status CHECK.

create or replace function public.sync_transaction_status_to_stage()
returns trigger
language plpgsql
as $$
declare
  mapped text;
begin
  mapped := case new.stage
    when 'UNDER_CONTRACT'    then 'under_contract'
    when 'INSPECTION'        then 'under_contract'
    when 'APPRAISAL'         then 'under_contract'
    when 'FINANCING_PENDING' then 'closing'
    when 'CLOSING_PREP'      then 'closing'
    when 'CLOSED'            then 'closed'
    when 'LOST'              then 'lost'
    else null  -- null/unknown stage (e.g. pre-contract) → do not touch status
  end;

  if mapped is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status is null then
      new.status := mapped;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.stage is distinct from old.stage then
      new.status := mapped;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_transaction_status_to_stage on public.transactions;
create trigger trg_sync_transaction_status_to_stage
  before insert or update on public.transactions
  for each row
  execute function public.sync_transaction_status_to_stage();

-- One-time backfill: correct any EXISTING drifted rows (stage set but status not its mapped value).
-- Status-only update → the trigger leaves it (stage unchanged), so the explicit value below stands.
update public.transactions t set status = m.mapped
from (
  select id, case stage
    when 'UNDER_CONTRACT' then 'under_contract' when 'INSPECTION' then 'under_contract'
    when 'APPRAISAL' then 'under_contract' when 'FINANCING_PENDING' then 'closing'
    when 'CLOSING_PREP' then 'closing' when 'CLOSED' then 'closed' when 'LOST' then 'lost'
  end as mapped
  from public.transactions where stage is not null
) m
where t.id = m.id and m.mapped is not null and t.status is distinct from m.mapped;

comment on function public.sync_transaction_status_to_stage() is
  'm240: keeps transactions.status in lockstep with stage (mirrors lib/transactions/transaction-stages.ts STAGE_TO_STATUS_MAP). The single un-bypassable enforcement for the deal status-stage invariant.';
