-- Migration 1106: vendor invite / charge attribution (round 37)
--
-- "Agents and teams can invite vendors and charge them also."
-- Invites were already open to every tier (round 15); this migration makes the
-- vendor row record WHO brought the vendor so "THEIR vendors" is a queryable
-- fact the charge gate (issueVendorCharge, agent path) can enforce:
--   · invited_by_user_id — users.id of the first inviter (first inviter wins;
--     the writer stamps with a WHERE invited_by_user_id IS NULL guard).
--   · invited_by_team_id — the inviter's team at invite time (led team wins
--     over membership team; teams.team_lead_id is users.id).
--
-- Per-invitation history remains in vendor_invitations.invited_by (m1057);
-- these columns are the vendor-level rollup the charging lane reads.

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS invited_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invited_by_team_id UUID REFERENCES public.teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vendors_invited_by_user
  ON public.vendors(invited_by_user_id) WHERE invited_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vendors_invited_by_team
  ON public.vendors(invited_by_team_id) WHERE invited_by_team_id IS NOT NULL;

-- Backfill: earliest platform invitation per vendor (invited_by was already
-- recorded there since m1057). Team attribution is NOT backfilled — the
-- inviter's team at invite time is unknowable retroactively; stamping their
-- CURRENT team would fabricate history.
UPDATE public.vendors v
SET invited_by_user_id = vi.invited_by
FROM (
  SELECT DISTINCT ON (vendor_id) vendor_id, invited_by
  FROM public.vendor_invitations
  WHERE invited_by IS NOT NULL
  ORDER BY vendor_id, created_at ASC
) vi
WHERE vi.vendor_id = v.id
  AND v.invited_by_user_id IS NULL;
