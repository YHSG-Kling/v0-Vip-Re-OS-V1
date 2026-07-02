-- m257-recruiting-roi-agent-unique.sql
--
-- RECRUITING ROI WRITER — recruiting_roi was READ by the ROI dashboard / agent scorecard / brokerage
-- P&L but had NO production writer (only simulators inserted it), so the headline ROI/net KPIs read
-- empty in prod. The new upsertRecruitingRoi (recruiting_manager) computes a REAL row per recruited
-- agent from recruiting_costs + recruiting_analytics on every first-close and cost entry. This unique
-- index makes that upsert idempotent (one ROI row per recruited agent).
create unique index if not exists idx_recruiting_roi_agent_unique
  on recruiting_roi (recruited_agent_id) where recruited_agent_id is not null;
