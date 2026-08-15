-- m134 — per-persona topic performance scores.
--
-- Wave 23. content_topic_bank.performance_score (m131) is a single
-- brokerage-wide aggregate per topic, computed from the assets a topic
-- seeded — but in production a topic that lands hard with first_time_buyer
-- subscribers may bomb with investor subscribers (or vice versa), and the
-- universal score averages them. Wave 23 splits the score by recipient
-- persona so the picker (lib/content-intel/topic-bank.ts) can return
-- different topic rankings when authoring persona-targeted sections
-- (Wave 20's segmentable audience path).
--
-- Schema: sibling table, NOT a column on content_topic_bank (a topic has
-- many personas in practice; jsonb would need fan-out reads).
--
--   (topic_id, persona)               — uniqueness key
--   persona_open_rate, persona_click_rate — recomputed each cron run from
--                                           newsletter_sends ⨝ contacts
--   persona_samples_count             — number of (recipient, send) pairs
--                                       backing the score; the picker uses
--                                       this to suppress unreliable scores
--                                       (e.g. 3 samples is noise)
--   performance_score                 — 0..30 same shape as the global
--   computed_at                       — when the aggregator last ran

create table if not exists public.content_topic_persona_performance (
  id                       uuid primary key default gen_random_uuid(),
  topic_id                 uuid not null references public.content_topic_bank(id) on delete cascade,
  persona                  text not null,
  persona_open_rate        numeric(5,2) not null default 0,
  persona_click_rate       numeric(5,2) not null default 0,
  persona_samples_count    integer not null default 0,
  performance_score        integer not null default 0
                           check (performance_score >= 0 and performance_score <= 30),
  computed_at              timestamptz not null default now(),
  unique (topic_id, persona)
);

create index if not exists idx_content_topic_persona_perf_persona_score
  on public.content_topic_persona_performance (persona, performance_score desc);

create index if not exists idx_content_topic_persona_perf_topic
  on public.content_topic_persona_performance (topic_id);

alter table public.content_topic_persona_performance enable row level security;

create policy "service_role_full"
  on public.content_topic_persona_performance
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
