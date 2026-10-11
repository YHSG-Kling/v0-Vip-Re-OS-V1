// lib/billing/price-not-configured.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PLATFORM INCIDENT FOR AN UNSET PRICE (wave 140J). The pure state lives in
// lib/billing/plan-catalog.ts (PRICE_NOT_CONFIGURED, priceNotConfiguredRefusal,
// isConfiguredPriceCents); this is its impure half — the one place a refused
// money move tells platform staff WHICH price is missing. Same mechanism and
// same once-per-UTC-day dedupe as the secret-storage incident
// (lib/security/credential-rotation.ts raiseSecretStorageIncident): the
// platform-staff bell (lib/notifications/platform-staff.ts notifyPlatformStaff),
// deduped per surface so a tenant retrying a purchase does not page staff
// forty times, and a REFUSED dedupe read raises anyway (a duplicate beats
// silence). Never throws — the refusal already happened; this is the evidence.
//
// Not `server-only`: the proof drives it with a fake client and an injected
// notifier. The real notifier is lazy-imported so no client chain reaches it.

import { PRICE_NOT_CONFIGURED, type PriceNotConfiguredRefusal } from "./plan-catalog"

type Svc = { from: (table: string) => any }

export interface PriceIncidentDeps {
  notify?: (svc: Svc, n: { type: string; title: string; body: string; entityType?: string | null; entityId?: string | null; priority?: "low" | "medium" | "high" }) => Promise<number>
  now?: Date
}

/** Once per UTC day per surface. The notification `type` is the stable
 *  PRICE_NOT_CONFIGURED code; the surface rides the title so staff can tell a
 *  phone-overage gap from a vendor-tier gap in the bell. */
async function raisedToday(svc: Svc, surface: string, now: Date): Promise<boolean> {
  const dayStart = new Date(now.toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString()
  const { count, error } = await svc.from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("type", PRICE_NOT_CONFIGURED)
    .ilike("title", `%[${surface}]%`)
    .gte("created_at", dayStart)
  if (error) return false
  return (count ?? 0) > 0
}

/**
 * Raise the actionable platform incident for a refused money move. `brokerageId`
 * is the tenant (or the vendor's tenant) whose move was refused — from the
 * caller's session or the verified event, never a request body — so staff know
 * whom to call back. Returns what happened; never throws.
 */
export async function raisePriceNotConfiguredIncident(
  svc: Svc,
  refusal: PriceNotConfiguredRefusal,
  ctx: { brokerageId: string | null },
  deps: PriceIncidentDeps = {},
): Promise<{ raised: boolean; notified: number; deduped: boolean }> {
  const now = deps.now ?? new Date()
  try {
    if (await raisedToday(svc, refusal.surface, now)) return { raised: false, notified: 0, deduped: true }
    const notify = deps.notify ?? (async (s, n) => {
      const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
      return notifyPlatformStaff(s as never, n)
    })
    const notified = await notify(svc, {
      type: PRICE_NOT_CONFIGURED,
      title: `[${refusal.surface}] A price is not configured — a purchase was refused`,
      body: `${refusal.what} is not set, so the move was refused (nothing charged, nothing provisioned)${ctx.brokerageId ? ` for tenant ${ctx.brokerageId}` : ""}. Fix: publish the price in the plan catalogue (Superadmin → Plans / Stripe) and tell the tenant to retry. No price is ever guessed in code.`,
      entityType: ctx.brokerageId ? "brokerage" : null,
      entityId: ctx.brokerageId,
      priority: "high",
    })
    return { raised: notified > 0, notified, deduped: false }
  } catch (err) {
    console.error(`[price-not-configured] incident for ${refusal.surface} not raised:`, (err as Error)?.message)
    return { raised: false, notified: 0, deduped: false }
  }
}
