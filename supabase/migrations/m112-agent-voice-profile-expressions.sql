-- m112 — D-ID expression defaults per agent voice profile.
-- D-ID supports `driver_expressions` on /talks and /clips: a list of
--   { start_frame, expression: 'happy'|'neutral'|'surprise'|'serious', intensity 0..1 }
-- Without this the avatar renders monotone. The platform default is a warm
-- "happy" at 0.7 intensity for marketing videos; an agent can override per profile.

alter table public.agent_voice_profiles
  add column if not exists default_expression text
    check (default_expression in ('happy','neutral','surprise','serious'))
    default 'happy',
  add column if not exists expression_intensity numeric(3,2)
    check (expression_intensity >= 0 and expression_intensity <= 1)
    default 0.70;

comment on column public.agent_voice_profiles.default_expression is
  'D-ID driver_expressions default per agent. Avatar renders monotone without it.';
comment on column public.agent_voice_profiles.expression_intensity is
  'D-ID expression intensity 0..1. 0.7 is the warm-but-professional default.';
