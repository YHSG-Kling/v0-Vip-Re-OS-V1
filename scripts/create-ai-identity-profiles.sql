-- AI Identity Studio: ai_identity_profiles table
-- Governance: brokerage → team → agent scope inheritance

CREATE TABLE IF NOT EXISTS public.ai_identity_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('brokerage','team','agent')),
  scope_id uuid NOT NULL,
  brokerage_id uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  assistant_name text NOT NULL DEFAULT 'Your AI Assistant',
  persona_label text DEFAULT 'AI Real Estate Specialist',
  tone text CHECK (tone IN ('professional','conversational','luxury','friendly','authoritative','warm')),
  formality_level text CHECK (formality_level IN ('formal','semi_formal','casual')),
  objection_library jsonb DEFAULT '[]'::jsonb,
  faq_knowledge jsonb DEFAULT '[]'::jsonb,
  prohibited_language text[] DEFAULT '{}',
  escalation_rules jsonb DEFAULT '{}'::jsonb,
  followup_style text DEFAULT 'warm_persistent',
  active boolean NOT NULL DEFAULT true,
  parent_scope_id uuid REFERENCES public.ai_identity_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT ai_identity_profiles_scope_unique UNIQUE (scope_type, scope_id)
);

-- RLS
ALTER TABLE public.ai_identity_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_identity_profiles_brokerage_isolation ON public.ai_identity_profiles;
CREATE POLICY ai_identity_profiles_brokerage_isolation ON public.ai_identity_profiles
  FOR ALL
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM public.users WHERE id = auth.uid()
    )
  );

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_ai_identity_profiles_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_identity_profiles_updated_at ON public.ai_identity_profiles;
CREATE TRIGGER ai_identity_profiles_updated_at
  BEFORE UPDATE ON public.ai_identity_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_ai_identity_profiles_updated_at();
