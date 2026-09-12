"use server"

/**
 * app/actions/video/memory-video.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AGENT'S SURFACE for the memory video — offer it, and capture what the
 * seller dictates.
 *
 * "use server": EVERY export in this file is a public HTTP endpoint the browser
 * can call by name with arguments of its choosing (CLAUDE.md §4). So there are
 * exactly two of them, both async, and neither takes a brokerageId: the tenant is
 * resolved from the SESSION and a contact id belonging to another tenant matches
 * no row rather than leaking one. There is no such thing as a private helper in a
 * "use server" file, which is why the eligibility rule, the authorship boundary
 * and the I/O all live in lib/ and this file only gates and forwards.
 *
 * WHAT THIS IS NOT: an auto-send. The owner's ruling calls the memory video "a
 * special service that can be offered", so offering it is an ACTION AN AGENT
 * TAKES. Nothing here runs on a cron, and the offer itself only files a gated
 * proposal that a human still has to approve before a word reaches the seller.
 */
import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
import {
  offerMemoryVideo,
  recordMemoryVideoDictation,
  type MemoryVideoOfferResult,
  type MemoryVideoCaptureResult,
} from "@/lib/video/memory-video"
import type { SellerDictatedSegment } from "@/lib/video/memory-video-gate"

type Caller =
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }

/**
 * THE GATE. Fails closed: a session we cannot read, or a user with no brokerage,
 * refuses — "nobody checked" must never render as "checked and fine" (§4).
 * Not exported: in a "use server" file an exported helper is an endpoint.
 */
async function requireCaller(): Promise<Caller> {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) return { ok: false, error: "Unauthorized" }
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", auth.user.id)
    .maybeSingle()
  if (profileError) return { ok: false, error: profileError.message }
  const brokerageId = (profile as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  if (!brokerageId) return { ok: false, error: "No brokerage on this account" }
  return { ok: true, userId: auth.user.id, brokerageId }
}

/**
 * OFFER the memory video to this seller. Files ONE gated agent proposal; the
 * eligibility rule (more than 20 years in the home, failing closed on unknown
 * tenure) is re-checked server-side, so a stale button on a page that was
 * rendered before the tenure changed cannot smuggle an ineligible contact past.
 */
export async function offerMemoryVideoAction(
  contactId: string,
): Promise<MemoryVideoOfferResult> {
  const caller = await requireCaller()
  if (!caller.ok) return { ok: false, status: "failed", reason: caller.error }
  if (!contactId) return { ok: false, status: "failed", reason: "contactId required" }

  const result = await offerMemoryVideo({
    brokerageId: caller.brokerageId,
    contactId,
  })
  if (result.ok) revalidatePath(`/crm/contacts/${contactId}`)
  return result
}

/**
 * CAPTURE what the seller said. `segments` carry the seller's own words and their
 * provenance; the pure assembler in lib/video/memory-video-gate.ts orders them
 * and refuses anything it cannot attribute to a chapter the seller was asked.
 *
 * NO MODEL IS INVOKED ON THIS PATH, here or downstream. A half-finished capture
 * stays half-finished and says which chapters are outstanding — the platform does
 * not finish a family's sentences.
 */
export async function saveMemoryVideoDictationAction(
  contactId: string,
  segments: SellerDictatedSegment[],
): Promise<MemoryVideoCaptureResult> {
  const caller = await requireCaller()
  if (!caller.ok) return { ok: false, status: "failed", reason: caller.error }
  if (!contactId) return { ok: false, status: "failed", reason: "contactId required" }
  if (!Array.isArray(segments)) return { ok: false, status: "failed", reason: "segments required" }

  const supabase = await createClient()
  // ai_video_projects.agent_id is an agents.id and agents.id / users.id are
  // DISJOINT id spaces (CLAUDE.md §3) — resolving through the wrong one is a
  // 23503, not a mismatch you find later.
  const agentRecordId = await resolveAgentIdInBrokerage(supabase, caller.userId, caller.brokerageId)
  if (!agentRecordId) {
    return { ok: false, status: "failed", reason: "no agents record for this user in this brokerage" }
  }

  const result = await recordMemoryVideoDictation({
    brokerageId: caller.brokerageId,
    contactId,
    agentRecordId,
    segments,
  })
  if (result.ok) revalidatePath(`/crm/contacts/${contactId}`)
  return result
}
