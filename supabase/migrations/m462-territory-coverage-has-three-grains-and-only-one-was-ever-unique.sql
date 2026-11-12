-- m462 — territory coverage has three grains, and only one of them was ever unique.
-- ─────────────────────────────────────────────────────────────────────────────
-- MEASURED BEFORE WRITING THIS (live db, hrvaqgvukzxfskkcrwbt):
--
--   subscriber_service_areas: 0 rows. ZERO. Not "sparse" — the per-zip territory
--   roster that lib/platform/distribution-engine.ts routes every platform lead
--   through has never held a single row. lead_scraping_markets is also empty, and
--   since the market sync was the ONLY writer, that is not a coincidence: nobody
--   has ever been able to claim a territory, because there was nowhere to do it.
--
--   Existing indexes:
--     uq_service_area_brokerage_zip  UNIQUE (brokerage_id, zip_code)
--                                    WHERE agent_user_id IS NULL AND team_id IS NULL
--
-- So the brokerage grain WAS already protected (contrary to the "no unique index"
-- note in the check-then-insert comment in app/actions/lead-scraping-config.ts —
-- that comment is stale and is corrected in the same change as this migration).
-- What was NOT protected is the other two grains the table's own columns declare:
--
--   brokerage grain  team_id IS NULL     agent_user_id IS NULL     → PROTECTED
--   team grain       team_id NOT NULL    agent_user_id IS NULL     → unprotected
--   agent grain      agent_user_id NOT NULL                        → unprotected
--
-- These are DIFFERENT ROWS, not conflicts: "the brokerage covers 90210", "the
-- Westside team covers 90210", and "Dana covers 90210" are three separate, all
-- simultaneously-true facts, and the distribution engine deliberately reads only
-- the first (it filters .is("agent_user_id", null).is("team_id", null)). That is
-- why the right shape is THREE partial unique indexes at three grains, and NOT a
-- single unique on (brokerage_id, zip_code, team_id, agent_user_id): NULLs are
-- not equal to each other in a btree unique, so that composite would have let the
-- brokerage grain duplicate freely — the exact defect it was meant to close.
--
-- With these in place the new Settings → Territories writers can stop pretending
-- check-then-insert is safe: a concurrent claim now fails loudly with 23505, which
-- the action catches and reports as "already claimed" instead of silently forking
-- the roster into two rows that both look authoritative.

-- ── TEAM GRAIN ───────────────────────────────────────────────────────────────
-- One claim per (brokerage, team, zip). agent_user_id must be NULL here: a row
-- carrying BOTH a team and an agent is an agent claim, covered by the next index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_area_team_zip
  ON public.subscriber_service_areas (brokerage_id, team_id, zip_code)
  WHERE team_id IS NOT NULL AND agent_user_id IS NULL;

-- ── AGENT GRAIN ──────────────────────────────────────────────────────────────
-- One claim per (brokerage, agent, zip). team_id is NOT in the key on purpose —
-- an agent covering a zip covers it once, whether or not the claim also records
-- which team they sat on when it was made. Keying on team_id too would let the
-- same agent hold two live claims on one zip by moving teams.
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_area_agent_zip
  ON public.subscriber_service_areas (brokerage_id, agent_user_id, zip_code)
  WHERE agent_user_id IS NOT NULL;

-- ── AT MOST ONE PRIMARY PER CLAIMANT ─────────────────────────────────────────
-- is_primary has a DEFAULT false and has never been true on any row, because no
-- surface could set it. "Primary" means one zip, not a flag anyone may sprinkle:
-- these enforce that per claimant, at each of the three grains.
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_area_primary_brokerage
  ON public.subscriber_service_areas (brokerage_id)
  WHERE is_primary AND active AND team_id IS NULL AND agent_user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_area_primary_team
  ON public.subscriber_service_areas (brokerage_id, team_id)
  WHERE is_primary AND active AND team_id IS NOT NULL AND agent_user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_area_primary_agent
  ON public.subscriber_service_areas (brokerage_id, agent_user_id)
  WHERE is_primary AND active AND agent_user_id IS NOT NULL;

-- ── RLS: NOT CHANGED, AND HERE IS WHY ────────────────────────────────────────
-- MEASURED: subscriber_service_areas has RLS enabled and four per-command
-- policies for `authenticated`, each scoped to the tenant and nothing else:
--
--   subscriber_service_areas_tenant_select  USING (brokerage_id = current_user_brokerage_id())
--   subscriber_service_areas_tenant_insert  WITH CHECK (brokerage_id = current_user_brokerage_id())
--   subscriber_service_areas_tenant_update  USING + WITH CHECK, both the same
--   subscriber_service_areas_tenant_delete  USING (brokerage_id = current_user_brokerage_id())
--
-- That is exactly what the new surface needs: a SESSION client can read and write
-- this table for its own tenant, so no service client is used anywhere in the
-- Settings → Territories lane. What RLS does NOT do is distinguish grains inside
-- a tenant — it will happily let an agent write a brokerage-wide row. The grain
-- gate therefore lives in app code (app/actions/settings/territories.ts, rules in
-- app/dashboard/settings/territories/territory-rules.ts) and is BELOW the
-- database's own boundary, never past it: RLS keeps other tenants out, the app
-- keeps the grains honest. Tightening the policies to encode the grain rule would
-- need a per-grain WITH CHECK naming teams.team_lead_id, which is a bigger change
-- than this surface justifies and is called out in the report rather than smuggled
-- in here.

-- ── MEASURED AFTER — a live behavioural proof, not a reading of the indexes ───
-- Run against the live project as admin@vip.demo (VIP Premier Realty), on
-- throwaway ZIPs 99901/99902/99903, deleted at the end. Residue 0, and the table
-- is back to the 0 rows it started with.
--
--   A  brokerage-grain claim on 99901 ......................... 1 row
--   B  the SAME brokerage-grain claim again .................. REFUSED 23505
--   C  a TEAM claim on the SAME zip ........................... 1 row
--   D  the same team claim again ............................. REFUSED 23505
--   E  an AGENT claim on the SAME zip ......................... 1 row
--   F  same agent + same zip, filed under a different team ... REFUSED 23505
--   G  a SECOND brokerage-grain is_primary ................... REFUSED 23505
--   H  a new primary once the old one was retired ............. 1 row
--   I  a claim stamped with ANOTHER brokerage's id ........... REFUSED 42501
--   J  rotation-visible rows for 99901 after retiring it ...... 0
--   ·  residue after cleanup .................................. 0
--
-- A/C/E together are the whole argument for three indexes instead of one: the
-- brokerage, the Westside team and Dana all cover 99901 simultaneously, and B/D/F
-- show each of those three facts can still only be stated once.
--
-- F is the one worth naming. The agent index deliberately leaves team_id OUT of
-- the key, so filing the same agent's claim on the same zip under a different team
-- is still a duplicate. Had team_id been in the key, moving teams would have
-- silently given one agent two live claims on one zip.
--
-- H is the control that makes G mean something. A refusal on G could have been a
-- permanent lock-out rather than the intended one-primary rule; retiring the old
-- primary and having the next one SUCCEED proves the primary indexes are scoped
-- `WHERE is_primary AND active` and release the slot, which is exactly why
-- setTerritoryActive clears is_primary when it deactivates a row.
--
-- J is the fact the whole surface turns on: once the brokerage-grain row is
-- retired, the platform rotation sees nothing for that zip — even though the team
-- and agent claims on it are still live. A team or agent claim is real and routes
-- no platform leads, and the UI says so rather than implying otherwise.
