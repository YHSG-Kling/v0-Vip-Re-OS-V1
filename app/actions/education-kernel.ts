'use server'

import { createClient } from "@/lib/supabase/server"
import {
  createEducationalResource,
  assignResource,
  recordCompletion,
  bulkAssignResources,
  getResourceUsageAnalytics,
} from "@/lib/kernel/education"

export async function createResourceAction(input: {
  title: string
  description: string
  contentType: string
  content: string
  estimatedMinutes: number
  brokerageId: string
}) {
  const supabase = await createClient()
  const { data: user } = await supabase.auth.getUser()

  if (!user) throw new Error("Unauthorized")

  return createEducationalResource(supabase, {
    title: input.title,
    description: input.description,
    contentType: input.contentType as "video" | "article" | "interactive" | "assessment",
    content: input.content,
    estimatedMinutes: input.estimatedMinutes,
    createdBy: user.id,
    brokerageId: input.brokerageId,
  })
}

export async function assignResourceAction(input: {
  contactId: string
  resourceId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  return assignResource(supabase, {
    contactId: input.contactId,
    resourceId: input.resourceId,
    brokerageId: input.brokerageId,
  })
}

export async function recordCompletionAction(input: {
  contactId: string
  resourceId: string
  timeSpentMinutes: number
  retentionScore?: number
  brokerageId: string
}) {
  const supabase = await createClient()
  return recordCompletion(supabase, {
    contactId: input.contactId,
    resourceId: input.resourceId,
    completedAt: new Date().toISOString(),
    timeSpentMinutes: input.timeSpentMinutes,
    retentionScore: input.retentionScore,
    brokerageId: input.brokerageId,
  })
}

export async function bulkAssignAction(input: {
  resourceIds: string[]
  contactIds: string[]
  brokerageId: string
}) {
  const supabase = await createClient()
  return bulkAssignResources(supabase, input)
}

export async function getAnalyticsAction(input: {
  resourceId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  return getResourceUsageAnalytics(supabase, input)
}
