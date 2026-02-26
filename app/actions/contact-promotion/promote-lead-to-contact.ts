"use server"

/**
 * CANONICAL LIFECYCLE AUTHORITY — Server Action entry point.
 * Core logic lives in lib/contact-promotion/promote-lead-to-contact.ts.
 * This file exists only to attach the "use server" directive for Next.js.
 */

export {
  promoteLeadToContactService as promoteLeadToContact,
  type PromotionResult,
} from "@/lib/contact-promotion/promote-lead-to-contact"
