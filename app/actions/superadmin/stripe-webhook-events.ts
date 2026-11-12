"use server"

// app/actions/superadmin/stripe-webhook-events.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PLATFORM DOOR onto lib/billing/stripe-webhook-registration.ts (wave 80A):
// check the billing webhook's registered events against what the route
// handles, and register the missing ones through the Stripe SDK. Platform
// staff only (providers capability — the same gate as the go-live probes it
// sits beside), audited, and the register action publishes NOTHING but the
// event list on an endpoint that already exists.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { platformStaffCan, resolvePlatformRoleIdentity } from "@/lib/platform/platform-staff-roster"
import { syncStripeWebhookEvents, type StripeWebhookRegistrationResult } from "@/lib/billing/stripe-webhook-registration"
import { STRIPE_WEBHOOK_ROUTES, type StripeWebhookEndpoint } from "@/lib/billing/stripe-account-scope"

/** Both endpoints are the PLATFORM account's (lane 81E added the vendor one).
 *  The argument arrives over HTTP ("use server" — every export is a public
 *  endpoint), so it is admitted by MEMBERSHIP in the route table, never trusted. */
function resolveEndpoint(endpoint: unknown): StripeWebhookEndpoint | null {
  return typeof endpoint === "string" && endpoint in STRIPE_WEBHOOK_ROUTES ? (endpoint as StripeWebhookEndpoint) : null
}

async function requireProvidersStaff(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = resolvePlatformRoleIdentity((data as any)?.user_type, (data as any)?.platform_role)
  if (!platformStaffCan(role, "providers")) return { ok: false, error: "Forbidden — platform providers access required" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "" }
}

async function audit(actor: { userId: string; email: string }, action: string, details: Record<string, unknown>): Promise<void> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actor.userId, actor_email: actor.email, action, target_type: "platform", target_id: "stripe_webhook",
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[stripe-webhook-events audit] failed:", err) }
}

/** DRY RUN — the launch checklist's "webhook events drift" item. Lists the
 *  endpoint and plans the union; never calls update. */
export async function checkStripeWebhookEventsAction(endpoint: StripeWebhookEndpoint = "tenant_billing"): Promise<StripeWebhookRegistrationResult | { ok: false; reason: "forbidden"; error: string }> {
  const auth = await requireProvidersStaff()
  if (!auth.ok) return { ok: false, reason: "forbidden", error: auth.error }
  const ep = resolveEndpoint(endpoint)
  if (!ep) return { ok: false, reason: "forbidden", error: `Unknown webhook endpoint "${String(endpoint)}" — this app registers ${Object.keys(STRIPE_WEBHOOK_ROUTES).join(" and ")}.` }
  return syncStripeWebhookEvents({ apply: false, endpoint: ep })
}

/** REGISTER — current ∪ handled events, through stripe.webhookEndpoints.update. */
export async function registerStripeWebhookEventsAction(endpoint: StripeWebhookEndpoint = "tenant_billing"): Promise<StripeWebhookRegistrationResult | { ok: false; reason: "forbidden"; error: string }> {
  const auth = await requireProvidersStaff()
  if (!auth.ok) return { ok: false, reason: "forbidden", error: auth.error }
  const ep = resolveEndpoint(endpoint)
  if (!ep) return { ok: false, reason: "forbidden", error: `Unknown webhook endpoint "${String(endpoint)}" — this app registers ${Object.keys(STRIPE_WEBHOOK_ROUTES).join(" and ")}.` }
  const result = await syncStripeWebhookEvents({ apply: true, endpoint: ep })
  await audit(auth, "stripe_webhook.events_registered", result.ok
    ? { endpoint: ep, webhookEndpointId: result.webhookEndpointId, url: result.url, before: result.before, after: result.after, added: result.plan.missing, applied: result.applied, livemode: result.livemode }
    : { endpoint: ep, refused: result.reason, error: result.error })
  return result
}
