-- m171 — Wave 39: Asset Manager start/restart render action types.
--
-- The Asset Manager Agent owns the composition library — until now it
-- could PROPOSE deprecate / promote / flag actions, but couldn't
-- actually trigger a render or re-trigger a failed one. The "agent
-- controls" promise wasn't enforced because the action vocabulary
-- didn't expose it.
--
-- Two new action_types added to the CHECK constraint:
--   start_render            queue a fresh remotion_composition_renders
--                           row for the brokerage. Inputs: composition_id,
--                           composition props payload, scope, agent_user_id,
--                           entity_type, entity_id. Executor calls
--                           beginCoordinatedRender; the actual @remotion/
--                           renderer call lands via the per-composition
--                           endpoint that the executor invokes via fetch.
--   restart_failed_render   re-queue a previously-failed render. Inputs:
--                           render_id. Executor reads the original row's
--                           composition_id + props, claims a new row,
--                           and dispatches.
--
-- Both action types stay in the standard proposed → approved →
-- executing → succeeded/failed lifecycle the rest of the asset
-- manager actions use.

alter table public.asset_manager_actions
  drop constraint if exists asset_manager_actions_action_type_check;

alter table public.asset_manager_actions
  add constraint asset_manager_actions_action_type_check
  check (action_type = any (array[
    'regenerate_asset',
    'deprecate_asset',
    'flag_asset_for_review',
    'request_listing_hero_photo',
    'request_agent_headshot',
    'rerender_persona_variants',
    'sync_asset_to_listing',
    'start_render',
    'restart_failed_render'
  ]));
