-- m336 — the public website agent gets a VOICE mode, and the mode column gets a
-- vocabulary
--
-- Owner ask: the website option should be "a live talking or voice/type ai agent
-- for their website". The embed shipped with two modes, text and live. Voice —
-- the visitor speaking out loud and the agent answering in the agent's cloned
-- voice — did not exist, and it is the mode most visitors on a phone will use.
--
-- THE VOCABULARY. embed_widgets.enabled_modes was a bare text[] with no CHECK:
-- any string could be stored, and the widget silently ignored anything it did
-- not recognise. That is the decorative-enum defect in array form — a broker
-- could "enable" a mode that never rendered and nothing would say so.
--
-- WHY A CHECK IS SAFE HERE, where it was declined for raw_scraped_leads:
--   · THE WRITER SET IS KNOWN AND SMALL. enabled_modes is written by exactly two
--     server actions — createEmbed (which never sets it, taking the 'text'
--     default) and updateEmbed. A repo-wide search finds no other writer: no
--     cron, no kernel path, no direct SQL.
--   · THE VALUES COME FROM A CONST. lib/embed/widget-modes.ts EMBED_MODES is the
--     one source, and the settings UI renders from it.
--   · THE TABLE IS EMPTY LIVE (0 rows), so no existing row can be rejected.
-- The risk that stopped the scraper CHECK — a constraint silently dropping real
-- inbound records whose writer we could not enumerate — does not exist here.
--
-- text is not optional and the constraint says so: every visitor can type, it
-- needs no microphone permission and no avatar family, and it is the fallback
-- when voice or live degrades. A widget with text disabled could refuse every
-- visitor whose browser blocks the mic.

ALTER TABLE public.embed_widgets
  DROP CONSTRAINT IF EXISTS embed_widgets_enabled_modes_vocabulary;

ALTER TABLE public.embed_widgets
  ADD CONSTRAINT embed_widgets_enabled_modes_vocabulary
  CHECK (
    enabled_modes <@ ARRAY['text','voice','live']::text[]
    AND 'text' = ANY (enabled_modes)
  );

COMMENT ON COLUMN public.embed_widgets.enabled_modes IS
  'How a website visitor may talk to this agent: text (type — always present), '
  'voice (speak, agent replies in the cloned voice), live (talking avatar on '
  'camera). Vocabulary mirrors lib/embed/widget-modes.ts EMBED_MODES. NOTE: '
  'enabling voice does not guarantee it runs — publishMicrophoneStream is '
  'Expressive (V4) only, so the widget re-checks the minted presenter family at '
  'session time and shows the reason when it cannot.';
