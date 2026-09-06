// lib/voice/isa-readiness.ts
// ─────────────────────────────────────────────────────────────────────────────
// CAN THIS BROKERAGE PLACE AN AI CALL? ONE ANSWER, GROUNDED IN THE REAL GATES.
//
// Three surfaces asked this question and all three answered it wrong, in the
// same way: they tested for a VAPI assistant id.
//
//   · app/dashboard/isa/page.tsx           — process.env.VAPI_ISA_ASSISTANT_ID
//                                            && process.env.VAPI_API_KEY
//   · app/dashboard/voice/isa/page.tsx     — ai_identity_profiles.vapi_assistant_id
//   · app/dashboard/isa/calling/page.tsx   — ai_identity_profiles.vapi_assistant_id
//
// VAPI IS RETIRED. The voice lane is Twilio-native, VOICE_ENGINE is gone, and
// placeOutboundAiCall (lib/voice/twilio-outbound.ts) never touches VAPI. So the
// three banners were false in both directions at once: a correctly-configured
// Twilio brokerage saw a red "VAPI Assistant Not Configured" alert telling them
// AI calling was unavailable when it worked fine, and each banner's CTA sent
// them to /settings?tab=ai-isa to "Configure VAPI" — an instruction to go
// configure a vendor this OS no longer calls. A dead banner is bad; a banner
// that dispatches a human to do pointless work is worse.
//
// THE REAL PRECONDITIONS, taken from placeOutboundAiCall in the order IT checks
// them, so this can never promise a call that the executor will refuse:
//
//   1. an ACTIVE tenant number to dial from (tenant_phone_numbers — the table
//      keeps its legacy name; it is the Twilio number registry now). The
//      executor's own words: "No active tenant phone number to dial from —
//      provision a number first. No call was placed." There is deliberately no
//      shared-platform fallback on this lane, for caller-ID honesty.
//   2. tenant Twilio credentials (BYO → subaccount → master).
//
// TCPA and the vendor budget are checked by the executor too, but they are
// PER-CONTACT and per-moment, not readiness: a brokerage that can call is still
// correctly refused for a particular person on the DNC list. Reporting those
// here would tell an agent their setup is broken when it is one contact that
// is off-limits.

import "server-only"

// The pure half lives in ./isa-readiness-copy so the guard and client surfaces
// can read the vocabulary without importing this server-only module.
export { describeIsaBlocker } from "./isa-readiness-copy"
export type { IsaBlocker, IsaCallingReadiness } from "./isa-readiness-copy"

import { describeIsaBlocker } from "./isa-readiness-copy"
import type { IsaBlocker, IsaCallingReadiness } from "./isa-readiness-copy"

type AnyClient = { from: (t: string) => any }

/**
 * Resolve readiness against the live tenant.
 *
 * Never throws: a surface that cannot answer this question must still render.
 * On an unexpected read failure it reports READY rather than showing a false
 * "not configured" alarm — the executor is the real gate and refuses with a
 * precise reason, which is a far better failure than a banner that tells a
 * working brokerage their calling is broken.
 */
export async function resolveIsaCallingReadiness(
  svc: AnyClient, brokerageId: string | null | undefined,
): Promise<IsaCallingReadiness> {
  const ready = (blocker: IsaBlocker): IsaCallingReadiness => ({
    canPlaceAiCalls: blocker === null, blocker, ...describeIsaBlocker(blocker),
  })

  if (!brokerageId) return ready("no_brokerage")

  try {
    // 1. An active number in the tenant's own registry — the executor's first
    //    hard stop, and the one an agent can actually fix.
    const { data: numbers } = await svc.from("tenant_phone_numbers")
      .select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(1)
    if (!numbers || numbers.length === 0) return ready("no_number")

    // 2. Tenant Twilio credentials, resolved exactly as the executor resolves
    //    them so the two can never disagree.
    const { resolveTenantTwilioCreds } = await import("./twilio-tenancy")
    const creds = await resolveTenantTwilioCreds(svc as any, brokerageId)
    if (!creds) return ready("no_twilio")

    return ready(null)
  } catch {
    return ready(null)
  }
}
