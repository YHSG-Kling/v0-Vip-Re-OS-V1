/**
 * lib/widget/resolve-widget-tenant.ts
 *
 * THE ONE PLACE THE WEBSITE CHAT WIDGET LEARNS WHOSE TENANT IT IS.
 *
 * The widget is public by design — a website visitor is not logged in and never
 * will be — so there is no session to resolve the tenant from. What there IS is
 * a PUBLIC HANDLE: `brokerages.slug`, the same handle `/widget/[brokerageSlug]`
 * has always been addressed by, unique platform-wide (brokerages_slug_unique).
 *
 * WHAT THIS REPLACES. /api/widget/session took `brokerage_id` and `agent_id`
 * straight off an unauthenticated POST body, handed them to the service client
 * (RLS bypassed) and stamped a chat_sessions row with them. Two consequences,
 * both real:
 *   · a brokerage that had TURNED THE WIDGET OFF still minted sessions and
 *     still spent its AI budget — widget_enabled was checked by the loader
 *     script and by nothing on the lane that is actually exposed;
 *   · `agent_id` was never checked against the brokerage, so a session (and
 *     every contact captured through it) could be attributed to an agent of a
 *     DIFFERENT brokerage. That is the tenant line, crossed by a body field.
 *
 * This mirrors /api/embed/session, which is the same class of public route done
 * correctly: resolve the config row from a public handle, refuse when it is not
 * active, and derive brokerage_id / agent_id FROM THE RESOLVED ROW.
 *
 * WHY NOT embed_widgets. That table is the D-ID avatar embed's config: it
 * requires a twin, carries enabled_modes/lead_capture/style for the avatar
 * bubble, and is EMPTY live. Routing the chat widget through it would take
 * every brokerage's website chat offline until someone created an avatar embed
 * for them. The chat widget's own config is the brokerage row (slug +
 * widget_enabled), so that is what it resolves.
 *
 * ─── TOMBSTONE (orphan doctrine §1.1, lane BT 2026-08-27) ────────────────────
 * app/api/widget/loader/route.ts (export GET) DELETED. That route served a
 * dynamic loader snippet addressed by nothing in first-party source
 * (comment-stripped, positive-controlled finder: zero mentions of
 * "/api/widget/loader"), taking the exact `brokerage_id`/`agent_id`-in-query
 * identity shape this module records replacing — and its iframe pointed at
 * `${appUrl}/widget?...`, a path with NO page.tsx (app/widget/ holds only
 * [brokerageSlug]/ and chat/), so any embed of its snippet rendered a 404
 * iframe. SURVIVOR: public/widget-loader.js — the static loader the settings
 * page distributes (app/dashboard/settings/widget/widget-settings-client.tsx),
 * which iframes /widget/chat; the widget_enabled gate the deleted route
 * performed lives on the exposed lane, right here (resolveWidgetTenant).
 */

import "server-only"
import type { NextRequest } from "next/server"
import type { createServiceClient } from "@/lib/supabase/service"

export interface WidgetTenant {
  brokerageId: string
  brokerageSlug: string
  brokerageName: string
  /** agents.id — present only when it is an agent OF THIS BROKERAGE and active. */
  agentId: string | null
}

export type WidgetTenantResult =
  | { ok: true; tenant: WidgetTenant }
  | { ok: false; status: number; error: string }

/** Deliberately the same message for "no such slug" and "no such agent here":
 *  a public endpoint should not confirm which brokerage slugs exist. */
const NOT_AVAILABLE = "This chat isn't available."

export async function resolveWidgetTenant(
  supabase: ReturnType<typeof createServiceClient>,
  input: { brokerageSlug?: string | null; agentId?: string | null },
): Promise<WidgetTenantResult> {
  const slug = input.brokerageSlug?.trim()
  if (!slug) return { ok: false, status: 400, error: "brokerage_slug required" }

  const { data: brokerage, error } = await supabase
    .from("brokerages")
    .select("id, name, slug, widget_enabled, deleted_at")
    .eq("slug", slug)
    .maybeSingle()

  // supabase-js RESOLVES a failed query — a denial arrives as data:null with an
  // error, not as a throw. Reporting that as "not found" would hide an outage
  // behind a 404, so the two are answered differently.
  if (error) {
    console.error("[widget/tenant] brokerage lookup failed:", error.message)
    return { ok: false, status: 503, error: "Chat is temporarily unavailable." }
  }
  if (!brokerage || brokerage.deleted_at) return { ok: false, status: 404, error: NOT_AVAILABLE }
  if (brokerage.widget_enabled === false) {
    return { ok: false, status: 403, error: "Chat is turned off for this website." }
  }

  const resolved: WidgetTenant = {
    brokerageId: brokerage.id,
    brokerageSlug: brokerage.slug as string,
    brokerageName: brokerage.name ?? "",
    agentId: null,
  }

  const agentId = input.agentId?.trim() || null
  if (!agentId) return { ok: true, tenant: resolved }

  // agents.id, scoped to the resolved brokerage. A foreign or deactivated agent
  // FINDS NOTHING and the widget refuses rather than quietly falling back to the
  // brokerage — an agent-scoped widget that silently becomes brokerage-scoped is
  // how a deactivated agent keeps collecting leads.
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .eq("brokerage_id", brokerage.id)
    .eq("is_active", true)
    .maybeSingle()

  if (agentError) {
    console.error("[widget/tenant] agent lookup failed:", agentError.message)
    return { ok: false, status: 503, error: "Chat is temporarily unavailable." }
  }
  if (!agent) return { ok: false, status: 404, error: NOT_AVAILABLE }

  resolved.agentId = agent.id
  return { ok: true, tenant: resolved }
}

/**
 * ORIGIN ENFORCEMENT, the part of it a browser cannot forge.
 *
 * /api/embed/session enforces `allowed_domains` against an origin the CLIENT
 * states. The chat widget has no allowed-domains config to enforce (see the
 * report — nothing was invented for it), but it has something the embed lane
 * does not: BOTH of its entry points are iframes served from THIS app, so a
 * legitimate POST is same-origin and the browser stamps `Origin` itself.
 *
 * So the rule is: if a browser tells us where the call came from, it has to be
 * us. That stops any third-party page's JavaScript from minting sessions
 * against a tenant — the off-site minting attempt in the brief — while both
 * real widget clients pass unchanged. It does NOT stop a caller with no browser
 * (curl sends no Origin), which is exactly the limit the embed lane has too;
 * the per-IP throttle and the tenant gate above are what cover that.
 */
export function widgetCallOriginAllowed(req: NextRequest): boolean {
  const origin = req.headers.get("origin")
  if (!origin) return true

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return false // an unparseable Origin is not one of ours
  }

  // Hosts compared, not full origins: http vs https differs between local dev,
  // preview and production and says nothing about who is calling.
  const allowedHosts = new Set<string>()
  for (const raw of [process.env.NEXT_PUBLIC_APP_URL, process.env.NEXT_PUBLIC_SITE_URL]) {
    if (!raw) continue
    try { allowedHosts.add(new URL(raw).host) } catch { /* malformed env — ignore */ }
  }
  // The deployment answering this request, so preview URLs work without config.
  const self = req.headers.get("x-forwarded-host") ?? req.headers.get("host")
  if (self) allowedHosts.add(self)

  return allowedHosts.size === 0 || allowedHosts.has(originHost)
}
