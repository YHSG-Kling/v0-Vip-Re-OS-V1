"use server"

// ─────────────────────────────────────────────────────────────────────────────
// THE RECRUITING PITCH — brokerages.recruiting_pitch, given the writer it never had.
//
// WHY THIS FILE EXISTS. `recruiting_pitch` had FOUR readers and ZERO writers:
//   · app/recruiting/[brokerageSlug]/page.tsx:21,79 — the PUBLIC careers landing
//     page (it is even the page's <meta description>)
//   · app/site/[slug]/page.tsx:122 — the hosted brokerage site
//   · app/dashboard/agent/refer/page.tsx:65 — the agent's referral hub
//   · lib/recruiting/recruiting-pitch-kit.ts:270 — the Recruiting Manager's
//     one-pager generator, which SKIPS any brokerage whose pitch is null
// and lib/onboarding/setup-readiness.ts carried a setup item, "Set your
// recruiting pitch", whose href pointed at /dashboard/recruiting — a path with
// no page.tsx. So the checklist asked for something no surface could supply and
// then sent the broker to a 404. §1: no duplicate exists, the capability is
// wanted, so BUILD the missing half.
//
// WHY NOT app/actions/settings/brokerage-identity.ts. That action is a deliberate
// ALLOW-LIST over identity + commission-cap columns, and its own header says a
// second writer is how an allow-list stops being one. The precedent for a
// non-identity brokerages column is app/actions/settings/revenue-share-setting.ts:
// ONE writer per column, gated the same way, service client only after the gate.
// This file follows that shape and owns exactly one column (§6).
//
// TENANCY (§4): the brokerage is the SESSION's, never a parameter. The gate runs
// first; the service client only after it passes. read_only impersonation is
// refused by resolveWriteContext before any write.
// ─────────────────────────────────────────────────────────────────────────────

import { createServiceClient } from "@/lib/supabase/service"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
// ★ ACT-AS WRITE SEAM ★ — the gate resolves the EFFECTIVE identity (the
// impersonated seat when platform staff act as a tenant), and the same role
// predicate is evaluated against it: the investigator inherits the seat's
// authority and never exceeds it.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
// The length cap lives in lib/ because every export of a "use server" file is a
// public HTTP endpoint and must be async (§4) — a constant cannot live here. The
// editor imports the same module, so the form and the writer cannot disagree.
import { RECRUITING_PITCH_MAX } from "@/lib/recruiting/recruiting-pitch-limits"

async function resolveBrokerAdmin(
  mode: "read" | "write",
): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  const acting = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!acting.ok) return { ok: false, error: acting.error ?? "Unauthenticated" }
  if (!acting.brokerageId) return { ok: false, error: "No brokerage" }
  // Same roster as the page that hosts the editor (app/dashboard/recruiting-roi)
  // and as every other brokerage-configuration gate: broker / broker_admin /
  // broker_owner / admin. FAIL CLOSED — a gate that cannot run refuses.
  if (!isAdminOrBroker({ user_type: acting.userType })) {
    return { ok: false, error: "Only a broker or admin can edit the recruiting pitch" }
  }
  return { ok: true, brokerageId: acting.brokerageId }
}

/**
 * Read the brokerage's pitch for the editor.
 *
 * FAIL-CLOSED: a refused read is reported as an error, never rendered as "no
 * pitch set yet" — supabase-js resolves refusals, and swallowing one here would
 * invite the broker to overwrite a pitch they were simply not shown (§3).
 */
export async function getRecruitingPitch(): Promise<
  { ok: true; pitch: string } | { ok: false; error: string }
> {
  const ctx = await resolveBrokerAdmin("read")
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("brokerages")
    .select("recruiting_pitch")
    .eq("id", ctx.brokerageId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  return { ok: true, pitch: String((data as { recruiting_pitch?: string | null } | null)?.recruiting_pitch ?? "") }
}

/**
 * The ONE writer of brokerages.recruiting_pitch.
 *
 * An empty string clears it — an explicit "we have no pitch yet", which is what
 * every reader already treats null as. The update is COUNTED: a service-client
 * update pinned to the session tenant must match exactly one row, so zero rows
 * means the brokerage record is gone and the save must not report success (§3 —
 * an unmatched write resolves with error null and is otherwise indistinguishable
 * from a write that worked).
 */
export async function setRecruitingPitch(pitch: string): Promise<{ ok: boolean; error?: string }> {
  // "write": read_only impersonation is refused inside the gate.
  const ctx = await resolveBrokerAdmin("write")
  if (!ctx.ok) return { ok: false, error: ctx.error }

  const trimmed = String(pitch ?? "").trim()
  if (trimmed.length > RECRUITING_PITCH_MAX) {
    return { ok: false, error: `The pitch is ${trimmed.length} characters — keep it under ${RECRUITING_PITCH_MAX}.` }
  }

  const svc = createServiceClient()
  const { data: saved, error } = await svc
    .from("brokerages")
    .update({ recruiting_pitch: trimmed === "" ? null : trimmed, updated_at: new Date().toISOString() })
    .eq("id", ctx.brokerageId)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!saved || saved.length === 0) {
    return { ok: false, error: "The pitch was not saved — your brokerage record could not be found." }
  }
  return { ok: true }
}
