// Lead Magnets Kernel Module
// All database operations for lead magnets go through these functions

import { createClient } from '@/utils/supabase/server'
import type {
  KernelLeadMagnet,
  KernelLeadMagnetDownload,
  CreateLeadMagnetParams,
  UpdateLeadMagnetParams,
  TrackDownloadParams,
  LeadMagnetAnalytics,
  LeadMagnetStatus
} from './types'

/**
 * Create a new lead magnet
 */
export async function createLeadMagnet(
  params: CreateLeadMagnetParams
): Promise<KernelLeadMagnet> {
  const supabase = await createClient()
  
  const { data, error } = await supabase
    .from('lead_magnets')
    .insert({
      brokerage_id: params.brokerageId,
      title: params.title,
      description: params.description,
      magnet_type: params.magnetType,
      file_url: params.fileUrl,
      download_format: params.downloadFormat,
      thumbnail_url: params.thumbnailUrl,
      status: 'draft',
      download_count: 0,
      created_by: params.createdBy,
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to create lead magnet: ${error.message}`)
  }

  return data as KernelLeadMagnet
}

/**
 * Get a lead magnet by ID
 */
export async function getLeadMagnet(
  id: string,
  brokerageId: string
): Promise<KernelLeadMagnet | null> {
  const supabase = await createClient()
  
  const { data, error } = await supabase
    .from('lead_magnets')
    .select('*')
    .eq('id', id)
    .eq('brokerage_id', brokerageId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get lead magnet: ${error.message}`)
  }

  return data as KernelLeadMagnet
}

/**
 * List all lead magnets for a brokerage
 */
export async function listLeadMagnets(
  brokerageId: string,
  status?: LeadMagnetStatus
): Promise<KernelLeadMagnet[]> {
  const supabase = await createClient()
  
  let query = supabase
    .from('lead_magnets')
    .select('*')
    .eq('brokerage_id', brokerageId)
    .order('created_at', { ascending: false })

  if (status) {
    query = query.eq('status', status)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to list lead magnets: ${error.message}`)
  }

  return data as KernelLeadMagnet[]
}

/**
 * Update a lead magnet
 */
export async function updateLeadMagnet(
  params: UpdateLeadMagnetParams
): Promise<KernelLeadMagnet> {
  const supabase = await createClient()
  
  const updateData: Partial<KernelLeadMagnet> = {}
  
  if (params.title !== undefined) updateData.title = params.title
  if (params.description !== undefined) updateData.description = params.description
  if (params.magnetType !== undefined) updateData.magnet_type = params.magnetType
  if (params.fileUrl !== undefined) updateData.file_url = params.fileUrl
  if (params.downloadFormat !== undefined) updateData.download_format = params.downloadFormat
  if (params.thumbnailUrl !== undefined) updateData.thumbnail_url = params.thumbnailUrl
  if (params.status !== undefined) updateData.status = params.status

  const { data, error } = await supabase
    .from('lead_magnets')
    .update(updateData)
    .eq('id', params.id)
    .eq('brokerage_id', params.brokerageId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to update lead magnet: ${error.message}`)
  }

  return data as KernelLeadMagnet
}

/**
 * Delete a lead magnet
 */
export async function deleteLeadMagnet(
  id: string,
  brokerageId: string
): Promise<void> {
  const supabase = await createClient()
  
  const { error } = await supabase
    .from('lead_magnets')
    .delete()
    .eq('id', id)
    .eq('brokerage_id', brokerageId)

  if (error) {
    throw new Error(`Failed to delete lead magnet: ${error.message}`)
  }
}

/**
 * Track a download
 */
export async function trackDownload(
  params: TrackDownloadParams
): Promise<KernelLeadMagnetDownload> {
  const supabase = await createClient()
  
  // Insert download record
  const { data: downloadData, error: downloadError } = await supabase
    .from('lead_magnet_downloads')
    .insert({
      lead_magnet_id: params.leadMagnetId,
      contact_id: params.contactId,
      brokerage_id: params.brokerageId,
      source_channel: params.sourceChannel,
      converted_to_lead: false,
    })
    .select()
    .single()

  if (downloadError) {
    throw new Error(`Failed to track download: ${downloadError.message}`)
  }

  // Increment download count
  const { error: updateError } = await supabase.rpc('increment_download_count', {
    magnet_id: params.leadMagnetId
  })

  if (updateError) {
    console.error('Failed to increment download count:', updateError)
  }

  return downloadData as KernelLeadMagnetDownload
}

/**
 * Get analytics for a lead magnet
 */
export async function getLeadMagnetAnalytics(
  id: string,
  brokerageId: string
): Promise<LeadMagnetAnalytics> {
  const supabase = await createClient()
  
  // Get total and unique downloads
  const { data: downloads, error: downloadsError } = await supabase
    .from('lead_magnet_downloads')
    .select('contact_id, downloaded_at, source_channel')
    .eq('lead_magnet_id', id)
    .eq('brokerage_id', brokerageId)

  if (downloadsError) {
    throw new Error(`Failed to get analytics: ${downloadsError.message}`)
  }

  const totalDownloads = downloads?.length || 0
  const uniqueDownloads = new Set(downloads?.map(d => d.contact_id)).size
  
  // Calculate downloads in last 7 and 30 days
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  
  const downloads7Days = downloads?.filter(
    d => new Date(d.downloaded_at) >= sevenDaysAgo
  ).length || 0
  
  const downloads30Days = downloads?.filter(
    d => new Date(d.downloaded_at) >= thirtyDaysAgo
  ).length || 0

  // Count conversions
  const { count: conversions } = await supabase
    .from('lead_magnet_downloads')
    .select('*', { count: 'exact', head: true })
    .eq('lead_magnet_id', id)
    .eq('brokerage_id', brokerageId)
    .eq('converted_to_lead', true)

  const conversionRate = totalDownloads > 0
    ? ((conversions || 0) / totalDownloads) * 100
    : 0

  // Group by source channel
  const sourceMap = new Map<string, number>()
  downloads?.forEach(d => {
    if (d.source_channel) {
      sourceMap.set(d.source_channel, (sourceMap.get(d.source_channel) || 0) + 1)
    }
  })

  const topSources = Array.from(sourceMap.entries())
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  return {
    totalDownloads,
    uniqueDownloads,
    conversionRate,
    downloads7Days,
    downloads30Days,
    topSources,
  }
}

/**
 * Get downloads for a contact
 */
export async function getContactDownloads(
  contactId: string,
  brokerageId: string
): Promise<KernelLeadMagnetDownload[]> {
  const supabase = await createClient()
  
  const { data, error } = await supabase
    .from('lead_magnet_downloads')
    .select('*')
    .eq('contact_id', contactId)
    .eq('brokerage_id', brokerageId)
    .order('downloaded_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to get contact downloads: ${error.message}`)
  }

  return data as KernelLeadMagnetDownload[]
}

/**
 * Mark a download as converted
 */
export async function markDownloadConverted(
  downloadId: string,
  brokerageId: string
): Promise<void> {
  const supabase = await createClient()
  
  const { error } = await supabase
    .from('lead_magnet_downloads')
    .update({
      converted_to_lead: true,
      converted_at: new Date().toISOString(),
    })
    .eq('id', downloadId)
    .eq('brokerage_id', brokerageId)

  if (error) {
    throw new Error(`Failed to mark download as converted: ${error.message}`)
  }
}
