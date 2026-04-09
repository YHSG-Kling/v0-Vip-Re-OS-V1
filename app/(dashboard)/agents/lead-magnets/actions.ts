'use server'

import { revalidatePath } from 'next/cache'
import * as leadMagnetsKernel from '@/lib/kernel/lead-magnets'
import type {
  CreateLeadMagnetParams,
  UpdateLeadMagnetParams,
  TrackDownloadParams,
  LeadMagnetStatus
} from '@/lib/kernel/lead-magnets/types'

export async function createLeadMagnetAction(params: CreateLeadMagnetParams) {
  try {
    const magnet = await leadMagnetsKernel.createLeadMagnet(params)
    revalidatePath('/agents/lead-magnets')
    return { success: true, data: magnet }
  } catch (error) {
    console.error('Error creating lead magnet:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create lead magnet'
    }
  }
}

export async function getLeadMagnetAction(id: string, brokerageId: string) {
  try {
    const magnet = await leadMagnetsKernel.getLeadMagnet(id, brokerageId)
    return { success: true, data: magnet }
  } catch (error) {
    console.error('Error getting lead magnet:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get lead magnet'
    }
  }
}

export async function listLeadMagnetsAction(
  brokerageId: string,
  status?: LeadMagnetStatus
) {
  try {
    const magnets = await leadMagnetsKernel.listLeadMagnets(brokerageId, status)
    return { success: true, data: magnets }
  } catch (error) {
    console.error('Error listing lead magnets:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list lead magnets'
    }
  }
}

export async function updateLeadMagnetAction(params: UpdateLeadMagnetParams) {
  try {
    const magnet = await leadMagnetsKernel.updateLeadMagnet(params)
    revalidatePath('/agents/lead-magnets')
    revalidatePath(`/agents/lead-magnets/${params.id}`)
    return { success: true, data: magnet }
  } catch (error) {
    console.error('Error updating lead magnet:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update lead magnet'
    }
  }
}

export async function deleteLeadMagnetAction(id: string, brokerageId: string) {
  try {
    await leadMagnetsKernel.deleteLeadMagnet(id, brokerageId)
    revalidatePath('/agents/lead-magnets')
    return { success: true }
  } catch (error) {
    console.error('Error deleting lead magnet:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete lead magnet'
    }
  }
}

export async function trackDownloadAction(params: TrackDownloadParams) {
  try {
    const download = await leadMagnetsKernel.trackDownload(params)
    revalidatePath('/agents/lead-magnets')
    revalidatePath(`/agents/lead-magnets/${params.leadMagnetId}`)
    return { success: true, data: download }
  } catch (error) {
    console.error('Error tracking download:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to track download'
    }
  }
}

export async function getLeadMagnetAnalyticsAction(
  id: string,
  brokerageId: string
) {
  try {
    const analytics = await leadMagnetsKernel.getLeadMagnetAnalytics(id, brokerageId)
    return { success: true, data: analytics }
  } catch (error) {
    console.error('Error getting analytics:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get analytics'
    }
  }
}

export async function getContactDownloadsAction(
  contactId: string,
  brokerageId: string
) {
  try {
    const downloads = await leadMagnetsKernel.getContactDownloads(contactId, brokerageId)
    return { success: true, data: downloads }
  } catch (error) {
    console.error('Error getting contact downloads:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get contact downloads'
    }
  }
}

export async function markDownloadConvertedAction(
  downloadId: string,
  brokerageId: string
) {
  try {
    await leadMagnetsKernel.markDownloadConverted(downloadId, brokerageId)
    revalidatePath('/agents/lead-magnets')
    return { success: true }
  } catch (error) {
    console.error('Error marking download as converted:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to mark download as converted'
    }
  }
}
