-- Connector self-healing proposal log. When the AI connector healer detects a systematic failure
-- on a vendor connector (auth 4xx streak, 404 on a documented path, response shape drift, etc.),
-- it fetches the vendor's current docs (Exa/Tavily search → docs URL), feeds the failing request
-- + current docs to an LLM, and writes a structured proposal here. Low-risk proposals can be
-- auto-applied (e.g., retry with the next configured key or actor); higher-risk ones (endpoint
-- change, auth-style change) are surfaced to the admin dashboard for approval.
CREATE TABLE IF NOT EXISTS connector_healing_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector          text NOT NULL,
  detected_at        timestamptz NOT NULL DEFAULT now(),
  -- The symptom the healer observed:
  failure_signature  text NOT NULL,           -- e.g. "HTTP 404 on path 'person/enrich'"
  failure_sample     jsonb NOT NULL,          -- last N failures with status + error
  -- What the AI proposes:
  proposal_kind      text NOT NULL,           -- 'endpoint_change' | 'param_rename' | 'auth_change' |
                                              -- 'retry_other_actor' | 'rotate_key' | 'shape_update'
  proposal_summary   text NOT NULL,           -- one-sentence change description
  proposal_payload   jsonb NOT NULL,          -- structured diff (old → new)
  docs_evidence      jsonb,                   -- urls + snippets the LLM cited
  confidence         numeric,                 -- 0..1
  status             text NOT NULL DEFAULT 'pending',
                                              -- pending | applied | rejected | superseded
  applied_at         timestamptz,
  applied_by         text,                    -- 'auto' or a user id
  notes              text
);

CREATE INDEX IF NOT EXISTS connector_healing_proposals_connector_status_idx
  ON connector_healing_proposals (connector, status, detected_at DESC);
