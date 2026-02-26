/**
 * ESIGN PROVIDER
 * Owns all e-signature API calls: Dotloop.
 * No business logic — pure API client wrappers.
 * Re-exports DotloopProvider from lib/integrations for single source of truth.
 */

export { DotloopProvider } from "@/lib/integrations/providers/dotloop-provider"

// ─── DOTLOOP DIRECT HELPERS ───────────────────────────────────────────────────
// Thin functional wrappers around DotloopProvider for callers that don't want
// to instantiate the class directly.

const DOTLOOP_API_BASE = "https://api-gateway.dotloop.com/public/v2"

function getDotloopCredentials() {
  const apiKey = process.env.DOTLOOP_API_KEY
  const profileId = process.env.DOTLOOP_PROFILE_ID
  return apiKey && profileId ? { apiKey, profileId } : null
}

function dotloopHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  }
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

  const response = await fetch(`${DOTLOOP_API_BASE}/profile/${profileId}/loop`, {
    method: "POST",
    headers: dotloopHeaders(apiKey),
    body: JSON.stringify({
      name: `${params.propertyAddress} - ${params.transactionType}`,
      status: "Active",
      transaction_type: params.transactionType === "purchase" ? "Purchase" : "Listing for Sale",
      street_address: params.propertyAddress,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Dotloop API error: ${response.statusText} - ${errorText}`)
  }

  const result = await response.json()
  const loopId = result.data?.loop_id

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

  const response = await fetch(
    `${DOTLOOP_API_BASE}/profile/${profileId}/loop/${params.loopId}/participant`,
    {
      method: "POST",
      headers: dotloopHeaders(apiKey),
      body: JSON.stringify({
        email: params.email,
        full_name: params.name,
        role: params.role,
      }),
    }
  )

  if (!response.ok) {
    throw new Error(`Dotloop addParticipant error: ${response.statusText}`)
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

  const response = await fetch(
    `${DOTLOOP_API_BASE}/profile/${profileId}/loop/${loopId}/folder`,
    { headers: dotloopHeaders(apiKey) }
  )

  if (!response.ok) throw new Error(`Dotloop API error: ${response.statusText}`)

  const folders = await response.json()
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

  const response = await fetch(
    `${DOTLOOP_API_BASE}/profile/${profileId}/loop/${loopId}/folder`,
    { headers: dotloopHeaders(apiKey) }
  )

  if (!response.ok) throw new Error(`Dotloop syncLoopDocuments error: ${response.statusText}`)

  const data = await response.json()

  return { success: true, folders: data.data || [] }
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

  const response = await fetch(
    `${DOTLOOP_API_BASE}/profile/${profileId}/loop/${params.loopId}/folder/${folder}/document`,
    {
      method: "POST",
      headers: dotloopHeaders(apiKey),
      body: JSON.stringify({
        name: params.documentName,
        file_url: params.fileUrl,
      }),
    }
  )

  if (!response.ok) throw new Error(`Dotloop uploadLoopDocument error: ${response.statusText}`)

  const result = await response.json()

  return { success: true, dotloopDocumentId: result.data?.document_id }
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

  const response = await fetch(
    `${DOTLOOP_API_BASE}/profile/${profileId}/loop/${loopId}/activity`,
    { headers: dotloopHeaders(apiKey) }
  )

  if (!response.ok) throw new Error(`Dotloop getLoopActivity error: ${response.statusText}`)

  const data = await response.json()

  return { success: true, activities: data.data || [] }
}
