-- m367 — the buyer-lifecycle statistics were one query PER CONTACT.
--
-- getLifecycleStatistics() fetched every contact in the brokerage and then called
-- getCurrentBuyerState(contactId) in a loop; each of those is its own SELECT on
-- lifecycle_events ordered by created_at LIMIT 1. N contacts = N+1 round trips, and the
-- contact query had no limit at all — a brokerage with 5,000 contacts issued 5,001
-- queries to render one statistics panel. getBuyersInState() had the same loop.
--
-- "Latest row per group" is a set operation, and Postgres does it in one pass with
-- DISTINCT ON. This function is that one pass.
--
-- SEMANTICS PRESERVED EXACTLY (this replaces a reader, it must not change the numbers):
--   · the date window filters CONTACTS by contacts.created_at — NOT the events. The old
--     code passed no dates into getLifecycleHistory, so a contact's current state was
--     always all-time. Filtering events by the window here would silently change every
--     historical figure.
--   · only the LATEST event per contact counts, by created_at DESC.
--   · a contact with no buyer_lifecycle event contributes to totalBuyers but to no state,
--     which is why this returns only contacts that HAVE a state — the caller counts the
--     total separately.
--
-- SECURITY INVOKER (the default) on purpose: this must NOT be SECURITY DEFINER. It takes a
-- brokerage id as an argument, so a definer-rights version would hand any authenticated
-- caller every other tenant's lifecycle data just by passing a different uuid. Invoker
-- rights keep RLS in force; the service client that calls it today bypasses RLS anyway.
create or replace function public.buyer_lifecycle_current_states(
  p_brokerage_id uuid,
  p_start        timestamptz default null,
  p_end          timestamptz default null
)
returns table (contact_id uuid, current_state text, entered_at timestamptz)
language sql
stable
set search_path = public
as $$
  select distinct on (e.entity_id)
         e.entity_id                 as contact_id,
         (e.metadata ->> 'to_state') as current_state,
         e.created_at                as entered_at
  from lifecycle_events e
  join contacts c
    on c.id = e.entity_id
   and c.brokerage_id = p_brokerage_id
  where e.entity_type  = 'buyer_lifecycle'
    and e.brokerage_id = p_brokerage_id
    and (e.metadata ->> 'to_state') is not null
    and (p_start is null or c.created_at >= p_start)
    and (p_end   is null or c.created_at <= p_end)
  order by e.entity_id, e.created_at desc;
$$;

comment on function public.buyer_lifecycle_current_states(uuid, timestamptz, timestamptz) is
  'Latest buyer_lifecycle state per contact for a brokerage, in ONE pass. Replaces an N+1 '
  'loop that issued a query per contact. The date window filters contacts.created_at, not '
  'the events — matching the reader it replaced.';

-- The existing idx_lifecycle_entity is (entity_type, entity_id) with no created_at, so the
-- DISTINCT ON above would have to sort every matching row. Adding created_at DESC lets the
-- index supply the ordering directly.
create index if not exists idx_lifecycle_entity_created
  on public.lifecycle_events (entity_type, entity_id, created_at desc);
