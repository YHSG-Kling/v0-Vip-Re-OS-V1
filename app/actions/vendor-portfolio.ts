"use server"

/**
 * app/actions/vendor-portfolio.ts — VENDOR WORK SAMPLES (wave 147, lane 147H; owner ruling 9: "build the missing
 * capabilities and also ones that say 'not available yet'").
 *
 * /vendor/portfolio said "Portfolio uploads are not available yet" (wave 146H made the old fake-success upload honest)
 * because there was no store, no writer and no reader. This file is the writer and both readers over the m906 store
 * (public.vendor_portfolio_items); the media object lives in the PRIVATE `documents` bucket (service_only, measured)
 * and is shown through 1-hour signed URLs minted by lib/storage/document-buckets.ts issueBucketObjectUrl — the one
 * issuer that refuses to fall back to a permanent public link.
 *
 * GATE FIRST, THEN THE SERVICE CLIENT (CLAUDE.md §4): the vendor is resolved from the SESSION's own grants
 * (readRoleGrants → selectVendorId) and re-proved by requireVendorActor, which also yields the brokerage — never a
 * request body. Staff readers come from getAgentContext and may only read a vendor of their own brokerage. Every
 * write is ledgered (LAW 5: vendor.portfolio_item.add / .remove) and counted (a zero-row update is a refusal).
 * Every export is async and a public endpoint.
 */

import { createHash, randomUUID } from "node:crypto"
import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

const TABLE = "vendor_portfolio_items"
const BUCKET = "documents"
const MAX_BYTES = 7 * 1024 * 1024 // under next.config.ts serverActions.bodySizeLimit (8mb) with form overhead
const KINDS: Record<string, { kind: "image" | "pdf"; ext: string }> = {
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/png": { kind: "image", ext: "png" },
  "image/webp": { kind: "image", ext: "webp" },
  "application/pdf": { kind: "pdf", ext: "pdf" },
}
/** The honest state when the m906 store is missing from the database (42P01 / PGRST205) — names the migration. */
const STORE_MISSING = "The portfolio store (vendor_portfolio_items) is missing from this database — platform staff apply migration m906 to switch it on."
const isMissingTable = (e: { code?: string | null; message?: string | null } | null) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /relation .* does not exist/i.test(e.message ?? ""))

export interface VendorPortfolioItem {
  id: string
  title: string
  description: string | null
  mediaKind: "image" | "pdf"
  url: string | null
  createdAt: string
}
export type VendorPortfolioRead =
  | { ok: true; available: boolean; vendor: { id: string; name: string; category: string | null } | null; items: VendorPortfolioItem[]; note: string | null }
  | { ok: false; error: string }
export type VendorPortfolioSubmitState = { ok: boolean; message: string } | null

type Gate = { ok: true; userId: string; vendorId: string; brokerageId: string } | { ok: false; error: string }

/** The SESSION's vendor, proved twice (own grants → requireVendorActor). */
async function requireSessionVendor(): Promise<Gate> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Sign in to manage your portfolio." }
  const { readRoleGrants, selectVendorId } = await import("@/lib/auth/role-grants")
  const grants = await readRoleGrants(supabase, user.id)
  if (!grants.ok) return { ok: false, error: "Could not verify your vendor access just now — please try again." }
  const { vendorId, ambiguous } = selectVendorId(grants.grants)
  if (ambiguous) return { ok: false, error: "Your account is linked to more than one vendor — ask your brokerage to fix the link before uploading." }
  if (!vendorId) return { ok: false, error: "No vendor profile is linked to your account." }
  try {
    const { requireVendorActor } = await import("@/lib/kernel/portal-auth")
    const actor = await requireVendorActor(vendorId)
    return { ok: true, userId: actor.userId, vendorId: actor.vendorId, brokerageId: actor.brokerageId }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Not authorized for this vendor." }
  }
}

async function signItems(svc: ReturnType<typeof createServiceClient>, rows: Array<{ id: string; title: string; description: string | null; media_kind: string; media_path: string; created_at: string }>): Promise<VendorPortfolioItem[]> {
  const { issueBucketObjectUrl } = await import("@/lib/storage/document-buckets")
  return Promise.all(rows.map(async (r) => {
    const issued = await issueBucketObjectUrl(svc as never, { bucket: BUCKET, objectPath: r.media_path, ttlSeconds: 3600 })
    if (!issued.ok) console.error(`[vendor-portfolio] could not sign ${r.id}: ${issued.reason}`)
    return { id: r.id, title: r.title, description: r.description, mediaKind: r.media_kind === "pdf" ? "pdf" : "image", url: issued.ok ? issued.url : null, createdAt: r.created_at }
  }))
}

