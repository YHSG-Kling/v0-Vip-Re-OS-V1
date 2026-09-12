import { redirect } from "next/navigation"

// TOMBSTONE (§1/§6) — `/crm/contacts` was a SECOND ADDRESS for one surface.
// SURVIVOR: app/crm/page.tsx — the CRM workspace titled "My Contacts",
// registered in the command palette (app/components/command-palette.tsx:29 as
// `{ label: "My Contacts (CRM)", href: "/crm" }`) and role-gated at
// lib/kernel/helpers.ts:83. It is the survivor on every test: it is the one
// with a page, a nav entry and a gate.
//
// THE DEFECT. This directory held only `[contactId]/` and `new/`, so the path
// itself rendered a 404 — while FOURTEEN in-tree sites addressed it, two of
// them reachable only when something had already gone wrong:
//   · app/crm/contacts/[contactId]/error.tsx — the error boundary's RECOVERY
//     button, so a contact page that threw sent the agent to a second failure
//   · app/crm/contacts/[contactId]/listings/new/page.tsx — the redirect for a
//     contact that could not be resolved
// plus the create-form's cancel/back controls, the CSV-import success CTA,
// three team-page entries, the first-deal checklist, and six
// revalidatePath("/crm/contacts") calls that revalidated nothing — themselves
// evidence the authors believed a page was here.
//
// ALL FOURTEEN NOW ADDRESS `/crm` DIRECTLY, so the tree carries ONE spelling.
// This file stays as a redirect ONLY for addresses already outside the tree —
// bookmarks, links in sent email, and anything a browser autocompleted while
// the 404 was live. It is deliberately not a second list: two surfaces
// answering one question drift (the tabs and search state on /crm would have
// no twin here), which is the §6 defect this file exists to close rather than
// re-open.
//
// WHY NO GUARD CAUGHT IT: test:orphan-routes asks which ROUTES nothing links
// to and correctly reported 0; the opposite question — which LINKS point at no
// route — was asked for /api/** only (opposite-missing category 6a), never for
// page routes. scripts/dangling-link-sweep.ts now asks it (npm run
// test:dangling-links), with the positive control and the published
// denominator §2 requires.
export default function ContactsIndexRedirect() {
  redirect("/crm")
}
