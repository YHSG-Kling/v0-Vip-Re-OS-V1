"use server"

// app/actions/vendors-kernel.ts
//
// Server Action entry points for the Vendor Kernel OS commands.
// These are thin wrappers — all business logic lives in lib/kernel/vendors.ts.
// No direct DB calls here. Every mutation goes through the kernel.

import { createClient } from "@/lib/supabase/server"
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

export async function assignVendorToTransactionAction(
  params: Omit<AssignVendorToTransactionInput, "brokerageId" | "agentUserId">
) {
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
