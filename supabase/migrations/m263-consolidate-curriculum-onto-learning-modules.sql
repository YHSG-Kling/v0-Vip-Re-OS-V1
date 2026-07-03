-- m263 — Consolidate the autonomous curriculum author onto the canonical learning_modules system.
--
-- The curriculum author was first built on training_courses (m262), but that duplicated the canonical
-- learning_modules education system, which already carries is_ai_generated, gap_tags, quiz_questions, a
-- pending_review → published approval lifecycle, persona/audience targeting, and delivery to agents AND
-- client portals via the learning-router. Per the anti-drift rule the author was retargeted onto
-- learning_modules (pure reuse, no schema change there), and the training_courses columns m262 added are
-- dropped here as unused drift.
drop index if exists uq_training_courses_ai_topic;
alter table public.training_courses drop constraint if exists training_courses_status_check;
alter table public.training_courses
  drop column if exists is_ai_generated,
  drop column if exists status,
  drop column if exists topic_key,
  drop column if exists curriculum,
  drop column if exists source_evidence;
