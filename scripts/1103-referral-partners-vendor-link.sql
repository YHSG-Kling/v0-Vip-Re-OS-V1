-- 1103: referral_partners.vendor_id — the missing LINK that makes referral reciprocity
-- HONEST. Inbound referrals were tracked (referral_partners.total_referrals_received) but
-- OUTBOUND (referrals/business the agent sends TO a partner) lived in a separate identity
-- space — vendor_assignments / vendor_bookings keyed by vendors.id, with no path back to
-- referral_partners. Without a link, "you've sent 0" is a lie (it's UNKNOWN, not zero). This
-- nullable link lets the Referral-Reciprocity Tracker count a partner's OUTBOUND from
-- vendor_bookings ONLY when the partner is linked to a marketplace vendor, and honestly say
-- "outbound not tracked yet — link this partner" otherwise. Applied live via Supabase MCP
-- migration `add_vendor_link_to_referral_partners`.

ALTER TABLE referral_partners
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_referral_partners_vendor ON referral_partners(vendor_id) WHERE vendor_id IS NOT NULL;
