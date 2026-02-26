// ─── MESSAGING (Twilio SMS / Calls / Lookups + SendGrid Email) ────────────────
export type {
  SendSMSParams,
  SendSMSResult,
  PlaceCallParams,
  PlaceCallResult,
  LookupPhoneParams,
  LookupPhoneResult,
  SendEmailParams,
  SendEmailResult,
} from "./messaging"
export { sendSMS, placeCall, lookupPhone, sendEmail } from "./messaging"

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
