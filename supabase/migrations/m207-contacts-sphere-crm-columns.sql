-- m207 — sphere/CRM product columns on contacts (Data Steward burn + Sphere Manager value).
-- Code referenced these since day one but the columns never existed:
--   tags                    — CRM segmentation (text[]; campaign audiences, saved filters)
--   birthday                — sphere touchpoint date (the lifetime-customer-touchpoints
--   home_anniversary          cron literally selects these to schedule its outreach —
--                             every run silently failed)
--   avatar_url              — portal/CRM display
--   time_zone               — outreach timing + TCPA quiet-hours correctness per contact
--   preferred_contact_time  — agent courtesy + ISA scheduling hint
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS tags                   text[],
  ADD COLUMN IF NOT EXISTS birthday               date,
  ADD COLUMN IF NOT EXISTS home_anniversary       date,
  ADD COLUMN IF NOT EXISTS avatar_url             text,
  ADD COLUMN IF NOT EXISTS time_zone              text,
  ADD COLUMN IF NOT EXISTS preferred_contact_time text;
