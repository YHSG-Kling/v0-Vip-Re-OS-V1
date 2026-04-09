// Lead Magnets Kernel Types
// Domain types for lead magnet functionality

// Kernel Response Pattern
export type KernelResponse<T> = {
  data: T | null
  error: string | null
}

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

// Database row (snake_case)
export interface DbLeadMagnet {
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

// Kernel returns (camelCase)
export interface KernelLeadMagnet {
  id: string
  brokerageId: string
  title: string
  description?: string
  magnetType: LeadMagnetType
  fileUrl?: string
  downloadFormat?: DownloadFormat
  thumbnailUrl?: string
  status: LeadMagnetStatus
  downloadCount: number
  conversionRate?: number
  createdBy?: string
  createdAt: string
  updatedAt: string
}

// Database row (snake_case)
export interface DbLeadMagnetDownload {
  id: string
  lead_magnet_id: string
  contact_id: string
  brokerage_id: string
  downloaded_at: string
  source_channel?: string
  converted_to_lead: boolean
  converted_at?: string
}

// Kernel returns (camelCase)
export interface KernelLeadMagnetDownload {
  id: string
  leadMagnetId: string
  contactId: string
  brokerageId: string
  downloadedAt: string
  sourceChannel?: string
  convertedToLead: boolean
  convertedAt?: string
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
