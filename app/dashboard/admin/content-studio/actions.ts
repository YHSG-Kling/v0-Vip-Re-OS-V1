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
  const r = await approveContentItem(ctx.brokerageId, id, ctx.userId)
  revalidatePath("/dashboard/admin/content-studio")
  return r
}
