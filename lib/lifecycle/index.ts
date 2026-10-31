// ─── OFFER LIFECYCLE ──────────────────────────────────────────────────────────
// promoteLeadToContact / PromoteLeadToContactParams are no longer re-exported:
// the promotion half of offer-lifecycle.ts is deleted (§1.3 — see the tombstone
// there; survivor lib/contact-promotion/promote-lead-to-contact.ts:28
// promoteLeadToContactService). Nothing imports this barrel — it survives only
// as the offer-draft half's index — so the re-export was the one dangling
// reference the full tsc caught after the deletion.
export {
  createOfferDraft,
  createInitialOfferVersion,
} from './offer-lifecycle'
export type {
  CreateOfferDraftParams,
} from './offer-lifecycle'
