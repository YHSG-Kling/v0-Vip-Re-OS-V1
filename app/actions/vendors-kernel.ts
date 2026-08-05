"use server"

// app/actions/vendors-kernel.ts
//
// Server Action entry points for the Vendor Kernel OS commands.
// These are thin wrappers — all business logic lives in lib/kernel/vendors.ts.
// No direct DB calls here. Every mutation goes through the kernel.

import { getAgentContext } from "@/lib/identity"
import { redirect } from "next/navigation"
import {
  createVendorRecord,
  updateVendorRecord,
  assignVendorToListing,
  assignVendorToTransaction,
  updateVendorBookingStatus,
  attachVendorDeliverable,
  type CreateVendorRecordInput,
  type UpdateVendorRecordInput,
  type AssignVendorToListingInput,
  type AssignVendorToTransactionInput,
  type UpdateVendorBookingStatusInput,
  type AttachVendorDeliverableInput,
} from "@/lib/kernel/vendors"

// ─── INTERNAL: resolve actor context ─────────────────────────────────────────

async function resolveActor(): Promise<{ userId: string; brokerageId: string }> {
  // Kernel OS: getAgentContext — canonical identity, fully typed, never raw auth
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")
  // After redirect guards, TypeScript knows brokerageId is non-null
  return { userId: ctx.userId, brokerageId: ctx.brokerageId }
}

// ─── ACTION: createVendorRecordAction ────────────────────────────────────────
// Creates a new vendor in the `vendors` marketplace table.
// Enforces: name uniqueness per brokerage (case-insensitive).

export async function createVendorRecordAction(
  params: Omit<CreateVendorRecordInput, "brokerageId" | "agentUserId">
) {
  const { userId, brokerageId } = await resolveActor()
  return createVendorRecord({ ...params, brokerageId, agentUserId: userId })
}

// ─── ACTION: updateVendorRecordAction ────────────────────────────────────────

export async function updateVendorRecordAction(
  params: Omit<UpdateVendorRecordInput, "brokerageId" | "agentUserId">
) {
  const { userId, brokerageId } = await resolveActor()
  return updateVendorRecord({ ...params, brokerageId, agentUserId: userId })
}

// ─── ACTION: assignVendorToListingAction ─────────────────────────────────────

export async function assignVendorToListingAction(
  params: Omit<AssignVendorToListingInput, "brokerageId" | "agentUserId">
) {
  const { userId, brokerageId } = await resolveActor()
  return assignVendorToListing({ ...params, brokerageId, agentUserId: userId })
}

// ─── ACTION: assignVendorToTransactionAction ─────────────────────────────────
//
// vendor_assignments.assignment_type is CHECK-constrained, and its vocabulary is
// NOT the vendors.category vocabulary — the column admits ten values where
// vendors.category admits thirty-eight. A picker built from service types (the
// obvious mistake, and what the neighbouring booking form offers: "escrow",
// "plumber", "hvac", "roofer", "surveyor") would produce an INSERT the database
// refuses. Read off the live constraint `vendor_assignments_assignment_type_check`
// and enforced BEFORE the kernel is called, so an unknown value comes back as a
// sentence rather than a 23514. Module-local: every export of a "use server"
// module must be an async function.

const VENDOR_ASSIGNMENT_TYPES = [
  "inspector",
  "lender",
  "title",
  "stager",
  "photographer",
  "cleaner",
  "contractor",
  "mover",
  "insurance",
  "other",
] as const

export async function assignVendorToTransactionAction(
  params: Omit<AssignVendorToTransactionInput, "brokerageId" | "agentUserId">
) {
  if (!(VENDOR_ASSIGNMENT_TYPES as readonly string[]).includes(params.assignmentType)) {
    return {
      success: false as const,
      error: `"${params.assignmentType}" is not an assignment type this deal ledger accepts. Choose one of: ${VENDOR_ASSIGNMENT_TYPES.join(", ")}.`,
    }
  }
  const { userId, brokerageId } = await resolveActor()
  return assignVendorToTransaction({ ...params, brokerageId, agentUserId: userId })
}

// ─── ACTION: updateVendorBookingStatusAction ─────────────────────────────────

export async function updateVendorBookingStatusAction(
  params: Omit<UpdateVendorBookingStatusInput, "brokerageId" | "agentUserId">
) {
  const { userId, brokerageId } = await resolveActor()
  return updateVendorBookingStatus({ ...params, brokerageId, agentUserId: userId })
}

// ─── ACTION: attachVendorDeliverableAction ───────────────────────────────────

export async function attachVendorDeliverableAction(
  params: Omit<AttachVendorDeliverableInput, "brokerageId" | "agentUserId">
) {
  const { userId, brokerageId } = await resolveActor()
  return attachVendorDeliverable({ ...params, brokerageId, agentUserId: userId })
}
