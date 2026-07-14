-- l52-s01 — SELLER WALK-AWAY FLOOR (owner-corrected forgotten-items #35:
-- seller-side only, never a buyer gate) + COVERAGE MODE (forgotten-items
-- #12: reversible vacation/illness reassignment). Ran live 2026-07-13.
alter table public.listings add column if not exists seller_walkaway_price numeric;
alter table public.agents
  add column if not exists covering_agent_id uuid references public.agents(id),
  add column if not exists coverage_until timestamptz;