/** The vendor's own portfolio (the /vendor/portfolio page). */
export async function listMyVendorPortfolio(): Promise<VendorPortfolioRead> {
  const gate = await requireSessionVendor()
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()
  const { data: vendor, error: vErr } = await svc.from("vendors").select("id, name, category").eq("id", gate.vendorId).eq("brokerage_id", gate.brokerageId).maybeSingle()
  if (vErr) return { ok: false, error: `Could not read your vendor profile: ${vErr.message}` }
  const { data, error } = await svc.from(TABLE).select("id, title, description, media_kind, media_path, created_at")
    .eq("vendor_id", gate.vendorId).eq("brokerage_id", gate.brokerageId).eq("status", "published").order("created_at", { ascending: false }).limit(60)
  if (error) {
    if (isMissingTable(error)) return { ok: true, available: false, vendor: (vendor as never) ?? null, items: [], note: STORE_MISSING }
    return { ok: false, error: `Could not read your portfolio: ${error.message}` }
  }
  return { ok: true, available: true, vendor: (vendor as never) ?? null, items: await signItems(svc, (data ?? []) as never), note: null }
}

/** A vendor's portfolio for the brokerage's own staff (the vendor directory). Tenant from the session; a vendor of
 *  another brokerage reads as not found. External seats (vendor / lender / title / contact) are refused. */
export async function listVendorPortfolioForStaff(vendorId: string): Promise<VendorPortfolioRead> {
  const { getAgentContext } = await import("@/lib/identity")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  // External seats are user_type 'vendor' (lenders and title partners are vendor CATEGORIES, CLAUDE.md §4) or 'contact'.
  if (ctx.userType === "vendor" || ctx.userType === "contact") return { ok: false, error: "Only brokerage staff can browse vendor portfolios." }
  const svc = createServiceClient()
  const { data: vendor, error: vErr } = await svc.from("vendors").select("id, name, category").eq("id", String(vendorId ?? "")).eq("brokerage_id", ctx.brokerageId).maybeSingle()
  if (vErr) return { ok: false, error: `Could not read the vendor: ${vErr.message}` }
  if (!vendor) return { ok: false, error: "Vendor not found" }
  const { data, error } = await svc.from(TABLE).select("id, title, description, media_kind, media_path, created_at")
    .eq("vendor_id", (vendor as { id: string }).id).eq("brokerage_id", ctx.brokerageId).eq("status", "published").order("created_at", { ascending: false }).limit(24)
  if (error) {
    if (isMissingTable(error)) return { ok: true, available: false, vendor: vendor as never, items: [], note: STORE_MISSING }
    return { ok: false, error: `Could not read the portfolio: ${error.message}` }
  }
  return { ok: true, available: true, vendor: vendor as never, items: await signItems(svc, (data ?? []) as never), note: null }
}

