"use server"

// app/actions/intent-writers.ts
// ─────────────────────────────────────────────────────────────────────────────
// VOICE-ADMIN INTENT WRITERS (burn-down round 4). Four agent-intent tables were
// READ by live surfaces but had no writer — the features could never fire:
//   · document_requests   → the AI assistant's "N documents overdue" alert
//   · contact_vendors     → the vendor-messaging auth gate + CRM vendor panel
//   · property_upgrades   → the seller CMA's upgrades/valuation section
//   · contact_portal_preferences → per-contact portal milestone visibility
// These are exactly the "tell the admin and it's done" class, so they ship as
// voice-first commands (the voice assistant dispatches here) — every write is
// tenant-anchored and identity-correct (agents-class vs users-class verified
// against live FKs).

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { revalidatePath } from "next/cache"

/**
 * ROUND-TRIP RECEIPT: after every write, the row is read back FRESH from the
 * ledger and the receipt is composed from THAT row — never from the input.
 * The voice admin speaks these facts, so "done" always means "verified on the
 * ledger", not "I tried". A write that can't be read back reports failure.
 */
export interface LedgerReceipt {
  table: string
  rowId: string
  /** When the ledger says the row landed/changed (row timestamp, not now()). */
  recordedAt: string | null
  /** Ledger-sourced facts the voice line can speak (status, due date, role…). */
  facts: Record<string, string>
}

/** Request a document from a contact/transaction. Live CHECK: status
 *  pending/submitted/approved/rejected/cancelled. requested_by is users-class. */
export async function requestDocument(input: {
  documentName: string
  documentType?: string | null
  transactionId?: string | null
  contactId?: string | null
  dueDate?: string | null // YYYY-MM-DD
}): Promise<{ success: boolean; requestId?: string; receipt?: LedgerReceipt; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!input.documentName?.trim()) return { success: false, error: "document_name_required" }
  const svc = createServiceClient()
  const { data, error } = await svc.from("document_requests").insert({
    brokerage_id: ctx.brokerageId,
    transaction_id: input.transactionId ?? null,
    contact_id: input.contactId ?? null,
    document_name: input.documentName.trim(),
    document_type: input.documentType ?? null,
    status: "pending",
    due_date: input.dueDate ?? null,
    requested_by: ctx.userId,
    metadata: { source: "intent_writer" },
  }).select("id").single()
  if (error) return { success: false, error: error.message }
  // Round-trip: fresh read of the row that landed.
  const { data: fresh } = await svc.from("document_requests")
    .select("id, document_name, status, due_date, created_at")
    .eq("id", data.id).maybeSingle()
  if (!fresh) return { success: false, error: "write_not_verifiable" }
  revalidatePath("/dashboard/transactions")
  return {
    success: true,
    requestId: fresh.id as string,
    receipt: {
      table: "document_requests",
      rowId: fresh.id as string,
      recordedAt: (fresh as any).created_at ?? null,
      facts: {
        document: String((fresh as any).document_name),
        status: String((fresh as any).status),
        ...((fresh as any).due_date ? { due: String((fresh as any).due_date) } : {}),
      },
    },
  }
}

/** Link a vendor to a contact (the relationship the vendor-messaging gate and
 *  the CRM vendor panel read). UNIQUE (contact_id, vendor_id, transaction_id)
 *  live-verified → upsert is pass-10 safe. agent_id is AGENTS-class (live FK). */
export async function assignVendorToContact(input: {
  contactId: string
  vendorId: string
  transactionId?: string | null
  role?: string | null
  notes?: string | null
}): Promise<{ success: boolean; receipt?: LedgerReceipt; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  const svc = createServiceClient()
  // Tenant checks on both ends of the link — never link across brokerages.
  const [{ data: contact }, { data: vendor }] = await Promise.all([
    svc.from("contacts").select("brokerage_id").eq("id", input.contactId).maybeSingle(),
    svc.from("vendors").select("brokerage_id").eq("id", input.vendorId).maybeSingle(),
  ])
  if (!contact || (contact.brokerage_id as string) !== ctx.brokerageId) return { success: false, error: "contact_not_in_brokerage" }
  if (!vendor || ((vendor.brokerage_id as string | null) && (vendor.brokerage_id as string) !== ctx.brokerageId)) {
    return { success: false, error: "vendor_not_in_brokerage" }
  }
  const row = {
    brokerage_id: ctx.brokerageId,
    contact_id: input.contactId,
    vendor_id: input.vendorId,
    transaction_id: input.transactionId ?? null,
    agent_id: ctx.agentId, // agents-class (live FK → agents)
    role: input.role ?? null,
    status: "active", // live CHECK: active/inactive/declined
    introduced_at: new Date().toISOString(),
    notes: input.notes ?? null,
  }
  if (input.transactionId) {
    // UNIQUE (contact_id, vendor_id, transaction_id) — upsert is safe here.
    const { error } = await svc.from("contact_vendors").upsert(row, { onConflict: "contact_id,vendor_id,transaction_id" })
    if (error) return { success: false, error: error.message }
  } else {
    // NULL transaction_id: Postgres treats NULLs as distinct in the unique
    // index, so ON CONFLICT can never match — check-then-update instead of
    // stacking duplicate links on every repeated command.
    const { data: existing } = await svc.from("contact_vendors")
      .select("id").eq("contact_id", input.contactId).eq("vendor_id", input.vendorId).is("transaction_id", null).maybeSingle()
    if (existing) {
      const { error } = await svc.from("contact_vendors")
        .update({ status: "active", role: row.role, notes: row.notes }).eq("id", (existing as any).id)
      if (error) return { success: false, error: error.message }
    } else {
      const { error } = await svc.from("contact_vendors").insert(row)
      if (error) return { success: false, error: error.message }
    }
  }
  // Round-trip: fresh read of the link as it now stands on the ledger.
  let linkQ = svc.from("contact_vendors")
    .select("id, status, role, introduced_at")
    .eq("contact_id", input.contactId).eq("vendor_id", input.vendorId)
  const { data: freshLink } = await (input.transactionId
    ? linkQ.eq("transaction_id", input.transactionId)
    : linkQ.is("transaction_id", null)
  ).maybeSingle()
  if (!freshLink) return { success: false, error: "write_not_verifiable" }
  revalidatePath("/crm")
  return {
    success: true,
    receipt: {
      table: "contact_vendors",
      rowId: (freshLink as any).id as string,
      recordedAt: (freshLink as any).introduced_at ?? null,
      facts: {
        status: String((freshLink as any).status),
        ...((freshLink as any).role ? { role: String((freshLink as any).role) } : {}),
      },
    },
  }
}

