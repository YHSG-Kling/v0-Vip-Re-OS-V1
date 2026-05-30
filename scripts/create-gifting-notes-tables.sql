-- Migration: client_gifts, thank_you_notes, thank_you_note_templates
-- These tables support the expanded Thank You Notes and Gifting system.

-- ─── client_gifts ─────────────────────────────────────────────────────────────
-- Tracks every gift recommended or sent to a contact.
CREATE TABLE IF NOT EXISTS public.client_gifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id     uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id         uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  transaction_id   uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  occasion         text NOT NULL,              -- closing | anniversary | birthday | referral_thank_you | holiday | apology | congratulations
  gift_type        text,                       -- physical | digital | experience | donation | gift_card
  gift_name        text NOT NULL,
  gift_description text,
  vendor_name      text,
  vendor_url       text,
  estimated_cost   numeric(10,2),
  actual_cost      numeric(10,2),
  budget_min       numeric(10,2),
  budget_max       numeric(10,2),
  status           text NOT NULL DEFAULT 'recommended',  -- recommended | ordered | sent | delivered | acknowledged
  sent_at          timestamp with time zone,
  delivered_at     timestamp with time zone,
  acknowledged_at  timestamp with time zone,
  tracking_number  text,
  personalization_note text,
  ai_reasoning     text,
  source           text DEFAULT 'ai',          -- ai | manual | template
  created_at       timestamp with time zone NOT NULL DEFAULT now(),
  updated_at       timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.client_gifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY client_gifts_brokerage_isolation ON public.client_gifts
  FOR ALL USING (brokerage_id = (
    SELECT brokerage_id FROM public.agents WHERE id = agent_id LIMIT 1
  ));

CREATE INDEX IF NOT EXISTS idx_client_gifts_contact   ON public.client_gifts(contact_id);
CREATE INDEX IF NOT EXISTS idx_client_gifts_agent     ON public.client_gifts(agent_id);
CREATE INDEX IF NOT EXISTS idx_client_gifts_brokerage ON public.client_gifts(brokerage_id);

-- ─── thank_you_note_templates ─────────────────────────────────────────────────
-- Agent-owned and system-default thank you note templates with variable support.
CREATE TABLE IF NOT EXISTS public.thank_you_note_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id   uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id       uuid REFERENCES public.agents(id) ON DELETE CASCADE,
  name           text NOT NULL,
  occasion       text NOT NULL,   -- closing | anniversary | birthday | referral | general
  channel        text NOT NULL DEFAULT 'email',  -- email | sms | handwritten
  subject        text,
  body           text NOT NULL,   -- supports {{first_name}}, {{property_address}}, {{agent_name}}
  is_global      boolean NOT NULL DEFAULT false,  -- true = visible to all agents in brokerage
  is_active      boolean NOT NULL DEFAULT true,
  use_count      integer NOT NULL DEFAULT 0,
  created_at     timestamp with time zone NOT NULL DEFAULT now(),
  updated_at     timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.thank_you_note_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY tyn_templates_brokerage ON public.thank_you_note_templates
  FOR ALL USING (
    brokerage_id IS NULL  -- system defaults (no brokerage)
    OR brokerage_id = (
      SELECT brokerage_id FROM public.agents WHERE user_id = auth.uid() LIMIT 1
    )
  );

-- ─── thank_you_notes ──────────────────────────────────────────────────────────
-- Tracks every thank you note sent (or queued to send) to a contact.
CREATE TABLE IF NOT EXISTS public.thank_you_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  transaction_id  uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  template_id     uuid REFERENCES public.thank_you_note_templates(id) ON DELETE SET NULL,
  occasion        text NOT NULL,
  channel         text NOT NULL DEFAULT 'email',  -- email | sms | handwritten
  subject         text,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',  -- pending | sent | delivered | failed
  sent_at         timestamp with time zone,
  delivered_at    timestamp with time zone,
  email_queue_id  uuid REFERENCES public.email_queue(id) ON DELETE SET NULL,
  ai_generated    boolean NOT NULL DEFAULT true,
  source          text DEFAULT 'reputation_panel',
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  updated_at      timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.thank_you_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY tyn_notes_brokerage ON public.thank_you_notes
  FOR ALL USING (brokerage_id = (
    SELECT brokerage_id FROM public.agents WHERE id = agent_id LIMIT 1
  ));

CREATE INDEX IF NOT EXISTS idx_tyn_notes_contact   ON public.thank_you_notes(contact_id);
CREATE INDEX IF NOT EXISTS idx_tyn_notes_agent     ON public.thank_you_notes(agent_id);
CREATE INDEX IF NOT EXISTS idx_tyn_notes_brokerage ON public.thank_you_notes(brokerage_id);

-- ─── Seed: default system templates ──────────────────────────────────────────
INSERT INTO public.thank_you_note_templates
  (name, occasion, channel, subject, body, is_global, agent_id, brokerage_id)
VALUES
  (
    'Post-Closing Warm Thank You',
    'closing', 'email',
    'Thank you, {{first_name}}!',
    'Dear {{first_name}},

Congratulations on your new home at {{property_address}}! It was truly an honor to work alongside you through this journey.

Buying a home is one of life''s biggest milestones, and I''m so grateful you trusted me to be part of it. If you ever need anything — a contractor recommendation, a market update, or just have a question — I''m always just a call away.

Wishing you many wonderful memories in your new home.

With gratitude,
{{agent_name}}',
    true, NULL, NULL
  ),
  (
    'Anniversary Check-In',
    'anniversary', 'email',
    'Happy Home Anniversary, {{first_name}}!',
    'Hi {{first_name}},

Can you believe it''s already been a year since you moved into {{property_address}}? Time really does fly!

I just wanted to reach out and say how much it meant to help you find your home. I hope the past year has brought you joy, comfort, and many great memories.

If you''re ever curious about what your home is worth today, or if any friends or family are thinking about buying or selling, I''d love to help.

Wishing you another wonderful year at home.

Warmly,
{{agent_name}}',
    true, NULL, NULL
  ),
  (
    'Referral Thank You',
    'referral', 'email',
    'Thank you for the referral, {{first_name}}!',
    'Hi {{first_name}},

I wanted to take a moment to personally thank you for referring {{referred_name}} to me. Referrals from clients I trust mean the world to me, and I will take great care of them.

It''s because of people like you that my business thrives. If there''s ever anything I can do for you — a home valuation, market update, or just a friendly chat — please don''t hesitate to reach out.

Sincerely,
{{agent_name}}',
    true, NULL, NULL
  ),
  (
    'Quick SMS Thank You',
    'closing', 'sms',
    NULL,
    'Hi {{first_name}}, it was such a pleasure helping you close on {{property_address}}! Congratulations on your new home. Reach out anytime — {{agent_name}}',
    true, NULL, NULL
  )
ON CONFLICT DO NOTHING;
