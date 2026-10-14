-- ── APPLIED LIVE 2026-10-14 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m765 — BROKERAGE IDENTITY (wave 141, lane 141A). Owner ruling 2026-10-14, verbatim where quoted:
--   "a solo agent/team may subscribe independently and DECLARE an affiliated brokerage name for
--    business context — the brokerage is not a subscriber, the location is not on the platform,
--    another unrelated tenant may share the brand, another location may subscribe later.
--    BROKERAGE NAME MATCH IS NEVER PROOF OF SAME TENANT; never merge by name; identity uses
--    canonical IDs + verified relationships. Later adoption by the ACTUAL brokerage location = a
--    deliberate relationship transfer: identify the exact brokerage/location → explicit agent/team
--    permission → verify → migrate membership/data through canonical services → preserve
--    history/evidence → stop individual billing at the right effective time → Stripe proration →
--    no double billing → brokerage owns the seat/platform relationship."
--
-- SURVIVORS AUDITED AT 01a71c3c2 (none replaced):
--   · brokerages.brokerage_on_platform / team_on_platform (solo-agent flags, lib/platform/
--     disposition-route.ts) say WHETHER the agent's brokerage is a customer; they hold no identity.
--     The declared affiliation below is the missing identity half — CONTEXT ONLY, no tenancy effect.
--   · brokerages.status admits 'archived' and brokerages.archived_at exists (readers: tenant-readiness,
--     subscription-oversight, brand-listening) but NOTHING writes it — the transfer rail's archive
--     step (lib/kernel/brokerage-transfer.ts) is its first writer. Archived, never deleted.
--   · agent_book_transfers (m661) is an AGENT → AGENT book move inside one tenant — not a tenant
--     transfer; it stays. There was no tenant-to-tenant transfer object anywhere; this table is it.
--
-- Reader + writer of declared_affiliation: lib/kernel/brokerage-identity.ts (declareBrokerageAffiliation /
-- readDeclaredAffiliation), written by the tenant-creation core (lib/kernel/tenant-creation.ts, the
-- signup door's optional affiliation) and the solo/team owner's settings card
-- (app/actions/settings/brokerage-affiliation.ts). Until applied: the write is refused (PGRST204) and
-- REPORTED by the writer (extrasSkipped / the card's error), never swallowed; creation never fails on it.
--
-- Reader + writer of brokerage_transfer_requests: lib/kernel/brokerage-transfer.ts (the ONE transfer rail);
-- doors app/actions/brokerage-transfer.ts. TABLE_MANAGER data_steward (co-owned by recruiting_manager,
-- finance_manager, compliance_officer — MAINTENANCE_DOMAINS.brokerage_identity).
--
-- After applying: regenerate schema-snapshot, live-tables, the FK map AND scripts/check-vocabularies.ts
-- (two new CHECKs: status, target_role), then drop scripts/migration-claim-guard.ts NOT_APPLIED_BASELINE
-- back by one.
--
-- ── PART 1 — column + table (apply first; safe alone) ────────────────────────────────────────────

ALTER TABLE public.brokerages
  ADD COLUMN IF NOT EXISTS declared_affiliation jsonb NULL;

COMMENT ON COLUMN public.brokerages.declared_affiliation IS
  'm765 (wave 141A): the affiliated brokerage a SOLO/TEAM subscriber DECLARED for business context — {name, dba, license_number, license_state, city, state, external_ref, declared_at, declared_by_user_id, source}. CONTEXT ONLY: no reader may associate, merge or route tenants by it (brokerage name match is never proof of same tenant — owner ruling 2026-10-14). Writer: lib/kernel/brokerage-identity.ts declareBrokerageAffiliation.';

CREATE TABLE IF NOT EXISTS public.brokerage_transfer_requests (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- TENANT PIN: the TARGET brokerage-location tenant owns the request (the initiator's SESSION tenant).
  brokerage_id          uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- The independent subscriber tenant (solo_agent / team) whose membership + data move. RESTRICT: an
  -- archived source keeps its row — history and evidence are preserved, never deleted.
  source_brokerage_id   uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE RESTRICT,
  target_brokerage_id   uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE RESTRICT,
  -- The source tenant's OWNER whose explicit consent the transfer requires (users.id).
  subject_user_id       uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  -- The target brokerage admin who initiated it (users.id) — never a request-body actor.
  initiated_by_user_id  uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  -- The seat the subject takes in the target: a producing role, never an admin role by adoption.
  target_role           text        NOT NULL
    CONSTRAINT brokerage_transfer_requests_target_role_check
    CHECK (target_role IN ('agent', 'team_lead')),
  status                text        NOT NULL DEFAULT 'requested'
    CONSTRAINT brokerage_transfer_requests_status_check
    CHECK (status IN ('requested', 'consented', 'migrating', 'completed', 'declined', 'cancelled', 'failed')),
  reason                text        NULL,
  -- EVIDENCE, each a jsonb the rail writes once per stage (lib/kernel/brokerage-transfer.ts):
  consent               jsonb       NULL,   -- { user_id, at, decision, statement, channel, request_snapshot }
  verification          jsonb       NULL,   -- { at, checks: [{ key, ok, detail }] }
  migration             jsonb       NULL,   -- { attempts, steps: { <step>: { status, at, detail?, error? } }, counts }
  billing_handoff       jsonb       NULL,   -- the lib/billing/subscriber-billing-handoff.ts result
  readiness             jsonb       NULL,   -- the target's readiness verdict after the move
  effective_at          timestamptz NULL,
  completed_at          timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- The tenant pin IS the target: a request can never be filed under a third tenant.
  CONSTRAINT brokerage_transfer_requests_tenant_is_target CHECK (brokerage_id = target_brokerage_id),
  CONSTRAINT brokerage_transfer_requests_source_ne_target CHECK (source_brokerage_id <> target_brokerage_id)
);

COMMENT ON TABLE public.brokerage_transfer_requests IS
  'm765 (wave 141A): the ONE explicit transfer rail — an independent subscriber tenant (solo_agent/team) adopted by the ACTUAL brokerage-location tenant. Initiated by the target brokerage admin (canonical ids), consented by the source owner with evidence, verified, migrated through canonical services (membership, data families, billing handoff via lib/billing/subscriber-billing-handoff.ts), source ARCHIVED (never deleted), target readiness recorded. Idempotent and resumable (migration.steps). Written only by lib/kernel/brokerage-transfer.ts.';

-- ── PART 2 — indexes + RLS (apply after PART 1) ──────────────────────────────────────────────────

-- ONE open request per source tenant at a time (a second adoption attempt must wait or cancel the first).
CREATE UNIQUE INDEX IF NOT EXISTS brokerage_transfer_requests_one_open_per_source
  ON public.brokerage_transfer_requests (source_brokerage_id)
  WHERE status IN ('requested', 'consented', 'migrating');

CREATE INDEX IF NOT EXISTS brokerage_transfer_requests_target_idx
  ON public.brokerage_transfer_requests (brokerage_id, status);

CREATE INDEX IF NOT EXISTS brokerage_transfer_requests_subject_idx
  ON public.brokerage_transfer_requests (subject_user_id, status);

-- The live ensure_rls event trigger (m752) already enables RLS on every new table; stated here so a
-- rebuilt environment agrees. SELECT: platform staff, the target tenant (owner of the row) and the
-- SOURCE tenant (the subject reads the request they are asked to consent to). NO write policy for
-- authenticated: every write goes through the gated server actions on the service client.
ALTER TABLE public.brokerage_transfer_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY brokerage_transfer_requests_select ON public.brokerage_transfer_requests
  FOR SELECT TO authenticated
  USING (
    is_platform_admin()
    OR has_brokerage_access(brokerage_id)
    OR has_brokerage_access(source_brokerage_id)
  );

-- updated_at upkeep: the rail stamps updated_at on every write; no trigger is added (none of the
-- sibling evidence tables carry one, and a trigger is a second writer of the same column).
