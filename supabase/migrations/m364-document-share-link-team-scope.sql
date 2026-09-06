-- ═══════════════════════════════════════════════════════════════════════════
-- m364 — DOCUMENT SHARE LINKS become a BROKERAGE-SCOPED, ENFORCED capability.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FILE IS m364. It was authored as m356 and APPLIED to the live project under the
-- name "m356_document_share_link_team_scope_hardening" — but m356 was already
-- taken by m356_seller_side_document_classifications. The file is renumbered so
-- the repo sequence stays honest; the applied record keeps its original name.
--
-- OWNER RULING: "the share document is so the whole team has access."
--
-- That is a TEAM surface, not a public one. `createDocumentShareLink` /
-- `accessSharedDocument` in app/actions/dotloop-integration.ts had been written
-- as if it were public, and had never been reachable at all — the URL they
-- minted (/documents/shared/{token}) had no route behind it. This migration
-- supplies the schema the authenticated, team-scoped version needs.
--
-- ── WHAT WAS VERIFIED LIVE BEFORE WRITING THIS (information_schema + pg_policies)
--
-- 1. `max_access_count` DID NOT EXIST as a column. accessSharedDocument read
--    `link.max_access_count` and compared it — against `undefined`, on every
--    call, forever. The cap was not merely unenforced, it was UNSTORABLE.
--    Added nullable: NULL = unlimited, positive integer = hard cap.
--
-- 2. `brokerage_id` DID NOT EXIST on this table. If the boundary of a share is
--    the brokerage, the boundary has to live ON the link so RLS can apply it —
--    not be re-derived by every reader. Denormalized from
--    client_documents.brokerage_id at mint time.
--
-- 3. `dsl_select` ended in `OR (is_active AND share_token IS NOT NULL)`. That
--    clause exposed EVERY active link row — password_hash and
--    shared_with_email included — to any caller who could reach the table. It
--    is replaced by brokerage scoping below.
--
-- 4. `expires_at` was NULLABLE while the reader hard-rejects a null expiry, so
--    a null row was an unopenable row. NOT NULL makes unbounded access
--    unrepresentable rather than merely refused.
--
-- 5. `password_hash` was written and compared as PLAINTEXT
--    (`password_hash: data.password`, then `link.password_hash !== password`).
--    The CHECK below makes plaintext structurally impossible to store: a
--    non-null value must carry the scrypt envelope minted by
--    lib/security/share-password.ts.
--
-- 6. THE COUNT IS NOW AUTHORITATIVE. The old increment was
--    `await supabase.from(...).update(...)` with no `error` destructured, and
--    supabase-js RESOLVES a rejected write — so an RLS refusal reported success
--    while the counter never moved. And it WOULD be refused: dsl_update requires
--    `shared_by = auth.uid()`, which a teammate viewer is not. The counter never
--    advanced, so the cap could never be reached even had the column existed.
--    consume_document_share_access() replaces it: one conditional
--    UPDATE ... RETURNING, atomic under READ COMMITTED (Postgres re-evaluates
--    the WHERE against the locked row version), so two concurrent viewers cannot
--    both consume the last remaining slot.
--
-- The table held 0 rows when this was applied, so the backfills are no-ops here
-- and exist so the migration stays correct if replayed on a populated copy.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.document_sharing_links
  ADD COLUMN IF NOT EXISTS max_access_count integer,
  ADD COLUMN IF NOT EXISTS brokerage_id uuid;

-- Backfill tenant from the document being shared, then constrain.
UPDATE public.document_sharing_links l
   SET brokerage_id = d.brokerage_id
  FROM public.client_documents d
 WHERE d.id = l.document_id
   AND l.brokerage_id IS NULL
   AND d.brokerage_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.document_sharing_links'::regclass
       AND conname = 'document_sharing_links_brokerage_id_fkey'
  ) THEN
    ALTER TABLE public.document_sharing_links
      ADD CONSTRAINT document_sharing_links_brokerage_id_fkey
      FOREIGN KEY (brokerage_id) REFERENCES public.brokerages(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.document_sharing_links'::regclass
       AND conname = 'document_sharing_links_max_access_count_positive'
  ) THEN
    ALTER TABLE public.document_sharing_links
      ADD CONSTRAINT document_sharing_links_max_access_count_positive
      CHECK (max_access_count IS NULL OR max_access_count > 0);
  END IF;

  -- A password-protected link with no stored secret is an open link wearing a lock.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.document_sharing_links'::regclass
       AND conname = 'document_sharing_links_password_present_when_required'
  ) THEN
    ALTER TABLE public.document_sharing_links
      ADD CONSTRAINT document_sharing_links_password_present_when_required
      CHECK (requires_password = FALSE OR password_hash IS NOT NULL);
  END IF;

  -- Plaintext passwords cannot be stored here again.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.document_sharing_links'::regclass
       AND conname = 'document_sharing_links_password_hash_is_hashed'
  ) THEN
    ALTER TABLE public.document_sharing_links
      ADD CONSTRAINT document_sharing_links_password_hash_is_hashed
      CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%');
  END IF;
END $$;

UPDATE public.document_sharing_links
   SET expires_at = created_at + INTERVAL '30 days'
 WHERE expires_at IS NULL;

ALTER TABLE public.document_sharing_links
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dsl_brokerage ON public.document_sharing_links (brokerage_id);

-- ── RLS: team-scoped. No more blanket read of every active link. ─────────────
DROP POLICY IF EXISTS dsl_select ON public.document_sharing_links;
CREATE POLICY dsl_select ON public.document_sharing_links
  FOR SELECT USING (
    public.is_platform_admin()
    OR shared_by = auth.uid()
    OR public.has_brokerage_access(brokerage_id)
  );

DROP POLICY IF EXISTS dsl_insert ON public.document_sharing_links;
CREATE POLICY dsl_insert ON public.document_sharing_links
  FOR INSERT WITH CHECK (
    public.is_platform_admin()
    OR (shared_by = auth.uid() AND public.has_brokerage_access(brokerage_id))
  );

-- ── The authoritative access-count consumer ──────────────────────────────────
-- Returns TRUE only if a slot was actually consumed. Callers MUST refuse access
-- on FALSE. Password verification happens BEFORE this call so a wrong guess
-- cannot burn the quota.
CREATE OR REPLACE FUNCTION public.consume_document_share_access(p_link_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_consumed boolean;
BEGIN
  UPDATE public.document_sharing_links
     SET current_access_count = current_access_count + 1
   WHERE id = p_link_id
     AND is_active
     AND expires_at > now()
     AND (max_access_count IS NULL OR current_access_count < max_access_count)
  RETURNING TRUE INTO v_consumed;

  RETURN COALESCE(v_consumed, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.consume_document_share_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_document_share_access(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.consume_document_share_access(uuid) IS
  'Atomically consumes one access slot on a document share link. Returns FALSE when the link is inactive, expired, or at its max_access_count — the caller must then refuse the document.';
COMMENT ON COLUMN public.document_sharing_links.max_access_count IS
  'Hard cap on total opens. NULL = unlimited. Enforced by consume_document_share_access(), not by the reader.';
COMMENT ON COLUMN public.document_sharing_links.brokerage_id IS
  'Tenant that may open this link. Denormalized from client_documents.brokerage_id at mint time so RLS can scope reads without a join.';
