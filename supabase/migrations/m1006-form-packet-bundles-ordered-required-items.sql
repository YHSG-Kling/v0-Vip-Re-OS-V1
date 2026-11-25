-- ── WRITTEN, NOT APPLIED (wave 156, lane 156C) — the integrator applies this additive migration ──
--
-- m1006 — PACKET BUNDLES: an ordered list of forms with required / optional markers, owned by the brokerage, one office or one team,
--         for ONE state (and optionally one county), with the source of every requirement recorded.
--
-- Owner (wave 156): "Allow packet bundles (e.g. listing, buyer representation, outside offer, counter, price change, inspection
-- addendum, closing packet) with editable ordered items and required/optional markers. Individual users can add authorized custom
-- supplemental forms but cannot delete required brokerage/legal forms. State or county policy can add required items; do not create a
-- universal all-state list."
--
-- AUDIT FIRST (CLAUDE.md §1): no table holds an ordered, owner-scoped bundle. lib/state-forms/registry.ts holds per-state package
-- NAMES (code, not tenant data) and lib/forms/state-package-match.ts matches them to library file names — both survive and are read
-- by the state_preconfigured door (lib/forms/form-directory-intake.ts). brokerage_form_library rows are the bundle's items' forms.
--
-- THE TABLES (tenant column brokerage_id NOT NULL; RLS on; policies written out):
--   form_packet_bundles       — owner (team_id XOR location_id XOR brokerage-wide), state, county, bundle_kind, name, is_active.
--   form_packet_bundle_items  — bundle_id, position, the form (library_form_id OR provider_name + provider_form_id OR a named
--                               requirement only), required_name, is_required, requirement_source, county, added_by, removed_at
--                               (soft removal — a removed item is history, not a hole).
-- Vocabularies mirror lib/forms/form-packet-bundles.ts PACKET_BUNDLE_KINDS / BUNDLE_REQUIREMENT_SOURCES (CLAUDE.md §6).
-- Writes in the product go through the service client AFTER the code gate (lib/forms/form-packet-bundles.ts); the authenticated
-- policies below are the same shape as brokerage_form_library's (m853/m854): a tenant staff seat reads its brokerage's bundles; the
-- oversight class (or a team's lead, for that team) writes.

CREATE TABLE IF NOT EXISTS public.form_packet_bundles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  team_id      uuid REFERENCES public.teams(id) ON DELETE CASCADE,
  location_id  uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  state        text NOT NULL,
  county       text,
  bundle_kind  text NOT NULL,
  name         text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT form_packet_bundles_state_check CHECK (state ~ '^[A-Z]{2}$'),
  CONSTRAINT form_packet_bundles_bundle_kind_check CHECK (bundle_kind = ANY (ARRAY['listing','buyer_representation','offer','outside_offer','counter_offer','price_change','inspection_addendum','closing','custom'])),
  CONSTRAINT form_packet_bundles_one_owner CHECK (num_nonnulls(team_id, location_id) <= 1)
);

