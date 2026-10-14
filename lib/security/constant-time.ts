// lib/security/constant-time.ts
//
// ONE constant-time secret compare (wave 140, lane 140P — lane 140H: "trackDelivery compares
// LOB_WEBHOOK_SECRET with !== (not constant-time)").
//
// `a !== b` on a shared secret returns at the first differing byte, so the comparison time leaks
// how long a correct prefix is. crypto.timingSafeEqual fixes that but THROWS a RangeError on
// buffers of unequal length — a short or forged token would answer 500 instead of 401 (the R-4
// defect class, wave 139). This helper answers FALSE on a length mismatch and compares the rest in
// constant time; an empty / absent value on either side is never a match (an unset secret is a
// refusal, never an open door).
//
// SURVIVOR NOTE (CLAUDE.md §1): the same five lines exist as PRIVATE copies — lib/providers/inbound-router.ts
// `sameBytes`, lib/voice/twilio-voice.ts, lib/education/ce-provider.ts, lib/inbound-mail/providers.ts,
// app/api/workflow/trigger/route.ts, app/settings/developers/developers-client.tsx. None was exported, so
// this is the first SHARED one; merging those copies onto it is an outside-lane correction named in the
// 140P notes, not done here. PURE — no I/O.

import { timingSafeEqual } from "node:crypto"

/** True only when both are non-empty strings of the same byte length and equal in constant time. */
export function secretsEqual(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (typeof presented !== "string" || typeof expected !== "string") return false
  if (presented.length === 0 || expected.length === 0) return false
  const a = Buffer.from(presented, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
