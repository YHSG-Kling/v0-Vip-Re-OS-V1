-- m123 — rename agent_intro_videos.trigger value 'lead_assigned'
-- → 'contact_agent_assigned' so the ledger column matches the m122 lifecycle
-- event and the canonical app rule (contacts are assigned to agents).

update public.agent_intro_videos
   set trigger = 'contact_agent_assigned'
 where trigger = 'lead_assigned';

alter table public.agent_intro_videos
  drop constraint if exists agent_intro_videos_trigger_check;

alter table public.agent_intro_videos
  add constraint agent_intro_videos_trigger_check
  check (trigger in ('contact_agent_assigned','home_anniversary'));

comment on column public.agent_intro_videos.trigger is
  'contact_agent_assigned | home_anniversary (m123 renamed lead_assigned → contact_agent_assigned to match the canonical app rule: contacts are assigned to agents).';
