-- m202 — give contacts a SECONDARY phone that is independently gateable.
-- Business reason: a contact often has two numbers and one may be on the DNC / opted out
-- while the other is reachable. PeopleData routinely returns a 2nd phone. Conserving it as a
-- first-class, independently-gated number lets the voice/SMS channel resolver fall back to the
-- reachable line instead of suppressing the contact entirely. Mirrors the primary's gate fields
-- (phone_status / phone_type / dnc_status / phone_verified) so the resolver logic is symmetric.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS phone_secondary            text,
  ADD COLUMN IF NOT EXISTS phone_secondary_status     text,
  ADD COLUMN IF NOT EXISTS phone_secondary_type       text,
  ADD COLUMN IF NOT EXISTS phone_secondary_dnc_status boolean,
  ADD COLUMN IF NOT EXISTS phone_secondary_opt_out    boolean,
  ADD COLUMN IF NOT EXISTS phone_secondary_verified   boolean;
