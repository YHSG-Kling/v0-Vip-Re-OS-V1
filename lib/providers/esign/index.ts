/**
 * ESIGN PROVIDER
 * Owns all e-signature API calls: Dotloop.
 * No business logic — pure API client wrappers.
 * Re-exports DotloopProvider from lib/integrations for single source of truth.
 */

export { DotloopProvider } from "@/lib/integrations/providers/dotloop-provider"

import { callConnector } from "@/lib/agentic-os/connector-gateway"

// ─── DOTLOOP DIRECT HELPERS ───────────────────────────────────────────────────
// Thin functional wrappers around DotloopProvider for callers that don't want
// to instantiate the class directly.

const DOTLOOP_API_BASE = "https://api-gateway.dotloop.com/public/v2"

function getDotloopCredentials() {
  const apiKey = process.env.DOTLOOP_API_KEY
  const profileId = process.env.DOTLOOP_PROFILE_ID
  return apiKey && profileId ? { apiKey, profileId } : null
}

/** All Dotloop egress through the connector-gateway (bearer auth). */
async function dotloopRequest<T = any>(
  apiKey: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<{ ok: boolean; data: T | null; error: string | null }> {
  const res = await callConnector<T>({
    connector: "dotloop",
    baseUrl: DOTLOOP_API_BASE,
    path,
    method,
    auth: { style: "bearer", token: apiKey },
    ...(body !== undefined ? { body } : {}),
  })
  return { ok: res.ok, data: res.data, error: res.error }
}

export interface CreateLoopParams {
  propertyAddress: string
  transactionType: "purchase" | "listing"
}

export interface CreateLoopResult {
  success: boolean
  loopId?: string
  error?: string
}

export async function createLoop(params: CreateLoopParams): Promise<CreateLoopResult> {
  const credentials = getDotloopCredentials()

  if (!credentials) {
    return { success: true, loopId: `mock-loop-${Date.now()}` }
  }

  const { apiKey, profileId } = credentials

  const response = await dotloopRequest<{ data?: { loop_id?: string } }>(apiKey, `/profile/${profileId}/loop`, "POST", {
    name: `${params.propertyAddress} - ${params.transactionType}`,
    status: "Active",
    transaction_type: params.transactionType === "purchase" ? "Purchase" : "Listing for Sale",
    street_address: params.propertyAddress,
  })

  if (!response.ok) {
    throw new Error(`Dotloop API error: ${response.error ?? "request failed"}`)
  }

  const loopId = response.data?.data?.loop_id

  if (!loopId) throw new Error("No loop_id returned from Dotloop")

  return { success: true, loopId }
}

export interface AddParticipantParams {
  loopId: string
  email: string
  name: string
  role: string
}

export async function addParticipant(params: AddParticipantParams): Promise<{ success: boolean; error?: string }> {
  const credentials = getDotloopCredentials()

  if (!credentials) return { success: true }

  const { apiKey, profileId } = credentials

  const response = await dotloopRequest(apiKey, `/profile/${profileId}/loop/${params.loopId}/participant`, "POST", {
    email: params.email,
    full_name: params.name,
    role: params.role,
  })

  if (!response.ok) {
    throw new Error(`Dotloop addParticipant error: ${response.error ?? "request failed"}`)
  }

  return { success: true }
}

export interface GetLoopStatusResult {
  success: boolean
  total: number
  signed: number
  pending: number
  percentComplete: number
  error?: string
}

export async function getLoopSignatureStatus(loopId: string): Promise<GetLoopStatusResult> {
  const credentials = getDotloopCredentials()

  if (!credentials) {
    return { success: true, total: 5, signed: 3, pending: 2, percentComplete: 60 }
  }

  const { apiKey, profileId } = credentials

  const response = await dotloopRequest<{ data?: any[] }>(apiKey, `/profile/${profileId}/loop/${loopId}/folder`, "GET")

  if (!response.ok) throw new Error(`Dotloop API error: ${response.error ?? "request failed"}`)

  const folders = response.data ?? {}
  let totalDocs = 0
  let signedDocs = 0

  for (const folder of folders.data || []) {
    for (const doc of folder.documents || []) {
      totalDocs++
      if (doc.is_signed) signedDocs++
    }
  }

  return {
    success: true,
    total: totalDocs,
    signed: signedDocs,
    pending: totalDocs - signedDocs,
    percentComplete: totalDocs > 0 ? Math.round((signedDocs / totalDocs) * 100) : 0,
  }
}

// ─── SYNC LOOP DOCUMENTS ───────────────────────────────────────────────────────

export interface LoopFolder {
  name: string
  documents: {
    document_id: string
    name: string
    is_signed: boolean
    url: string
    created_at: string
    updated_at: string
  }[]
}

export interface SyncLoopDocumentsResult {
  success: boolean
  folders: LoopFolder[]
  error?: string
}

export async function syncLoopDocuments(loopId: string): Promise<SyncLoopDocumentsResult> {
  const credentials = getDotloopCredentials()

  if (!credentials) {
    return { success: true, folders: [] }
  }

  const { apiKey, profileId } = credentials

  const response = await dotloopRequest<{ data?: LoopFolder[] }>(apiKey, `/profile/${profileId}/loop/${loopId}/folder`, "GET")

  if (!response.ok) throw new Error(`Dotloop syncLoopDocuments error: ${response.error ?? "request failed"}`)

  return { success: true, folders: response.data?.data || [] }
}

// ─── UPLOAD LOOP DOCUMENT ──────────────────────────────────────────────────────

export interface UploadLoopDocumentParams {
  loopId: string
  documentName: string
  fileUrl: string
  folderName?: string
}

export interface UploadLoopDocumentResult {
  success: boolean
  dotloopDocumentId?: string
  error?: string
}

export async function uploadLoopDocument(
  params: UploadLoopDocumentParams
): Promise<UploadLoopDocumentResult> {
  const credentials = getDotloopCredentials()

  if (!credentials) {
    return { success: true, dotloopDocumentId: `mock-doc-${Date.now()}` }
  }

  const { apiKey, profileId } = credentials
  const folder = params.folderName || "Documents"

  const response = await dotloopRequest<{ data?: { document_id?: string } }>(
    apiKey,
    `/profile/${profileId}/loop/${params.loopId}/folder/${folder}/document`,
    "POST",
    { name: params.documentName, file_url: params.fileUrl },
  )

  if (!response.ok) throw new Error(`Dotloop uploadLoopDocument error: ${response.error ?? "request failed"}`)

  return { success: true, dotloopDocumentId: response.data?.data?.document_id }
}

// ─── GET LOOP ACTIVITY ─────────────────────────────────────────────────────────

export interface GetLoopActivityResult {
  success: boolean
  activities: any[]
  error?: string
}

export async function getLoopActivity(loopId: string): Promise<GetLoopActivityResult> {
  const credentials = getDotloopCredentials()

  if (!credentials) {
    return { success: true, activities: [] }
  }

  const { apiKey, profileId } = credentials

  const response = await dotloopRequest<{ data?: any[] }>(apiKey, `/profile/${profileId}/loop/${loopId}/activity`, "GET")

  if (!response.ok) throw new Error(`Dotloop getLoopActivity error: ${response.error ?? "request failed"}`)

  return { success: true, activities: response.data?.data || [] }
}
