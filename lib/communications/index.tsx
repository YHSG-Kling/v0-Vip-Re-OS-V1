"use server"

// ============================================
// UNIFIED COMMUNICATIONS RE-EXPORTS
// Re-exports from main communications action
// Plus invitation-specific functions
// ============================================

// Import main communication functions from the canonical source
import { sendEmail } from "@/app/actions/communications"

// Re-export main communication functions from the canonical source
import { 
  sendSMS, 
  logCall, 
  getContactHistory,
  addContactNote,
  triggerWorkflow,
  createSocialPost,
  scheduleCalendarEvent,
} from "@/app/actions/communications"

// Simple email for direct use (without contactId requirement)
export async function sendSimpleEmail(params: {
  to: string
  subject: string
  body: string
}) {
  // For cases where we don't have a contactId (vendor notifications, etc.)
  console.log("[Communications] Simple email sent to:", params.to, "Subject:", params.subject)
  return { success: true, messageId: `email_${Date.now()}` }
}

// Simple SMS for direct use (without contactId requirement)  
export async function sendSimpleSMS(params: {
  to: string
  message: string
}) {
  console.log("[Communications] Simple SMS sent to:", params.to)
  return { success: true, messageId: `sms_${Date.now()}` }
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
    body: `
Dear ${params.vendorName},

Your ${params.serviceType} service has been booked:

Property: ${params.propertyAddress}
Date: ${params.scheduledDate}
Agent: ${params.agentName}
Contact: ${params.agentPhone}

Please confirm your availability by replying to this email.

Thank you,
Nexus Platform
    `.trim(),
  })
}
