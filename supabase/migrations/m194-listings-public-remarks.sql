-- m194 — add the canonical MLS public-description field to listings.
-- AI-generated, agent-APPROVED listing descriptions are persisted in ai_generated_content, but
-- the save-back to listings.public_remarks (ai-content-generation, description-approval-card)
-- silently failed (no column) and the public listing page read a phantom `description` — so
-- approved descriptions never displayed. This adds the denormalized fast-display copy (the
-- standard MLS "public remarks" field) the code already writes + the landing page now reads.
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS public_remarks text;