/** Record a property upgrade on a listing (feeds the seller CMA's valuation
 *  adjustments). Live CHECK: status suggested/approved/completed/declined. */
export async function logPropertyUpgrade(input: {
  listingId: string
  description: string
  estimatedCost?: number | null
  roiEstimate?: number | null
  status?: "suggested" | "approved" | "completed" | "declined"
}): Promise<{ success: boolean; upgradeId?: string; receipt?: LedgerReceipt; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!input.description?.trim()) return { success: false, error: "description_required" }
  const svc = createServiceClient()
  const { data: listing } = await svc.from("listings").select("brokerage_id").eq("id", input.listingId).maybeSingle()
  if (!listing || (listing.brokerage_id as string) !== ctx.brokerageId) return { success: false, error: "listing_not_in_brokerage" }
  const { data, error } = await svc.from("property_upgrades").insert({
    listing_id: input.listingId,
    brokerage_id: ctx.brokerageId,
    upgrade_description: input.description.trim(),
    estimated_cost: input.estimatedCost ?? null,
    roi_estimate: input.roiEstimate ?? null,
    status: input.status ?? "completed", // sellers usually report work already done
  }).select("id").single()
  if (error) return { success: false, error: error.message }
  // Round-trip: fresh read of the row that landed.
  const { data: fresh } = await svc.from("property_upgrades")
    .select("id, status, estimated_cost, created_at")
    .eq("id", data.id).maybeSingle()
  if (!fresh) return { success: false, error: "write_not_verifiable" }
  revalidatePath("/dashboard/listings")
  return {
    success: true,
    upgradeId: fresh.id as string,
    receipt: {
      table: "property_upgrades",
      rowId: fresh.id as string,
      recordedAt: (fresh as any).created_at ?? null,
      facts: {
        status: String((fresh as any).status),
        ...((fresh as any).estimated_cost != null ? { cost: `$${Number((fresh as any).estimated_cost).toLocaleString()}` } : {}),
      },
    },
  }
}

/** Set which milestones a contact sees in their portal (the kernel portal read
 *  falls back to defaults when no row exists). UNIQUE(contact_id) → upsert. */
export async function setPortalMilestonePreferences(input: {
  contactId: string
  /** e.g. { inspection: false, appraisal: true } — milestone key → visible */
  milestoneOverrides: Record<string, boolean>
  // TOMBSTONE (wave H5): `notificationSettings` was removed from this input and
  // its write to contact_portal_preferences.notification_settings deleted. It
  // was a SECOND SPELLING of the contact's notification choices with no reader
  // — the surviving one is contacts.metadata.notification_preferences, resolved
  // and enforced by lib/notifications/buyer-preferences.ts:40
  // (resolveBuyerNotificationPreferences) and consulted by every buyer-facing
  // send path; it is written by app/components/portal/PortalSettingsPage.tsx:180.
  // Nothing was merged onto the survivor because nothing was missing: the twin
  // was an untyped blob, never read, and the only caller of this action
  // (app/actions/voice-assistant.ts:322) never passed it. Live check on
  // hrvaqgvukzxfskkcrwbt 2026-08-28: 0 rows in the table, 0 carrying a non-empty
  // value, so no data is stranded. Column drop written as
  // supabase/migrations/m584 (WRITTEN, NOT APPLIED).
}): Promise<{ success: boolean; receipt?: LedgerReceipt; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const { data: contact } = await svc.from("contacts").select("brokerage_id").eq("id", input.contactId).maybeSingle()
  if (!contact || (contact.brokerage_id as string) !== ctx.brokerageId) return { success: false, error: "contact_not_in_brokerage" }
  const row: Record<string, unknown> = {
    contact_id: input.contactId,
    brokerage_id: ctx.brokerageId,
    milestone_overrides: input.milestoneOverrides ?? {},
    updated_at: new Date().toISOString(),
  }
  const { error } = await svc.from("contact_portal_preferences").upsert(row, { onConflict: "contact_id" })
  if (error) return { success: false, error: error.message }
  // Round-trip: fresh read of the preference row as the portal will see it.
  const { data: fresh } = await svc.from("contact_portal_preferences")
    .select("id, milestone_overrides, updated_at")
    .eq("contact_id", input.contactId).maybeSingle()
  if (!fresh) return { success: false, error: "write_not_verifiable" }
  revalidatePath("/portal")
  const overrides = ((fresh as any).milestone_overrides ?? {}) as Record<string, boolean>
  const hidden = Object.entries(overrides).filter(([, v]) => v === false).length
  return {
    success: true,
    receipt: {
      table: "contact_portal_preferences",
      rowId: (fresh as any).id as string,
      recordedAt: (fresh as any).updated_at ?? null,
      facts: {
        overrides: String(Object.keys(overrides).length),
        hidden: String(hidden),
      },
    },
  }
}
