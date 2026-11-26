"use server"

/**
 * app/actions/superadmin/financial-halts.ts — THE PLATFORM DOOR for a financial-writer halt (wave 137,
 * owner "approve all": "platform staff may release a financial halt (with evidence)").
 *
 * The OS health supervisor (lib/kernel/os-health.ts) HALTS a tenant's automated money writer on a
 * financial discrepancy (tenant policy financial_writer_halts). The tenant's finance admins release it
 * on their own command center (app/actions/os-health.ts releaseFinancialWriterHaltAction). This file is
 * the second, PLATFORM-side door: platform staff holding the 'billing' capability with WRITE access
 * (lib/platform/require-capability.ts requirePlatformCapability — gate first, then the service client,
 * CLAUDE.md §4) see every halted writer across tenants and may release one — only with EVIDENCE of what
 * reconciled it, only when the writer is actually halted, through the ONE release writer
 * (releaseFinancialWriterHalt, releasedAs "platform_staff" — a versioned tenant-policy change attributed
 * to the staff user). The target brokerage is the point of a platform console (a TARGET, not a claim of
 * the caller's own tenant) and is re-checked to exist before anything is written.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { FINANCIAL_WRITERS, listHaltedFinancialWriters, releaseFinancialWriterHalt, type FinancialWriterKey } from "@/lib/kernel/os-health"

export async function listHaltedFinancialWritersAction(): Promise<{ ok: true; rows: Array<{ brokerageId: string; brokerageName: string | null; writer: string; label: string; reason: string | null; incident: string | null; setAt: string | null }> } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("billing")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const svc = createServiceClient()
  const r = await listHaltedFinancialWriters(svc)
  if (!r.ok) return { ok: false, error: `Halt states could not be read: ${r.error}` }
  const ids = [...new Set(r.rows.map((x) => x.brokerageId))]
  const names = new Map<string, string | null>()
  if (ids.length) {
    const { data, error } = await svc.from("brokerages").select("id, name").in("id", ids)
    if (error) return { ok: false, error: `Brokerages could not be read: ${error.message}` }
    for (const b of (data ?? []) as Array<{ id: string; name: string | null }>) names.set(b.id, b.name)
  }
  return { ok: true, rows: r.rows.map((x) => ({ ...x, brokerageName: names.get(x.brokerageId) ?? null, label: FINANCIAL_WRITERS[x.writer].label })) }
}

export async function releaseFinancialWriterHaltAsPlatformAction(input: { brokerageId: string; writer: string; reason: string; evidence: string }): Promise<{ success: true } | { success: false; error: string }> {
  const gate = await requirePlatformCapability("billing", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { success: false, error: gate.error ?? "Forbidden — platform billing write access required" }
  const writer = String(input?.writer ?? "") as FinancialWriterKey
  if (!(writer in FINANCIAL_WRITERS)) return { success: false, error: "Unknown financial writer." }
  const reason = String(input?.reason ?? "").trim()
  if (reason.length < 5) return { success: false, error: "Say why the discrepancy is resolved — a release needs a reason." }
  const evidence = String(input?.evidence ?? "").trim()
  if (evidence.length < 10) return { success: false, error: "A platform release needs evidence — name what reconciled the discrepancy." }
  const svc = createServiceClient()
  const target = String(input?.brokerageId ?? "")
  const { data: b, error } = await svc.from("brokerages").select("id").eq("id", target).maybeSingle()
  if (error) return { success: false, error: `Brokerage could not be read: ${error.message}` }
  if (!b) return { success: false, error: "No such brokerage." }
  const r = await releaseFinancialWriterHalt(svc, { brokerageId: target, writer, userId: gate.userId, reason, releasedAs: "platform_staff", evidence })
  return r.ok ? { success: true } : { success: false, error: r.error }
}
