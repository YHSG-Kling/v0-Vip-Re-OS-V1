-- ── APPLIED LIVE 2026-10-24 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 143, lane 143B; statement by statement where the MCP held a batch ──
--
-- m807 — PLATFORM FORM PACKETS (wave 142's pending hook "142B SOURCE (a)")
--
-- A licensed fillable form packet held by the PLATFORM for every subscriber, alongside the brokerage /
-- team / agent libraries. The PDF master lives in the existing private bucket `brokerage-forms` under
-- `platform/{id}/{file}.pdf` (no new bucket); this table is the registry, the licence record and the
-- approval record. The fill engine, autosave and versioned `filled/…` copies are the existing wizard rail
-- (see lib/forms/platform-form-packets.ts).
--
-- NOT A COPY OF brokerage_form_library: that table is tenant-scoped (brokerage_id NOT NULL, tenant RLS);
-- a platform packet has no tenant and a licence/approval lifecycle a tenant form does not. packet_type
-- spells the SAME vocabulary as brokerage_form_library.packet_type (one vocabulary for "what kind of
-- packet"; scripts/closing-compliance-guard.ts holds the two equal).
--
-- THE DATABASE REFUSES WHAT THE PRODUCT WOULD NOT DO: an APPROVED row must carry an approver, an approval
-- time, a licence basis of at least 20 characters and at least one fillable field. A draft cannot leak to
-- tenants (every reader selects status='approved'); a retired packet carries when and why.
--
-- Verified against the live database before writing (2026-10-23, project hrvaqgvukzxfskkcrwbt): no table or
-- column named platform_form_packets exists; brokerage_form_library.packet_type CHECK =
-- custom | disclosure | listing | offer | transaction.

CREATE TABLE IF NOT EXISTS public.platform_form_packets (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text        NOT NULL CHECK (length(btrim(name)) >= 3),
  -- NULL = state-neutral. A pinned packet is offered only to a deal in that state.
  state               text        NULL CHECK (state ~ '^[A-Z]{2}$'),
  packet_type         text        NOT NULL
    CONSTRAINT platform_form_packets_packet_type_check
    CHECK (packet_type IN ('listing', 'offer', 'transaction', 'disclosure', 'custom')),
  -- The association's own form number ("TAR 1601"), used to supersede an older version of the same form.
  form_code           text        NULL,
  description         text        NULL,
  storage_path        text        NOT NULL UNIQUE CHECK (storage_path ~ '^platform/[0-9a-f-]{36}/[^/]+\.pdf$'),
  file_name           text        NOT NULL,
  file_size_bytes     integer     NULL,
  -- Counted from the PDF at upload (AcroForm fields). "Fillable" is verified, not claimed.
  field_count         integer     NOT NULL DEFAULT 0 CHECK (field_count >= 0),
  status              text        NOT NULL DEFAULT 'draft'
    CONSTRAINT platform_form_packets_status_check
    CHECK (status IN ('draft', 'approved', 'retired')),
  version             integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- The licence under which the platform holds and redistributes the form. Required to approve.
  license_note        text        NULL,
  license_expires_at  date        NULL,
  approved_by         uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at         timestamptz NULL,
  retired_at          timestamptz NULL,
  retired_reason      text        NULL,
  created_by          uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_form_packets_approved_needs_evidence CHECK (
    status <> 'approved'
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND license_note IS NOT NULL AND length(btrim(license_note)) >= 20 AND field_count > 0)
  ),
  CONSTRAINT platform_form_packets_retired_needs_reason CHECK (
    status <> 'retired' OR (retired_at IS NOT NULL AND retired_reason IS NOT NULL)
  )
);

COMMENT ON TABLE public.platform_form_packets IS
  'm807 (wave 143, lane 143B): licensed fillable form packets held by the PLATFORM for every subscriber. Registry + licence + approval record; the PDF master is the private brokerage-forms object at storage_path (platform/{id}/{file}.pdf). Written only by lib/forms/platform-form-packets.ts via app/actions/superadmin/platform-form-packets.ts (superadmin); read by tenants only as status=approved through app/api/form-wizard/platform-packets and lib/forms/form-path-scope.ts. No tenant column by design — this is platform content, not tenant data.';

CREATE INDEX IF NOT EXISTS platform_form_packets_listing_idx
  ON public.platform_form_packets (status, state, packet_type);

-- One APPROVED version per (state, packet_type, form_code): approving a newer packet retires the older one
-- (lib/forms/platform-form-packets.ts approvePlatformPacket). The partial unique index is the backstop.
CREATE UNIQUE INDEX IF NOT EXISTS platform_form_packets_one_approved_per_form
  ON public.platform_form_packets (coalesce(state, '--'), packet_type, form_code)
  WHERE status = 'approved' AND form_code IS NOT NULL;

-- The live ensure_rls event trigger (m752) already enables RLS on every new table; stated here so a rebuilt
-- environment agrees. NO policy for authenticated/anon on writes, and the only read policy is platform staff:
-- tenants never query this table directly — they read approved packets through a server route (service
-- client, session-gated) that returns only the columns a tenant needs.
ALTER TABLE public.platform_form_packets ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_form_packets_staff_select ON public.platform_form_packets
  FOR SELECT TO authenticated
  USING (is_platform_admin());
