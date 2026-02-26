// ─── MESSAGING (Twilio SMS / SendGrid Email) ──────────────────────────────────
export type { SendSMSParams, SendSMSResult, SendEmailParams, SendEmailResult } from "./messaging"
export { sendSMS, sendEmail } from "./messaging"

// ─── ESIGN (Dotloop) ──────────────────────────────────────────────────────────
export { DotloopProvider } from "./esign"
export type {
  CreateLoopParams,
  CreateLoopResult,
  AddParticipantParams,
  GetLoopStatusResult,
  LoopFolder,
  SyncLoopDocumentsResult,
  UploadLoopDocumentParams,
  UploadLoopDocumentResult,
  GetLoopActivityResult,
} from "./esign"
export { createLoop, addParticipant, getLoopSignatureStatus, syncLoopDocuments, uploadLoopDocument, getLoopActivity } from "./esign"

// ─── PAYMENT (Stripe) ─────────────────────────────────────────────────────────
export type {
  CreateTransferParams,
  CreateTransferResult,
  CreatePaymentIntentParams,
  CreatePaymentIntentResult,
  CreateConnectedAccountResult,
} from "./payment"
export { createTransfer, createPaymentIntent, createConnectedAccount } from "./payment"

// ─── CALENDAR (Nylas) ─────────────────────────────────────────────────────────
export type {
  CalendarEvent,
  CreateEventResult,
  GetAvailabilityParams,
  AvailabilitySlot,
  GetAvailabilityResult,
  UpdateEventResult,
  DeleteEventResult,
} from "./calendar"
export { createCalendarEvent, getAvailability, updateCalendarEvent, deleteCalendarEvent } from "./calendar"
