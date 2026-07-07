-- l29-s01-self-book.sql — client self-booking joins the scheduling vocabulary.
-- A buyer picking a REAL open slot on the portal (the agent's live calendar
-- availability) books the showing directly; 'self_book' records that method.
ALTER TABLE public.showings DROP CONSTRAINT showings_scheduling_method_check;
ALTER TABLE public.showings ADD CONSTRAINT showings_scheduling_method_check
  CHECK (scheduling_method = ANY (ARRAY['showingtime','manual_call','email','text','self_book','other']));
