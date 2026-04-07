-- Add lead_id FK to chat_sessions so captured widget sessions link to their lead.
ALTER TABLE public.chat_sessions
  ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL;
