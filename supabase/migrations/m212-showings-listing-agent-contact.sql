-- m212: showings listing-agent contact (Listing Concierge boundary burn).
-- The tour-planner confirm path stamps the listing-side contact onto the linked
-- in-house showing; showings already has listing_agent_company but name/phone
-- never existed, so both were silently dropped on every confirmation.
ALTER TABLE public.showings ADD COLUMN IF NOT EXISTS listing_agent_name text;
ALTER TABLE public.showings ADD COLUMN IF NOT EXISTS listing_agent_phone text;
