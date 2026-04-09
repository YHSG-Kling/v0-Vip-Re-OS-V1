// Lead Magnets Kernel Types
// Domain types for lead magnet functionality

export type LeadMagnetType =
  | "ebook"
  | "guide"
  | "checklist"
  | "calculator"
  | "video"
  | "webinar"
  | "template"
  | "report"
  | "other"

export type LeadMagnetStatus =
  | "draft"
  | "active"
  | "paused"
  | "archived"

export type DownloadFormat =
  | "pdf"
  | "docx"
  | "xlsx"
  | "video"
  | "link"

export interface KernelLeadMagnet {
  id: string
  brokerage_id: string
  title: string
  description?: string
  magnet_type: LeadMagnetType
  file_url?: string
  download_format?: DownloadFormat
  thumbnail_url?: string
  status: LeadMagnetStatus
  download_count: number
  conversion_rate?: number
  created_by?: string
  created_at: string
  updated_at: string
}

export interface KernelLeadMagnetDownload {
  id: string
  lead_magnet_id: string
  contact_id: string
  brokerage_id: string
  downloaded_at: string
  source_channel?: string
  converted_to_lead: boolean
  converted_at?: string
}

export interface CreateLeadMagnetParams {
  brokerageId: string
  title: string
  description?: string
  magnetType: LeadMagnetType
  fileUrl?: string
  downloadFormat?: DownloadFormat
  thumbnailUrl?: string
  createdBy?: string
}

export interface UpdateLeadMagnetParams {
  id: string
  brokerageId: string
  title?: string
  description?: string
  magnetType?: LeadMagnetType
  fileUrl?: string
  downloadFormat?: DownloadFormat
  thumbnailUrl?: string
  status?: LeadMagnetStatus
}

export interface TrackDownloadParams {
  leadMagnetId: string
  contactId: string
  brokerageId: string
  sourceChannel?: string
}

export interface LeadMagnetAnalytics {
  totalDownloads: number
  uniqueDownloads: number
  conversionRate: number
  downloads7Days: number
  downloads30Days: number
  topSources: Array<{
    channel: string
    count: number
  }>
}
