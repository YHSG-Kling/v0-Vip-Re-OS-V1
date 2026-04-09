// Lead Magnets Kernel Module
// All database operations for lead magnets - returns KernelResponse pattern

import { createClient } from '@/lib/supabase/server'
import type {
  KernelResponse,
  KernelLeadMagnet,
  DbLeadMagnet,
  KernelLeadMagnetDownload,
  DbLeadMagnetDownload,
  CreateLeadMagnetParams,
  UpdateLeadMagnetParams,
  TrackDownloadParams,
  LeadMagnetAnalytics,
  LeadMagnetStatus
} from './types'

// ══════════════════════════════════════════════════════════════════════════════
// Mapping Helpers (snake_case ↔ camelCase at kernel boundary)
// ══════════════════════════════════════════════════════════════════════════════

function mapDbToKernel(db: DbLeadMagnet): KernelLeadMagnet {
  return {
    id: db.id,
    brokerageId: db.brokerage_id,
    title: db.title,
    description: db.description,
    magnetType: db.magnet_type,
    fileUrl: db.file_url,
    downloadFormat: db.download_format,
    thumbnailUrl: db.thumbnail_url,
    status: db.status,
    downloadCount: db.download_count,
    conversionRate: db.conversion_rate,
    createdBy: db.created_by,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  }
}

function mapDbDownloadToKernel(db: DbLeadMagnetDownload): KernelLeadMagnetDownload {
  return {
    id: db.id,
    leadMagnetId: db.lead_magnet_id,
    contactId: db.contact_id,
    brokerageId: db.brokerage_id,
    downloadedAt: db.downloaded_at,
    sourceChannel: db.source_channel,
    convertedToLead: db.converted_to_lead,
    convertedAt: db.converted_at,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Kernel Functions (all return KernelResponse<T>)
// ══════════════════════════════════════════════════════════════════════════════

export async function createLeadMagnet(
  params: CreateLeadMagnetParams
): Promise<KernelResponse<KernelLeadMagnet>> {
  try {
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
      return { data: null, error: `Failed to create lead magnet: ${error.message}` }
    }

    return { data: mapDbToKernel(data as DbLeadMagnet), error: null }
  } catch (e: any) {
    return { data: null, error: e.message }
  }
}

export async function getLeadMagnet(
  id: string,
  brokerageId: string
): Promise<KernelResponse<KernelLeadMagnet>> {
  try {
    const supabase = await createClient()
    
    const { data, error } = await supabase
      .from('lead_magnets')
      .select('*')
      .eq('id', id)
      .eq('brokerage_id', brokerageId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return { data: null, error: 'Lead magnet not found' }
      }
      return { data: null, error: `Failed to get lead magnet: ${error.message}` }
    }

    return { data: mapDbToKernel(data as DbLeadMagnet), error: null }
  } catch (e: any) {
    return { data: null, error: e.message }
  }
}

export async function listLeadMagnets(
  brokerageId: string,
  status?: LeadMagnetStatus
): Promise<KernelResponse<KernelLeadMagnet[]>> {
  try {
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
      return { data: null, error: `Failed to list lead magnets: ${error.message}` }
    }

    return { data: (data as DbLeadMagnet[]).map(mapDbToKernel), error: null }
  } catch (e: any) {
    return { data: null, error: e.message }
  }
}

export async function updateLeadMagnet(
  params: UpdateLeadMagnetParams
): Promise<KernelResponse<KernelLeadMagnet>> {
  try {
    const supabase = await createClient()
    
    const updateData: Partial<DbLeadMagnet> = {}
    
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
      return { data: null, error: `Failed to update lead magnet: ${error.message}` }
    }

    return { data: mapDbToKernel(data as DbLeadMagnet), error: null }
  } catch (e: any) {
    return { data: null, error: e.message }
  }
}

export async function deleteLeadMagnet(
  id: string,
  brokerageId: string
): Promise<KernelResponse<boolean>> {
  try {
    const supabase = await createClient()
    
    const { error } = await supabase
      .from('lead_magnets')
      .delete()
      .eq('id', id)
      .eq('brokerage_id', brokerageId)

    if (error) {
      return { data: null, error: `Failed to delete lead magnet: ${error.message}` }
    }

    return { data: true, error: null }
  } catch (e: any) {
    return { data: null, error: e.message }
  }
}

export async function trackDownload(
  params: TrackDownloadParams
): Promise<KernelResponse<KernelLeadMagnetDownload>> {
  try {
    const supabase = await createClient()
    
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
      return { data: null, error: `Failed to track download: ${downloadError.message}` }
    }

    // Increment download count (non-blocking)
    supabase.rpc('increment_download_count', {
      magnet_id: params.leadMagnetId
    }).then(() => {}).catch(() => {})

    return { data: mapDbDownloadToKernel(downloadData as DbLeadMagnetDownload), error: null }
  } catch (e: any) {
    return { data: null, error: e.message }
  }
}

export async function getLeadMagnetAnalytics(
  id: string,
  brokerageId: string
): Promise<KernelResponse<LeadMagnetAnalytics>> {
  try {
    const supabase = await createClient()
    
    const { data: downloads, error: downloadsError } = await supabase
      .from('lead_magnet_downloads')
      .select('contact_id, downloaded_at, source_channel, converted_to_lead')
      .eq('lead_magnet_id', id)
      .eq('brokerage_id', brokerageId)

    if (downloadsError) {
      return { data: null, error: `Failed to get analytics: ${downloadsError.message}` }
    }

    const totalDownloads = downloads?.length || 0
    const uniqueDownloads = new Set(downloads?.map(d => d.contact_id)).size
    
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    
    const downloads7Days = downloads?.filter(
      d => new Date(d.downloaded_at) >= sevenDaysAgo
    ).length || 0
    
    const downloads30Days = downloads?.filter(
      d => new Date(d.downloaded_at) >= thirtyDaysAgo
    ).length || 0

    const conversions = downloads?.filter(d => d.converted_to_lead).length || 0
    const conversionRate = totalDownloads > 0 ? (conversions / totalDownloads) * 100 : 0

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
      data: {
        totalDownloads,
        uniqueDownloads,
        conversionRate,
        downloads7Days,
        downloads30Days,
        topSources,
      },
      error: null
    }
  } catch (e: any) {
    return { data: null, error: e.message }
  }
}

export async function markDownloadConverted(
  downloadId: string,
  brokerageId: string
): Promise<KernelResponse<boolean>> {
  try {
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
      return { data: null, error: `Failed to mark download as converted: ${error.message}` }
    }

    return { data: true, error: null }
  } catch (e: any) {
    return { data: null, error: e.message }
  }
}
