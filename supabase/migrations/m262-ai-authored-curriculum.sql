-- m262 — Autonomous curriculum authoring on the training_courses catalog.
--
-- The curriculum author (lib/education/curriculum-author.ts, recruiting_manager) detects a recurring
-- knowledge gap from real signal and drafts a rich, specific micro-course. It persists as a GATED DRAFT
-- on the EXISTING training_courses catalog (no parallel table) until a human publishes it. Columns are
-- additive; existing courses default to status 'published' and is_ai_generated false so nothing changes.

alter table public.training_courses
  add column if not exists is_ai_generated boolean not null default false,
  add column if not exists status text not null default 'published',
  add column if not exists topic_key text,
  add column if not exists curriculum jsonb,
  add column if not exists source_evidence jsonb;

alter table public.training_courses
  drop constraint if exists training_courses_status_check;
alter table public.training_courses
  add constraint training_courses_status_check check (status in ('draft', 'published', 'archived'));

-- One AI-authored course per (brokerage, detected topic) — the author's idempotency key.
create unique index if not exists uq_training_courses_ai_topic
  on public.training_courses (brokerage_id, topic_key) where topic_key is not null;
