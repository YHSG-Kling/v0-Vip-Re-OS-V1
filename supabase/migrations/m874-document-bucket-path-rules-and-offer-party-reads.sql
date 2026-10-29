-- WRITTEN, NOT APPLIED (wave 146, lane 146A) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL-editor
--
-- m874 — THE FOUR PRIVATE DOCUMENT BUCKETS' PATH RULES, THE OFFER ROW'S PARTY READS, AND A LIVE POLICY-READINESS READ
-- (wave 146, lane 146A — owner ruling 20 priority 1: "the Supabase access-control exposure").
--
-- PUBLIC SCHEMA ONLY — the integrator applies this file through the Supabase MCP. The storage.objects policies that USE the path
-- rules below are m875 (owner-held: the MCP role `postgres` is not the owner of storage.objects and not a member of
-- supabase_storage_admin — re-measured 2026-10-29, pg_has_role = false — so CREATE / DROP POLICY on it is refused 42501). Apply THIS
-- file first: m875 refuses to run until these functions exist.
--
-- WHAT IS LIVE TODAY (measured 2026-10-29, project hrvaqgvukzxfskkcrwbt, read-only):
--   · storage.objects carries 15 BUCKET-WIDE policies on the four sibling buckets — "auth read / upload / update / delete
--     client-documents | offer-documents | transaction-documents" and "auth read / upload / update agent-documents" — each
--     `bucket_id = '<bucket>'` and nothing else, TO authenticated. Every signed-in user of ANY tenant (a portal contact or a vendor
--     seat included) can list, read, overwrite and delete every client's bank statement / W-9 / pre-approval, every offer PDF, every
--     deal file (wire instructions included) and every agent's licence. All four buckets are private (public = false) and the
--     whole storage schema holds 0 objects, which is the only reason nothing has leaked.
--   · public.offers' offers_tenant_select / _update / _delete are `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`:
--     a portal CONTACT or a VENDOR seat of the brokerage reads (and may update / delete) every offer of the brokerage — another buyer's
--     price and terms — and EVERY tenant's user reads an offer whose brokerage_id is NULL. Live offers: 0 (0 with NULL brokerage).
--
-- THE ACCESS REQUIREMENTS PER PARTY (audited from every writer and reader in app/ + lib/ — the door census is
-- scripts/transfer-classification-guard.ts section C; the business norms from .claude/skills/real-estate-expert — RESPA / transaction
-- management / NAR Code of Ethics confidentiality — and CLAUDE.md §4–§5):
--   TENANT STAFF ON THE DEAL — an ACTIVE staff seat (public.brokerage_forms_seat_active(), m854: the forms seat list = the tenant
--     admin roster + agent + tc; revoked when the account is suspended / removed or the agent deactivated) of the deal's brokerage who
--     is its oversight (the admin roster minus team_lead, as m854), its TC, one of its agents (agent / buyer / seller), or the lead of
--     one of those agents' team ("a team is a mini brokerage"; "teams see only their own board").
--   TENANT STAFF ON THE CONTACT — the same seat, the contact's own agent, its agent's team lead, the TC or the oversight class (the
--     contacts table's own RLS shape; stricter for team leads, who see their team's contacts only).
--   PORTAL CONTACT WHO IS A PARTY — their own contacts row (contacts.contact_user_id = auth.uid(), the link the portal invite writes),
--     an active account, and only their own folder / their own deal. "Contacts … see no financials — only their own."
--   VENDOR ON THE DEAL — a vendor seat (user_role_assignments.vendor_id) whose vendor is assigned to THIS transaction
--     (vendor_assignments, not cancelled; the vendor not archived / inactive) and of the deal's brokerage; a LENDER is a vendor whose
--     category is lender / refinance_lender (lib/kernel/lender-linkage.ts LENDER_BENCH_CATEGORIES — CLAUDE.md §4), a TITLE company is a
--     vendor of category 'title' or a title_company_users row for this transaction. They reach ONLY their own sub-folder of the deal.
--   The SERVER's own reads and writes (service role) bypass RLS and are gated in code; a bucket root that only the server writes gets
--   NO session arm at all.
--
-- HISTORICAL ACCESS AND TRANSFERS (owner ruling 24 + wave 146 lane 146A item 3 — "no silent ownership change"): every rule reads the
-- CURRENT membership (auth.uid(), users.brokerage_id, agents.is_active, teams, vendor_assignments.status) at query time — no stored
-- grant to forget, so leaving a team / brokerage / deal revokes at once. The deal file of a TRANSFERRED transaction is HELD: when a
-- transaction_documents row of the deal sits in a brokerage other than the transaction's (the adoption rail moves `transactions` but
-- keeps `transaction_documents` — explicit_transfer — in the archived source), no session reads, writes or deletes that deal's objects
-- until the explicit, evidenced transfer moves the rows (lib/kernel/brokerage-transfer.ts; docs/architecture/
-- FK-CHILD-TRANSFER-CLASSIFICATION.md). A signed URL already minted stays valid until its own expiry — RLS cannot revoke a bearer
-- token (published blind spot; the end state is sign-on-read, lib/kernel/document-custody.ts).
--
-- Every function is SECURITY DEFINER with a pinned search_path (the m854 pattern), returns false rather than NULL, and refuses a
-- `..` path segment. Nothing here creates a table, a column, a CHECK or an FK.

