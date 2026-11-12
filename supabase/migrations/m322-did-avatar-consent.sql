-- m322 — D-ID consent statements for V3 Instant Avatar creation.
--
-- A V3 Instant Avatar (the "build my twin from a short video" flow) REQUIRES a
-- recorded consent statement, and we had none. create-avatar posted a
-- source_url with no consent_id, so every video-sourced twin was submitted
-- without the one thing that endpoint exists to require.
--
-- The consent is not a checkbox. D-ID mints a random three-word passcode, the
-- agent must read it aloud on camera, and D-ID then runs a transcription check,
-- face recognition against the avatar footage, and voice verification. The
-- recording must be LIVE — D-ID does not accept an uploaded file, because an
-- upload proves nothing about who is in front of the camera.
--
-- A verified consent is REUSABLE across every future avatar for that agent
-- (D-ID saves it account-side), which is why the unique index below is on
-- status='verified' only: re-prompting an agent to perform a passcode every
-- time they re-record a twin would be a self-inflicted wound, while pending and
-- failed attempts may legitimately accumulate as they retry the words.

create table if not exists agent_did_consents (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  brokerage_id uuid references brokerages(id) on delete set null,
  did_consent_id text not null,
  -- The random passcode D-ID generated. Stored so the capture screen can show
  -- the SAME words on a resume/retry — regenerating them would invalidate a
  -- recording already in progress.
  consent_text text not null,
  language text not null default 'english',
  status text not null default 'pending'
    check (status in ('pending','verified','failed')),
  failure_reason text,
  source_url text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table agent_did_consents is
  'D-ID consent statements for V3 Instant Avatar creation. A verified consent is REUSABLE across every future avatar for that agent (D-ID saves it account-side), so the resolver returns an existing verified row before minting a new one. consent_text is the random passcode the agent must read aloud on camera — upload is not permitted by D-ID, the recording must be live.';

create unique index if not exists agent_did_consents_did_id_key on agent_did_consents(did_consent_id);
create unique index if not exists agent_did_consents_one_verified
  on agent_did_consents(agent_id) where status = 'verified';
create index if not exists agent_did_consents_agent on agent_did_consents(agent_id, status);

alter table agent_did_consents enable row level security;

drop policy if exists agent_did_consents_tenant_read on agent_did_consents;
create policy agent_did_consents_tenant_read on agent_did_consents
  for select using (brokerage_id in (select user_brokerage_ids()));
