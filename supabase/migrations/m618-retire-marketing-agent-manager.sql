-- m618 — RETIRE marketing_agent AS A MANAGER (ManagerKey), SURVIVOR campaign_orchestrator
--
-- APPLIED to hrvaqgvukzxfskkcrwbt on 2026-09-10 by the integrator (measured first: zero manager_signals rows carried marketing_agent; no CHECK on from_manager/to_manager).
-- (CLAUDE.md §3). Regenerate scripts/check-vocabularies.ts from live JSON after this
-- lands, per §3's "after any applied migration that adds a CHECK, regenerate the
-- vocabulary cache" (this migration widens no CHECK, but the data it moves feeds the
-- same cache's row-shape assumptions, so re-verify it after applying).
--
-- OWNER RULING (2026-09-10, wave 50), verbatim: "we don't have a marketing agent
-- manager." marketing_agent was a ManagerKey in lib/kernel/manager-registry.ts
-- (MANAGERS, label "Marketing Manager", domain "Brand & promotion") with ~256 code
-- uses across lib/, app/, scripts/ — SIGNAL_REGISTRY consumers, SIGNAL_HANDLERS keys,
-- event-reactor.ts from/to routes, MAINTENANCE_DOMAINS owners, CRON_MANAGER owners,
-- QUEUE_MANAGER / TABLE_MANAGER / CAPABILITY_MANAGER entries, deliberation seats,
-- UI chips/labels, and proofs. All of it now names campaign_orchestrator, which
-- already owned "Multi-touch campaigns & content" — the SAME brand/content/social/
-- newsletter/direct-mail/SEO-GEO surfaces marketing_agent overlapped, on the SAME
-- tables (social_posts, blog_posts, newsletter_campaigns, direct_mail_campaigns,
-- marketing_campaigns …). Paid-spend work was already ads_manager's and is untouched.
--
-- ── WHAT THIS DOES, AND WHY IT IS SHORTER THAN A TYPICAL VOCABULARY-RETIREMENT ──
--
-- 1. NO managed_agents.agent_kind CHECK CHANGE. scripts/check-vocabularies.ts's live
--    cache (regenerated from hrvaqgvukzxfskkcrwbt, 2026-09-10) shows managed_agents.
--    agent_kind's CHECK still legitimately ADMITS 'marketing_agent' — and this
--    migration does NOT remove it. lib/agents/marketing-agent.ts's weekly broadcast
--    job DELIBERATELY keeps spawning under agent_kind='marketing_agent': that column
--    is an EXECUTION-IDENTITY (which Anthropic managed-agent session runs), a
--    SEPARATE vocabulary from ManagerKey (lib/agents/spawn-helper.ts's AgentKind type
--    is its own union, never unioned with ManagerKey) that happens to historically
--    mirror it 1:1 for 10 of the 13 remaining keys. Collapsing agent_kind onto
--    'campaign_orchestrator' was tried and REVERTED in this same lane: app/api/
--    webhooks/anthropic-agent/route.ts dispatches its resolutions[]-ledger parse
--    (-> marketing_agent_actions) by `agentKind === "marketing_agent"`, and
--    lib/agents/campaign-orchestrator.ts's OWN weekly job already spawns under
--    agent_kind='campaign_orchestrator' with a DIFFERENT output shape (tool-driven
--    drafts, no resolutions[] parse) — sharing the kind would make that webhook
--    unable to tell the two sessions' output apart. See the comment on AgentKind in
--    lib/agents/spawn-helper.ts and on TEMPLATE in lib/agents/marketing-agent.ts.
--
-- 2. NO manager_signals CHECK CHANGE either — check-vocabularies.ts shows
--    manager_signals has a live CHECK only on `status` (open/consumed/expired);
--    from_manager/to_manager carry NO live CHECK constraint. Routing is enforced
--    application-side only, by lib/kernel/manager-signals.ts's validSignalRoute()
--    against the TS ManagerKey union (which no longer admits "marketing_agent" as
--    of this lane's code changes).
--
-- 3. THE ONE REAL DATA MOVE: existing manager_signals ROWS published before this
--    lane's code deployed may carry from_manager/to_manager = 'marketing_agent'.
--    After deploy, lib/kernel/manager-signals.ts's SIGNAL_HANDLERS no longer has a
--    "marketing_agent:*" entry (renamed to "campaign_orchestrator:podcast_episode_
--    generated", the only one that existed) — an OPEN legacy row would look up a key
--    that no longer resolves and silently go unhandled by its dedicated handler
--    (still visible in the raw "managers talking" feed, just not auto-actioned).
--    Backfill moves every such row onto the current owner so it resolves correctly
--    once this migration is applied. Idempotent (WHERE-guarded); safe to re-run.

UPDATE public.manager_signals
   SET from_manager = 'campaign_orchestrator'
 WHERE from_manager = 'marketing_agent';

UPDATE public.manager_signals
   SET to_manager = 'campaign_orchestrator'
 WHERE to_manager = 'marketing_agent';

-- Any other table found (at apply time) to carry a hand-typed ManagerKey column
-- literal 'marketing_agent' (e.g. a future manager-scoped ledger) should be backfilled
-- the same way, guarded the same way, before this migration is considered complete —
-- the census above is what lib/kernel/manager-registry.ts's own MAINTENANCE_DOMAINS /
-- QUEUE_MANAGER / TABLE_MANAGER / CRON_MANAGER / CAPABILITY_MANAGER maps route through
-- (all code, no table columns of their own to backfill) plus the one signals table
-- checked here — re-verify against live schema before applying, per CLAUDE.md §3.