-- ── 0. helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- a path segment as a uuid, or NULL (never an error: a malformed key must refuse, not abort the whole list)
CREATE OR REPLACE FUNCTION public.document_path_uuid(p_segment text)
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $$
  SELECT CASE WHEN p_segment ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_segment::uuid END;
$$;

-- an external party's account is live: not removed, status active (NULL reads as active, as m854's seat)
CREATE OR REPLACE FUNCTION public.document_account_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce((
    SELECT u.deleted_at IS NULL AND coalesce(u.status, 'active') = 'active'
      FROM public.users u
     WHERE u.id = auth.uid()
     LIMIT 1
  ), false);
$$;

-- ── 1. TENANT STAFF on a deal / on a contact ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.document_staff_on_transaction(p_transaction_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(p_transaction_id IS NOT NULL AND public.brokerage_forms_seat_active() AND EXISTS (
    SELECT 1
      FROM public.transactions t
     WHERE t.id = p_transaction_id
       AND t.brokerage_id = public.current_user_brokerage_id()
       AND (
            (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
         OR public.is_tc_role()
         OR public.current_user_agent_id() IN (t.agent_id, t.buyer_agent_id, t.seller_agent_id)
         OR public.current_user_led_team_id() IN (public.agent_team_id(t.agent_id), public.agent_team_id(t.buyer_agent_id), public.agent_team_id(t.seller_agent_id))
       )
  ), false);
$$;

CREATE OR REPLACE FUNCTION public.document_staff_on_contact(p_contact_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(p_contact_id IS NOT NULL AND public.brokerage_forms_seat_active() AND EXISTS (
    SELECT 1
      FROM public.contacts c
     WHERE c.id = p_contact_id
       AND c.brokerage_id = public.current_user_brokerage_id()
       AND (
            (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
         OR public.is_tc_role()
         OR c.agent_id = public.current_user_agent_id()
         OR public.current_user_led_team_id() = public.agent_team_id(c.agent_id)
       )
  ), false);
$$;

-- ── 2. PORTAL CONTACT who is a party: their own record / their own deal ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.document_contact_self(p_contact_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(p_contact_id IS NOT NULL AND public.document_account_active() AND EXISTS (
    SELECT 1 FROM public.contacts c WHERE c.id = p_contact_id AND c.contact_user_id = auth.uid()
  ), false);
$$;

CREATE OR REPLACE FUNCTION public.document_contact_party_on_transaction(p_transaction_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(p_transaction_id IS NOT NULL AND public.document_account_active() AND EXISTS (
    SELECT 1
      FROM public.transactions t
      JOIN public.contacts c ON c.id IN (t.contact_id, t.buyer_contact_id, t.seller_contact_id)
     WHERE t.id = p_transaction_id
       AND c.contact_user_id = auth.uid()
       AND c.brokerage_id = t.brokerage_id
  ), false);
$$;

-- ── 3. VENDOR / LENDER / TITLE on the deal (p_kind: 'vendor' | 'lender' | 'title') ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.document_external_party_on_transaction(p_transaction_id uuid, p_kind text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(p_transaction_id IS NOT NULL AND p_kind IN ('vendor', 'lender', 'title') AND public.document_account_active() AND (
    EXISTS (
      SELECT 1
        FROM public.transactions t
        JOIN public.vendor_assignments va ON va.transaction_id = t.id AND va.brokerage_id = t.brokerage_id
        JOIN public.user_role_assignments ura ON ura.vendor_id = va.vendor_id AND ura.user_id = auth.uid()
        JOIN public.vendors v ON v.id = va.vendor_id
       WHERE t.id = p_transaction_id
         AND va.status IS DISTINCT FROM 'cancelled'
         AND coalesce(v.status, 'active') NOT IN ('archived', 'inactive')
         AND (p_kind = 'vendor'
              OR (p_kind = 'lender' AND v.category IN ('lender', 'refinance_lender'))
              OR (p_kind = 'title' AND v.category = 'title'))
    )
    OR (p_kind = 'title' AND EXISTS (
      SELECT 1
        FROM public.title_company_users tcu
        JOIN public.transactions t ON t.id = tcu.transaction_id
       WHERE tcu.user_id = auth.uid()
         AND tcu.transaction_id = p_transaction_id
         AND (tcu.brokerage_id IS NULL OR tcu.brokerage_id = t.brokerage_id)
    ))
  ), false);
$$;

-- ── 4. THE DEAL FILE OF A TRANSFERRED TRANSACTION IS HELD (ruling 24: explicit_transfer never moves silently) ───────────────
CREATE OR REPLACE FUNCTION public.document_transaction_file_held(p_transaction_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(EXISTS (
    SELECT 1
      FROM public.transactions t
      JOIN public.transaction_documents td ON td.transaction_id = t.id
     WHERE t.id = p_transaction_id
       AND td.brokerage_id IS NOT NULL
       AND td.brokerage_id <> t.brokerage_id
  ), false);
$$;

-- ── 5. THE PATH RULE — one rule per bucket, read and write (p_op: 'read' | 'write') ────────────────────────────────────────
-- transaction-documents (the deal file):
--   transactions/{tx}/{folder}/{file}      — the deal team; the title party in title/, the lender party in lender/
--   vendor-jobs/{brokerage}/{tx}/{file}    — the deal team; a vendor assigned to the deal (the path's brokerage must be the deal's)
-- client-documents (the client's own paperwork):
--   contacts/{contact}/{file}              — staff on that contact; the contact themselves
--   transactions/{tx}/{file}               — the deal team; a contact who is a party to the deal
--   avatars/{contact}-{stamp}.{ext}        — staff on that contact; the contact themselves (the portal profile photo)
--   vendors/{vendor}/{folder}/{file}       — the vendor's own seat; READ also by the vendor's brokerage books readers (a W-9)
--   {brokerage}/…, buyer-intake/…          — server only (buyer-financial, the intake token route, the auto-filing clerk): NO arm
-- agent-documents (an agent's licence and E&O certificate):
--   {user}/license|eo-insurance/{file}     — the agent themselves; READ also by the oversight class of the agent's CURRENT brokerage
-- offer-documents: NO session arm — every reader and writer is the server (app/api/offers/upload, lib/inbound-mail/offer-intake.ts).
CREATE OR REPLACE FUNCTION public.document_bucket_path_access(p_bucket text, p_name text, p_op text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(
    p_op IN ('read', 'write')
    AND p_name !~ '(^|/)\.\.(/|$)'
    AND CASE p_bucket
      WHEN 'transaction-documents' THEN (
        CASE seg.s1
          WHEN 'transactions' THEN
                seg.s4 <> ''
            AND NOT public.document_transaction_file_held(public.document_path_uuid(seg.s2))
            AND (    public.document_staff_on_transaction(public.document_path_uuid(seg.s2))
                 OR (seg.s3 = 'title'  AND public.document_external_party_on_transaction(public.document_path_uuid(seg.s2), 'title'))
                 OR (seg.s3 = 'lender' AND public.document_external_party_on_transaction(public.document_path_uuid(seg.s2), 'lender')))
          WHEN 'vendor-jobs' THEN
                seg.s4 <> ''
            AND NOT public.document_transaction_file_held(public.document_path_uuid(seg.s3))
            AND EXISTS (SELECT 1 FROM public.transactions t
                         WHERE t.id = public.document_path_uuid(seg.s3) AND t.brokerage_id = public.document_path_uuid(seg.s2))
            AND (    public.document_staff_on_transaction(public.document_path_uuid(seg.s3))
                 OR  public.document_external_party_on_transaction(public.document_path_uuid(seg.s3), 'vendor'))
          ELSE false
        END)
      WHEN 'client-documents' THEN (
        CASE seg.s1
          WHEN 'contacts' THEN
                seg.s3 <> ''
            AND (public.document_staff_on_contact(public.document_path_uuid(seg.s2)) OR public.document_contact_self(public.document_path_uuid(seg.s2)))
          WHEN 'transactions' THEN
                seg.s3 <> ''
            AND (public.document_staff_on_transaction(public.document_path_uuid(seg.s2)) OR public.document_contact_party_on_transaction(public.document_path_uuid(seg.s2)))
          WHEN 'avatars' THEN
                seg.s3 = '' AND substr(seg.s2, 37, 1) = '-'
            AND (public.document_staff_on_contact(public.document_path_uuid(left(seg.s2, 36))) OR public.document_contact_self(public.document_path_uuid(left(seg.s2, 36))))
          WHEN 'vendors' THEN
                seg.s4 <> ''
            AND (    (public.is_current_user_vendor(public.document_path_uuid(seg.s2)) AND public.document_account_active()
                      AND EXISTS (SELECT 1 FROM public.vendors v WHERE v.id = public.document_path_uuid(seg.s2) AND coalesce(v.status, 'active') NOT IN ('archived', 'inactive')))
                 OR (p_op = 'read' AND public.brokerage_forms_seat_active() AND public.can_read_brokerage_books()
                      AND EXISTS (SELECT 1 FROM public.vendors v WHERE v.id = public.document_path_uuid(seg.s2) AND v.brokerage_id = public.current_user_brokerage_id())))
          ELSE false
        END)
      WHEN 'agent-documents' THEN (
            seg.s2 IN ('license', 'eo-insurance') AND seg.s3 <> ''
        AND (    (seg.s1 = auth.uid()::text AND public.brokerage_forms_seat_active())
             OR (p_op = 'read' AND public.brokerage_forms_seat_active()
                 AND public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead'
                 AND EXISTS (SELECT 1 FROM public.users m
                              WHERE m.id = public.document_path_uuid(seg.s1) AND m.brokerage_id = public.current_user_brokerage_id()))))
      ELSE false
    END
  , false)
  FROM (SELECT split_part(p_name, '/', 1) AS s1, split_part(p_name, '/', 2) AS s2, split_part(p_name, '/', 3) AS s3, split_part(p_name, '/', 4) AS s4) seg;
$$;

CREATE OR REPLACE FUNCTION public.document_bucket_path_readable(p_bucket text, p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT public.document_bucket_path_access(p_bucket, p_name, 'read');
$$;

CREATE OR REPLACE FUNCTION public.document_bucket_path_writable(p_bucket text, p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT public.document_bucket_path_access(p_bucket, p_name, 'write');
$$;

-- ── 6. DELETE — the deal team; an external party only its OWN upload, only inside the compensating-delete window ────────────
-- The title / lender portals and the vendor door undo an upload whose record was then refused (lib/storage/put-and-sign.ts
-- removeOrRecordOrphan) — seconds after the upload. Past that window a filed deal document is evidence: an external party cannot
-- delete it (RESPA / brokerage record retention); the deal team removes it through app/actions/documents.ts deleteDocument.
-- client-documents and agent-documents get NO delete policy (no session door deletes there; the server's compensation uses the
-- service role), offer-documents none at all.
CREATE OR REPLACE FUNCTION public.document_bucket_object_deletable(p_bucket text, p_name text, p_owner_id text, p_created_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(
    p_bucket = 'transaction-documents'
    AND p_name !~ '(^|/)\.\.(/|$)'
    AND CASE seg.s1
      WHEN 'transactions' THEN
            seg.s4 <> ''
        AND NOT public.document_transaction_file_held(public.document_path_uuid(seg.s2))
        AND (    public.document_staff_on_transaction(public.document_path_uuid(seg.s2))
             OR (p_owner_id = auth.uid()::text AND p_created_at > now() - interval '15 minutes'
                 AND ((seg.s3 = 'title'  AND public.document_external_party_on_transaction(public.document_path_uuid(seg.s2), 'title'))
                   OR (seg.s3 = 'lender' AND public.document_external_party_on_transaction(public.document_path_uuid(seg.s2), 'lender')))))
      WHEN 'vendor-jobs' THEN
            seg.s4 <> ''
        AND NOT public.document_transaction_file_held(public.document_path_uuid(seg.s3))
        AND EXISTS (SELECT 1 FROM public.transactions t
                     WHERE t.id = public.document_path_uuid(seg.s3) AND t.brokerage_id = public.document_path_uuid(seg.s2))
        AND (    public.document_staff_on_transaction(public.document_path_uuid(seg.s3))
             OR (p_owner_id = auth.uid()::text AND p_created_at > now() - interval '15 minutes'
                 AND public.document_external_party_on_transaction(public.document_path_uuid(seg.s3), 'vendor')))
      ELSE false
    END
  , false)
  FROM (SELECT split_part(p_name, '/', 1) AS s1, split_part(p_name, '/', 2) AS s2, split_part(p_name, '/', 3) AS s3, split_part(p_name, '/', 4) AS s4) seg;
$$;

COMMENT ON FUNCTION public.document_bucket_path_access(text, text, text) IS
  'm874 (wave 146, lane 146A): THE path rule of the four private document buckets (client-documents, transaction-documents, agent-documents; offer-documents has no session arm) — tenant staff on the deal / contact, a contact party, a vendor / lender / title party on the deal, an agent''s own licence; current membership read at query time; a transferred deal file is held. Used by the m875 storage.objects policies.';

-- ── 7. THE OFFER ROW: who may read / change it (offers_tenant_select / _update / _delete) ───────────────────────────────────
-- An offer is the buyer's confidential price and terms. The listing side presents it to the seller; the buyer's side holds it for the
-- buyer; no other agent of the brokerage — in particular an in-house agent for a COMPETING buyer on the same listing — may read it
-- (designated-agency confidentiality; NAR Code of Ethics Art. 1). So, beside the unchanged agent_manage_offers (an agent's own offer,
-- listing or deal): the oversight class and the TC of the offer's brokerage, the lead of a team whose agent is on the offer / listing
-- / deal, and — read only — the BUYER contact of the offer and the SELLER contact of the listing (both through contact_user_id).
-- Never a vendor, never another buyer, never an offer whose brokerage_id is NULL (unattributable — nobody's to read through the API).
CREATE OR REPLACE FUNCTION public.offer_staff_visible(p_offer_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(p_offer_id IS NOT NULL AND public.brokerage_forms_seat_active() AND EXISTS (
    SELECT 1
      FROM public.offers o
      LEFT JOIN public.listings l ON l.id = o.listing_id
      LEFT JOIN public.transactions t ON t.id = o.transaction_id
     WHERE o.id = p_offer_id
       AND o.brokerage_id IS NOT NULL
       AND o.brokerage_id = public.current_user_brokerage_id()
       AND (
            (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
         OR public.is_tc_role()
         OR public.current_user_led_team_id() IN (public.agent_team_id(o.agent_id), public.agent_team_id(l.agent_id),
                                                  public.agent_team_id(t.agent_id), public.agent_team_id(t.buyer_agent_id), public.agent_team_id(t.seller_agent_id))
       )
  ), false);
$$;

CREATE OR REPLACE FUNCTION public.offer_contact_party_visible(p_offer_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(p_offer_id IS NOT NULL AND public.document_account_active() AND EXISTS (
    SELECT 1
      FROM public.offers o
     WHERE o.id = p_offer_id
       AND o.brokerage_id IS NOT NULL
       AND (
            EXISTS (SELECT 1 FROM public.contacts c
                     WHERE c.id = o.contact_id AND c.contact_user_id = auth.uid() AND c.brokerage_id = o.brokerage_id)
         OR EXISTS (SELECT 1 FROM public.listings l JOIN public.contacts c ON c.id = l.seller_contact_id
                     WHERE l.id = o.listing_id AND l.brokerage_id = o.brokerage_id AND c.contact_user_id = auth.uid())
       )
  ), false);
$$;

ALTER POLICY offers_tenant_select ON public.offers
  USING (public.offer_staff_visible(id) OR public.offer_contact_party_visible(id));

ALTER POLICY offers_tenant_update ON public.offers
  USING (public.offer_staff_visible(id))
  WITH CHECK (brokerage_id IS NOT NULL AND brokerage_id = public.current_user_brokerage_id() AND public.brokerage_forms_seat_active());

ALTER POLICY offers_tenant_delete ON public.offers
  USING (public.offer_staff_visible(id));

-- ── 8. THE READINESS READ — what the LIVE database says about each private bucket's storage policies ───────────────────────
-- Never "applied" until pg_policies says so: a migration header is a claim, this is the measurement. Verdicts:
--   owner_scoped  — the live policy set naming the bucket is EXACTLY the owner set and every one calls its path rule
--   service_only  — no session policy names the bucket and none is expected (offer-documents; documents — the universal
--                   document lane every writer of which is the server or a server-minted signed upload)
--   open          — a policy for authenticated / anon / public names the bucket (or no bucket at all) without the path rule
--   incomplete    — no open rule, but the live set is not exactly the owner set (some missing or extra)
--   open_public_bucket / bucket_missing — storage.buckets says so
-- Service role only (it reads policy text): the integrator through the MCP, the owner in the SQL editor, a server readiness probe.
CREATE OR REPLACE FUNCTION public.storage_bucket_policy_readiness()
RETURNS TABLE (bucket_id text, bucket_exists boolean, bucket_public boolean, verdict text, expected_policies text[], live_policies text[], missing_policies text[], unscoped_policies text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  WITH expected(bucket_id, rule_fn, names) AS (
    VALUES
      ('brokerage-forms'::text,      'brokerage_forms_path_'::text, ARRAY['brokerage-forms owner delete', 'brokerage-forms owner read', 'brokerage-forms owner update', 'brokerage-forms owner upload']::text[]),
      ('client-documents'::text,     'document_bucket_'::text,      ARRAY['client-documents owner read', 'client-documents owner upload']::text[]),
      ('transaction-documents'::text,'document_bucket_'::text,      ARRAY['transaction-documents owner delete', 'transaction-documents owner read', 'transaction-documents owner upload']::text[]),
      ('agent-documents'::text,      'document_bucket_'::text,      ARRAY['agent-documents owner read', 'agent-documents owner upload']::text[]),
      ('offer-documents'::text,      NULL::text,                    ARRAY[]::text[]),
      ('documents'::text,            NULL::text,                    ARRAY[]::text[])
  ),
  pol AS (
    SELECT p.policyname::text AS name, coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') AS expr
      FROM pg_catalog.pg_policies p
     WHERE p.schemaname = 'storage' AND p.tablename = 'objects'
       AND p.roles && ARRAY['authenticated', 'anon', 'public']::name[]
  ),
  per AS (
    SELECT e.bucket_id, e.names,
           coalesce(array_agg(pol.name ORDER BY pol.name) FILTER (WHERE pol.name IS NOT NULL), ARRAY[]::text[]) AS live,
           coalesce(array_agg(pol.name ORDER BY pol.name) FILTER (WHERE pol.name IS NOT NULL AND (e.rule_fn IS NULL OR position(e.rule_fn in pol.expr) = 0)), ARRAY[]::text[]) AS unscoped
      FROM expected e
      LEFT JOIN pol ON position('''' || e.bucket_id || '''' in pol.expr) > 0 OR position('bucket_id' in pol.expr) = 0
     GROUP BY e.bucket_id, e.names
  )
  SELECT per.bucket_id,
         b.id IS NOT NULL,
         coalesce(b.public, false),
         CASE WHEN b.id IS NULL THEN 'bucket_missing'
              WHEN b.public THEN 'open_public_bucket'
              WHEN cardinality(per.unscoped) > 0 THEN 'open'
              WHEN NOT (per.names <@ per.live AND per.live <@ per.names) THEN 'incomplete'
              WHEN cardinality(per.names) = 0 THEN 'service_only'
              ELSE 'owner_scoped' END,
         per.names,
         per.live,
         ARRAY(SELECT x FROM unnest(per.names) AS x EXCEPT SELECT y FROM unnest(per.live) AS y ORDER BY 1),
         per.unscoped
    FROM per
    LEFT JOIN storage.buckets b ON b.id = per.bucket_id
   ORDER BY per.bucket_id;
$$;

REVOKE ALL ON FUNCTION public.storage_bucket_policy_readiness() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.storage_bucket_policy_readiness() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_bucket_policy_readiness() TO service_role;

COMMENT ON FUNCTION public.storage_bucket_policy_readiness() IS
  'm874 (wave 146, lane 146A): the LIVE storage.objects policy state of each private document bucket (brokerage-forms, client-documents, transaction-documents, agent-documents, offer-documents, documents) — owner_scoped | service_only | open | incomplete | open_public_bucket | bucket_missing. Read from pg_policies, never from a migration header. Service role only.';
