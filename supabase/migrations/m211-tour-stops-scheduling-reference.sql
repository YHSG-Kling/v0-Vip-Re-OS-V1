-- m211: Buyer-tour boundary burn (Shopping Agent owns tours/tour_stops).
-- 1) tour_stops.scheduling_reference — the ShowingTime appointment reference for a
--    confirmed stop. showings has this column; the tour-planner confirm path and the
--    showingtime webhook both write it on tour_stops, where it never existed (silent drop).
-- 2) tours.updated_at — stamped by every updateTour() call but the column was missing.
ALTER TABLE public.tour_stops ADD COLUMN IF NOT EXISTS scheduling_reference text;
ALTER TABLE public.tours      ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
