import { redirect } from 'next/navigation'

/**
 * TOMBSTONE (wave 142, lane 142H — UI wiring audit). This route rendered a "Contact Vendor" form whose
 * submit handler was `setTimeout(() => setSent(true), 1000)`: nothing was sent to anyone, and the TC then
 * read "Request Sent — your vendor coordination request has been submitted". It is reached from the
 * coordinator command palette (app/config/navigation-config.ts `contact-vendor`). Its parent
 * /transaction/vendors already redirects to the vendor directory; the SURVIVOR for contacting / booking
 * a vendor is that directory's booking dialog — app/dashboard/vendors/vendor-directory-client.tsx
 * `handleBookVendor` (:795) → the vendor booking workflow — which records a real request. A false
 * success is worse than a redirect, so this page now lands on the real surface.
 */
export default function TransactionVendorContactPage() {
  redirect('/dashboard/vendors')
}
