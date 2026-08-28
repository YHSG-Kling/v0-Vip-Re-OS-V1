import { redirect } from "next/navigation"

// /crm/contacts — THE LIST LIVES AT /crm, AND NINE PLACES SAID OTHERWISE.
//
// There has never been a page at this path: app/crm/contacts/ holds only
// [contactId]/ and new/. Nine call sites address it anyway — including two the
// user only ever reaches while something is already wrong:
//
//   · app/crm/contacts/[contactId]/error.tsx:51 — the error boundary's RECOVERY
//     button. A contact page that throws offered "back to contacts" and landed
//     the agent on a 404, so the recovery from one failure was a second one.
//   · app/crm/contacts/[contactId]/listings/new/page.tsx:45 — the redirect for a
//     contact that cannot be loaded.
//   · app/crm/contacts/new/page.tsx:137,270 (cancel / after-save), the CSV
//     import success screen (app/dashboard/admin/import/page.tsx:340), three
//     team-page links, and the first-deal checklist.
//
// Every one of them means "take me to the contacts list", and that list is
// /crm — titled "My Contacts", registered in the command palette
// (app/components/command-palette.tsx:29) and role-gated at
// lib/kernel/helpers.ts:83. So this is the redirect, not a second list: a
// duplicate page here would be two surfaces answering one question, and the
// tabs/search state on /crm would drift from whatever this one grew (§6).
//
// WHY THE GUARDS DID NOT CATCH IT: test:orphan-routes asks the opposite
// question — which route files nothing links to — and correctly reports 0. No
// guard asks which internal links point at no route at all. Found by lane H2
// while wiring the contact routes; recorded here rather than only in a report.
export default function ContactsIndexRedirect() {
  redirect("/crm")
}
