-- ── APPLIED LIVE 2026-11-01 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 148, lane 148B ──
--
-- m910 — EVERY MARKETING EMAIL CARRIES AN UNSUBSCRIBE THAT IS NOT AN ENTITY ID (wave 148, lane 148B; owner ruling 3, contract C16).
--
-- OWNER, verbatim (2026-11-01): "all forms need to have the same consent boxes along with follow up that has an easy way to
-- unsubscribe including on SMS to comply with the law."
--
-- THE DEFECT. lib/kernel/communications/assemble-email.ts stamped `/unsubscribe?contactId=<contacts.id>` into every
-- non-transactional email. An entity id is a lookup key, not a credential (app/api/unsubscribe/route.ts §4 records why:
-- forward one marketing email and the recipient holds a permanent suppression capability for the original addressee, and the
-- ledger records it as that person's request — every such row is labelled `email_footer_unverified`). And because the link was
-- not a credential, no RFC 8058 one-click `List-Unsubscribe-Post` header could honestly be advertised.
--
-- THE FIX. One random per-contact token, used ONLY in the unsubscribe link / List-Unsubscribe header:
--   · assemble-email.ts reads it (select '*' — a database without this column yields "no token" and the legacy link, never a
--     refused read) and emits `/unsubscribe?c=<contact id>&t=<token>` + `List-Unsubscribe: <…/api/unsubscribe?c=…&t=<token>>` +
--     `List-Unsubscribe-Post: List-Unsubscribe=One-Click`;
--   · app/api/unsubscribe/route.ts reads the contact by its primary key, compares the token in constant time, and writes the suppression through THE one writer
--     (lib/kernel/compliance/check-suppression.ts addSuppression) with source `email_footer` / `email_one_click`.
-- Rotation = UPDATE contacts SET unsubscribe_token = gen_random_uuid() WHERE id = … (one column; no FK depends on it).
--
-- A volatile DEFAULT on ADD COLUMN is evaluated PER ROW (Postgres rewrites the table), so every existing contact receives its own
-- distinct token — no backfill statement is needed and no two rows share one.
--
-- Regenerate after applying: scripts/schema-snapshot.ts (contacts + unsubscribe_token). No CHECK, no FK.

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS contacts_unsubscribe_token_uq ON public.contacts (unsubscribe_token);

COMMENT ON COLUMN public.contacts.unsubscribe_token IS
  'wave 148 (m910, C16): per-contact random credential used ONLY in the email unsubscribe link and the List-Unsubscribe header (RFC 8058 one-click). Not an identifier — never expose it elsewhere; rotate by setting a new gen_random_uuid().';
