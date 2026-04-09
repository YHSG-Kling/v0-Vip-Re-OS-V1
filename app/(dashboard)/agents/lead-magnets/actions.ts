'use server'

import { revalidatePath } from 'next/cache'
import * as kernel from '@/lib/kernel/lead-magnets'
import type {
  CreateLeadMagnetParams,
  UpdateLeadMagnetParams,
  TrackDownloadParams,
  LeadMagnetStatus
} from '@/lib/kernel/lead-magnets/types'

// ══════════════════════════════════════════════════════════════════════════════
// Server Actions - Thin Wrappers (no try/catch, transform KernelResponse only)
// ══════════════════════════════════════════════════════════════════════════════

export async function createLeadMagnetAction(params: CreateLeadMagnetParams) {
  const result = await kernel.createLeadMagnet(params)
  
  if (result.data) {
    revalidatePath('/agents/lead-magnets')
  }
  
  return {
    success: !result.error,
    data: result.data,
    error: result.error,
  }
}

export async function getLeadMagnetAction(id: string, brokerageId: string) {
  const result = await kernel.getLeadMagnet(id, brokerageId)
  
  return {
    success: !result.error,
    data: result.data,
    error: result.error,
  }
}

export async function listLeadMagnetsAction(brokerageId: string, status?: LeadMagnetStatus) {
  const result = await kernel.listLeadMagnets(brokerageId, status)
  
  return {
    success: !result.error,
    data: result.data,
    error: result.error,
  }
}

export async function updateLeadMagnetAction(params: UpdateLeadMagnetParams) {
  const result = await kernel.updateLeadMagnet(params)
  
  if (result.data) {
    revalidatePath('/agents/lead-magnets')
    revalidatePath(`/agents/lead-magnets/${params.id}`)
  }
  
  return {
    success: !result.error,
    data: result.data,
    error: result.error,
  }
}

export async function deleteLeadMagnetAction(id: string, brokerageId: string) {
  const result = await kernel.deleteLeadMagnet(id, brokerageId)
  
  if (result.data) {
    revalidatePath('/agents/lead-magnets')
  }
  
  return {
    success: !result.error,
    data: result.data,
    error: result.error,
  }
}

export async function trackDownloadAction(params: TrackDownloadParams) {
  const result = await kernel.trackDownload(params)
  
  if (result.data) {
    revalidatePath('/agents/lead-magnets')
    revalidatePath(`/agents/lead-magnets/${params.leadMagnetId}`)
  }
  
  return {
    success: !result.error,
    data: result.data,
    error: result.error,
  }
}

export async function getLeadMagnetAnalyticsAction(id: string, brokerageId: string) {
  const result = await kernel.getLeadMagnetAnalytics(id, brokerageId)
  
  return {
    success: !result.error,
    data: result.data,
    error: result.error,
  }
}

export async function markDownloadConvertedAction(downloadId: string, brokerageId: string) {
  const result = await kernel.markDownloadConverted(downloadId, brokerageId)
  
  if (result.data) {
    revalidatePath('/agents/lead-magnets')
  }
  
  return {
    success: !result.error,
    data: result.data,
    error: result.error,
  }
}