/** The upload (useActionState form action on /vendor/portfolio/upload). */
export async function addVendorPortfolioItem(_prev: VendorPortfolioSubmitState, formData: FormData): Promise<VendorPortfolioSubmitState> {
  const gate = await requireSessionVendor()
  if (!gate.ok) return { ok: false, message: gate.error }
  const title = String(formData.get("title") ?? "").trim().slice(0, 120)
  const description = String(formData.get("description") ?? "").trim().slice(0, 2000) || null
  const file = formData.get("file")
  if (!title) return { ok: false, message: "Give the work a title." }
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose a photo or PDF to upload." }
  if (file.size > MAX_BYTES) return { ok: false, message: "That file is larger than 7 MB." }
  const kind = KINDS[file.type]
  if (!kind) return { ok: false, message: "Upload a JPG, PNG, WebP image or a PDF." }

  const bytes = Buffer.from(await file.arrayBuffer())
  const sha = createHash("sha256").update(bytes).digest("hex")
  const svc = createServiceClient()
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const r = await withActionLedger<VendorPortfolioSubmitState & { itemId?: string | null }>(
    {
      brokerageId: gate.brokerageId, action: "vendor.portfolio_item.add",
      actor: { type: "user", userId: gate.userId },
      subject: { type: "vendor", id: gate.vendorId },
      reasonDetail: `portfolio work sample uploaded (${kind.kind}, ${bytes.length} bytes)`,
      idempotencyKey: `vendor_portfolio_add:${gate.vendorId}:${sha}`, riskClass: "LOW_RISK_WRITE", channel: "vendor_portal",
      detail: { media_kind: kind.kind, bytes: bytes.length },
    },
    async () => {
      const path = `vendor-portfolio/${gate.brokerageId}/${gate.vendorId}/${randomUUID()}.${kind.ext}`
      const { error: upErr } = await svc.storage.from(BUCKET).upload(path, bytes, { contentType: file.type, upsert: false })
      if (upErr) return { ok: false, message: `The file could not be stored: ${upErr.message}` }
      const { data, error } = await svc.from(TABLE).insert({
        vendor_id: gate.vendorId, brokerage_id: gate.brokerageId, title, description, media_path: path, media_kind: kind.kind,
        media_bytes: bytes.length, content_sha256: sha, status: "published", created_by_user_id: gate.userId,
      }).select("id").single()
      if (error || !data) {
        // Never leave an orphan object behind a refused row.
        const { error: rmErr } = await svc.storage.from(BUCKET).remove([path])
        if (rmErr) console.error(`[vendor-portfolio] orphan object ${path} not removed: ${rmErr.message}`)
        return { ok: false, message: isMissingTable(error) ? STORE_MISSING : `The work sample could not be saved: ${error?.message ?? "no row"}` }
      }
      return { ok: true, message: "Added to your portfolio — agents in your brokerage can see it in the vendor directory.", itemId: (data as { id: string }).id }
    },
    {
      settle: (x) => ({ status: x?.ok ? "executed" : "failed", outcome: x?.ok ? "added" : "not_added", providerRef: x?.itemId ?? null, error: x?.ok ? null : x?.message ?? null }),
      replay: (claim) => (claim.kind === "refused" ? { ok: false, message: `Not saved — the upload could not be recorded (${claim.error}).` } : { ok: true, message: "That file is already in your portfolio." }),
    },
    { client: svc },
  )
  if (r?.ok) { revalidatePath("/vendor/portfolio"); revalidatePath("/dashboard/vendors") }
  return r ? { ok: r.ok, message: r.message } : { ok: false, message: "Not saved." }
}

/** Remove one of the vendor's own items (soft remove — the row stays as evidence; the object is deleted). */
export async function removeVendorPortfolioItem(itemId: string): Promise<{ ok: boolean; error?: string }> {
  const gate = await requireSessionVendor()
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const r = await withActionLedger<{ ok: boolean; error?: string }>(
    {
      brokerageId: gate.brokerageId, action: "vendor.portfolio_item.remove",
      actor: { type: "user", userId: gate.userId },
      subject: { type: "vendor_portfolio_item", id: String(itemId ?? "") },
      reasonDetail: "vendor removed a work sample", idempotencyKey: `vendor_portfolio_remove:${String(itemId ?? "")}`,
      riskClass: "LOW_RISK_WRITE", channel: "vendor_portal",
    },
    async () => {
      // Pinned to the session's vendor AND tenant: another vendor's item matches no row and is refused, not removed.
      const { data, error } = await svc.from(TABLE).update({ status: "removed", removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", String(itemId ?? "")).eq("vendor_id", gate.vendorId).eq("brokerage_id", gate.brokerageId).eq("status", "published").select("id, media_path")
      if (error) return { ok: false, error: isMissingTable(error) ? STORE_MISSING : error.message }
      const row = ((data ?? []) as Array<{ id: string; media_path: string }>)[0]
      if (!row) return { ok: false, error: "Item not found" }
      const { error: rmErr } = await svc.storage.from(BUCKET).remove([row.media_path])
      if (rmErr) console.error(`[vendor-portfolio] object ${row.media_path} not removed: ${rmErr.message}`)
      return { ok: true }
    },
    {
      settle: (x) => ({ status: x.ok ? "executed" : "failed", outcome: x.ok ? "removed" : "not_removed", error: x.error ?? null }),
      replay: (claim) => (claim.kind === "refused" ? { ok: false, error: `Not removed — could not be recorded (${claim.error}).` } : { ok: true }),
    },
    { client: svc },
  )
  if (r.ok) { revalidatePath("/vendor/portfolio"); revalidatePath("/dashboard/vendors") }
  return r
}
