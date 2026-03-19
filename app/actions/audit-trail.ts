"use server"

import { createServiceClient } from "@/lib/supabase/service"

export interface AuditEntry {
  id: string
  user_id: string | null
  brokerage_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  old_value: any
  new_value: any
  ip_address: string | null
  user_agent: string | null
  created_at: string
  user?: {
    full_name: string | null
    email: string
  }
  brokerage?: {
    name: string
  }
}

export async function getAuditTrail(params?: {
  brokerageId?: string
  userId?: string
  entityType?: string
  action?: string
  limit?: number
  offset?: number
}): Promise<{ entries: AuditEntry[]; total: number; error?: string }> {
  const service = createServiceClient()
  
  let query = service
    .from("audit_log")
    .select(`
      *,
      user:users(full_name, email),
      brokerage:brokerages(name)
    `, { count: "exact" })
    .order("created_at", { ascending: false })
  
  if (params?.brokerageId) {
    query = query.eq("brokerage_id", params.brokerageId)
  }
  
  if (params?.userId) {
    query = query.eq("user_id", params.userId)
  }
  
  if (params?.entityType) {
    query = query.eq("entity_type", params.entityType)
  }
  
  if (params?.action) {
    query = query.eq("action", params.action)
  }
  
  const limit = params?.limit ?? 50
  const offset = params?.offset ?? 0
  
  query = query.range(offset, offset + limit - 1)
  
  const { data, error, count } = await query
  
  if (error) {
    return { entries: [], total: 0, error: error.message }
  }
  
  return { entries: (data ?? []) as AuditEntry[], total: count ?? 0 }
}

export async function logAuditEntry(params: {
  userId?: string
  brokerageId?: string
  action: string
  entityType: string
  entityId?: string
  oldValue?: any
  newValue?: any
  ipAddress?: string
  userAgent?: string
}): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  
  const { error } = await service.from("audit_log").insert({
    user_id: params.userId ?? null,
    brokerage_id: params.brokerageId ?? null,
    action: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId ?? null,
    old_value: params.oldValue ?? null,
    new_value: params.newValue ?? null,
    ip_address: params.ipAddress ?? null,
    user_agent: params.userAgent ?? null,
  })
  
  if (error) {
    return { success: false, error: error.message }
  }
  
  return { success: true }
}

export async function getAuditEntityTypes(): Promise<string[]> {
  const service = createServiceClient()
  
  const { data } = await service
    .from("audit_log")
    .select("entity_type")
    .limit(100)
  
  if (!data) return []
  
  const types = [...new Set(data.map(d => d.entity_type))]
  return types.filter(Boolean).sort()
}

export async function getAuditActions(): Promise<string[]> {
  const service = createServiceClient()
  
  const { data } = await service
    .from("audit_log")
    .select("action")
    .limit(100)
  
  if (!data) return []
  
  const actions = [...new Set(data.map(d => d.action))]
  return actions.filter(Boolean).sort()
}
