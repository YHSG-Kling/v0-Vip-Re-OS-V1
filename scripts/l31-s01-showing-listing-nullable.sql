-- l31-s01-showing-listing-nullable.sql — a showing/appointment isn't always
-- property-specific. Self-booking always comes from a property page (listing
-- known), but the AI RECEPTION lane books an appointment on a live call that
-- may be a general agent meeting with no listing yet. Relax listing_id.
ALTER TABLE public.showings ALTER COLUMN listing_id DROP NOT NULL;
