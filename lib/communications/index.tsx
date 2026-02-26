// ============================================
// UNIFIED COMMUNICATIONS — LIB LAYER
// All imports come from lib/providers (correct direction).
// Higher-level orchestration (logCall, triggerWorkflow, etc.) is
// inlined here as direct Supabase writes — no app/actions dependency.
// ============================================

import { sendEmail, sendSMS } from '@/lib/providers/messaging'
import { createServiceClient } from '@/lib/supabase/service'

export { sendEmail, sendSMS }

// Simple email for direct use (without contactId requirement)
export async function sendSimpleEmail(params: {
  to: string
  subject: string
  body: string
}) {
  return sendEmail({ to: params.to, subject: params.subject, body: params.body })
}

// Simple SMS for direct use (without contactId requirement)
export async function sendSimpleSMS(params: {
  to: string
  message: string
}) {
  return sendSMS({ to: params.to, body: params.message })
}

// Log a call activity directly to the database
export async function logCall(params: {
  contactId: string
  agentId?: string
  direction: 'inbound' | 'outbound'
  durationSeconds?: number
  notes?: string
}) {
  const supabase = createServiceClient()
  await supabase.from('activities').insert({
    activity_type: 'call',
    contact_id: params.contactId,
    agent_id: params.agentId,
    description: params.notes || `${params.direction} call`,
    metadata: JSON.stringify({ direction: params.direction, durationSeconds: params.durationSeconds }),
    created_at: new Date().toISOString(),
  })
  return { success: true }
}

// Fetch contact communication history
export async function getContactHistory(contactId: string) {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('messages')
    .select('id, type, direction, subject, body, status, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(50)
  return error ? { success: false, error: error.message } : { success: true, messages: data ?? [] }
}

// Append a note to a contact record
export async function addContactNote(params: {
  contactId: string
  note: string
  agentId?: string
}) {
  const supabase = createServiceClient()
  const { data: contact } = await supabase
    .from('contacts')
    .select('notes')
    .eq('id', params.contactId)
    .single()

  const existing = contact?.notes ? `${contact.notes}\n` : ''
  const timestamp = new Date().toISOString().split('T')[0]
  const newNote = `${existing}[${timestamp}] ${params.note}`

  await supabase
    .from('contacts')
    .update({ notes: newNote, updated_at: new Date().toISOString() })
    .eq('id', params.contactId)

  return { success: true }
}

// Trigger a workflow (logs intent to activities table for async pickup)
export async function triggerWorkflow(params: {
  contactId: string
  workflowId: string
  metadata?: Record<string, any>
}) {
  const supabase = createServiceClient()
  await supabase.from('activities').insert({
    activity_type: 'workflow_trigger',
    contact_id: params.contactId,
    description: `Workflow triggered: ${params.workflowId}`,
    metadata: JSON.stringify({ workflowId: params.workflowId, ...params.metadata }),
    created_at: new Date().toISOString(),
  })
  return { success: true }
}

// Create a social post record
export async function createSocialPost(params: {
  agentId: string
  platform: string
  content: string
  scheduledAt?: string
}) {
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('social_posts').insert({
    agent_id: params.agentId,
    platform: params.platform,
    content: params.content,
    scheduled_at: params.scheduledAt,
    status: params.scheduledAt ? 'scheduled' : 'draft',
    created_at: new Date().toISOString(),
  }).select().single()
  return error ? { success: false, error: error.message } : { success: true, post: data }
}

// Schedule a calendar event
export async function scheduleCalendarEvent(params: {
  agentId: string
  contactId?: string
  title: string
  startTime: string
  endTime: string
  description?: string
}) {
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('calendar_events').insert({
    agent_id: params.agentId,
    contact_id: params.contactId,
    title: params.title,
    start_time: params.startTime,
    end_time: params.endTime,
    description: params.description,
    created_at: new Date().toISOString(),
  }).select().single()
  return error ? { success: false, error: error.message } : { success: true, event: data }
}

// Vendor booking confirmation email
export async function sendVendorBookingConfirmation(params: {
  vendorEmail: string
  vendorName: string
  serviceType: string
  propertyAddress: string
  scheduledDate: string
  agentName: string
  agentPhone: string
}) {
  return sendEmail({
    to: params.vendorEmail,
    subject: `Booking Confirmation: ${params.serviceType} at ${params.propertyAddress}`,
    body: `Dear ${params.vendorName},

Your ${params.serviceType} service has been booked:

Property: ${params.propertyAddress}
Date: ${params.scheduledDate}
Agent: ${params.agentName}
Contact: ${params.agentPhone}

Please confirm your availability by replying to this email.

Thank you,
Nexus Platform`.trim(),
  })
}
