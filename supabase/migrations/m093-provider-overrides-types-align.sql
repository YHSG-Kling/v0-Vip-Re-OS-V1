-- m093: align provider_overrides.provider_type with the kernel registry
-- lib/kernel/providers.ts resolves these provider types, but the CHECK
-- constraint omitted the platform AI-media vendors (avatar, voice_clone,
-- ai_voice), the lead-pipeline vendors (scraper, enrichment), the IDX/MLS
-- feed (idx) and 'crm' (the registry key; 'crm_sync' kept for back-compat).
-- Without this, superadmin can't override those platform vendors and tenants
-- can't override idx/crm. Additive — existing values are retained.

ALTER TABLE public.provider_overrides
  DROP CONSTRAINT IF EXISTS provider_overrides_provider_type_check;

ALTER TABLE public.provider_overrides
  ADD CONSTRAINT provider_overrides_provider_type_check CHECK (
    provider_type = ANY (ARRAY[
      'email','sms','social','phone','calendar','payment','esign','transaction',
      'ai','direct_mail','video','showing','crm_sync','accounting',
      'crm','idx','avatar','voice_clone','ai_voice','scraper','enrichment'
    ]::text[])
  );
