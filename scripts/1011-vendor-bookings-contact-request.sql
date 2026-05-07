-- Migration 1011: Allow contact-initiated vendor booking requests.
-- Contacts may request a vendor booking from their portal even before an
-- active transaction exists. Agent reviews + approves before vendor is
-- engaged. This also captures who originated the booking for analytics.

ALTER TABLE vendor_bookings
  ALTER COLUMN transaction_id DROP NOT NULL;

ALTER TABLE vendor_bookings
  ADD COLUMN IF NOT EXISTS request_origin TEXT
    CHECK (request_origin IN ('agent','contact','tc','vendor','admin')),
  ADD COLUMN IF NOT EXISTS request_message TEXT,
  ADD COLUMN IF NOT EXISTS preferred_time_window TEXT;

-- Status convention extension — contact requests start as 'pending_review'
-- which the agent then approves (→ 'confirmed') or declines (→ 'cancelled').