CREATE TABLE IF NOT EXISTS public.form_packet_bundle_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id       uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  bundle_id          uuid NOT NULL REFERENCES public.form_packet_bundles(id) ON DELETE CASCADE,
  position           integer NOT NULL,
  library_form_id    uuid REFERENCES public.brokerage_form_library(id) ON DELETE SET NULL,
  provider_name      text,
  provider_form_id   text,
  required_name      text NOT NULL,
  is_required        boolean NOT NULL DEFAULT false,
  requirement_source text NOT NULL,
  county             text,
  added_by           uuid REFERENCES public.users(id) ON DELETE SET NULL,
  removed_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT form_packet_bundle_items_position_check CHECK (position >= 0),
  CONSTRAINT form_packet_bundle_items_requirement_source_check CHECK (requirement_source = ANY (ARRAY['brokerage','office','team','state_policy','county_policy','user_supplemental'])),
  CONSTRAINT form_packet_bundle_items_supplemental_is_optional CHECK (requirement_source <> 'user_supplemental' OR is_required = false),
  CONSTRAINT form_packet_bundle_items_county_policy_names_county CHECK (requirement_source <> 'county_policy' OR county IS NOT NULL),
  CONSTRAINT form_packet_bundle_items_one_form CHECK (library_form_id IS NULL OR provider_form_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_form_packet_bundles_lookup ON public.form_packet_bundles (brokerage_id, state, bundle_kind) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_form_packet_bundle_items_bundle ON public.form_packet_bundle_items (bundle_id, position) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_form_packet_bundle_items_brokerage ON public.form_packet_bundle_items (brokerage_id);
CREATE INDEX IF NOT EXISTS idx_form_packet_bundle_items_library_form ON public.form_packet_bundle_items (library_form_id) WHERE library_form_id IS NOT NULL;

ALTER TABLE public.form_packet_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_packet_bundle_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS form_packet_bundles_tenant_select ON public.form_packet_bundles;
CREATE POLICY form_packet_bundles_tenant_select ON public.form_packet_bundles FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id() AND public.brokerage_forms_seat_active());
DROP POLICY IF EXISTS form_packet_bundles_tenant_write ON public.form_packet_bundles;
CREATE POLICY form_packet_bundles_tenant_write ON public.form_packet_bundles FOR ALL TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id() AND ((public.is_brokerage_admin() AND COALESCE(public.current_user_type(), '') <> 'team_lead') OR (team_id IS NOT NULL AND team_id = public.current_user_led_team_id())))
  WITH CHECK (brokerage_id = public.current_user_brokerage_id() AND ((public.is_brokerage_admin() AND COALESCE(public.current_user_type(), '') <> 'team_lead') OR (team_id IS NOT NULL AND team_id = public.current_user_led_team_id())));
DROP POLICY IF EXISTS service_role_form_packet_bundles ON public.form_packet_bundles;
CREATE POLICY service_role_form_packet_bundles ON public.form_packet_bundles FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS form_packet_bundle_items_tenant_select ON public.form_packet_bundle_items;
CREATE POLICY form_packet_bundle_items_tenant_select ON public.form_packet_bundle_items FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id() AND public.brokerage_forms_seat_active());
-- Item writes are the bundle MANAGER's (supplemental items a seat adds for itself go through the code gate + service client).
DROP POLICY IF EXISTS form_packet_bundle_items_tenant_write ON public.form_packet_bundle_items;
CREATE POLICY form_packet_bundle_items_tenant_write ON public.form_packet_bundle_items FOR ALL TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id() AND EXISTS (
    SELECT 1 FROM public.form_packet_bundles b WHERE b.id = bundle_id AND b.brokerage_id = form_packet_bundle_items.brokerage_id
      AND ((public.is_brokerage_admin() AND COALESCE(public.current_user_type(), '') <> 'team_lead') OR (b.team_id IS NOT NULL AND b.team_id = public.current_user_led_team_id()))))
  WITH CHECK (brokerage_id = public.current_user_brokerage_id() AND EXISTS (
    SELECT 1 FROM public.form_packet_bundles b WHERE b.id = bundle_id AND b.brokerage_id = form_packet_bundle_items.brokerage_id
      AND ((public.is_brokerage_admin() AND COALESCE(public.current_user_type(), '') <> 'team_lead') OR (b.team_id IS NOT NULL AND b.team_id = public.current_user_led_team_id()))));
DROP POLICY IF EXISTS service_role_form_packet_bundle_items ON public.form_packet_bundle_items;
CREATE POLICY service_role_form_packet_bundle_items ON public.form_packet_bundle_items FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.form_packet_bundles IS 'wave 156 (156C): ordered packet bundles per owner and state — lib/forms/form-packet-bundles.ts.';
COMMENT ON TABLE public.form_packet_bundle_items IS 'wave 156 (156C): bundle items with required/optional and requirement source; state/county policy items are never removed through the product door.';
