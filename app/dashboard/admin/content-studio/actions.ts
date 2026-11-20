"use server"
import { approveContentItem } from "@/lib/kernel/content-studio"
import { revalidatePath } from "next/cache"
import { authTenantAdminBrokerage as authBrokerage } from "@/lib/auth/require-caller"

// TOMBSTONE: local authBrokerage merged onto lib/auth/require-caller.ts
// authTenantAdminBrokerage (imported above as `authBrokerage`) — §1/§6 SAME
// BODY census round 3, 2026-09-09.

export async function approveContentItemAction(id: string): Promise<{ ok: boolean; note?: string }> {
  const ctx = await authBrokerage()
  if (!ctx) return { ok: false, note: "Not authorized." }
  // WAVE 155 (155R17): the receipt — the tenant-admin gate's SESSION user and tenant. The lib answers { ok, note }; the receipt
  // reads `success` / `error`, so the result is carried beside them and handed back unchanged (a refusal settles failed).
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const out = await ledgerSessionAction({ brokerageId: ctx.brokerageId, action: "marketing.video_project.approve", actor: { type: "user", userId: ctx.userId }, subject: { type: "ai_video_project", id }, riskClass: "COMMUNICATION", reasonCode: "HUMAN_REQUESTED" }, async () => {
  const r = await approveContentItem(ctx.brokerageId, id, ctx.userId)
  return { r, success: r.ok, ...(r.ok ? {} : { error: r.note ?? "Not approved" }) }
  })
  const r = "r" in out ? out.r : { ok: false, note: out.error ?? "Not approved" }
  revalidatePath("/dashboard/admin/content-studio")
  return r
}
