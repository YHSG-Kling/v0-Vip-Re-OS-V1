> **DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE**

# Platform legal agreements — draft packet index

Version: 0.1.0-draft (2026-11-09) · Document ID: VIP-LEGAL-INDEX · Wave 151, lane 151A2

These files are the complete first drafts of the platform's customer-facing legal agreements and the schedules that hang off them. They were written from the code as it stands at commit `b2c93720` (wave 150 closed), so every statement about what the system does, holds, gates or records is a statement about an implementation that exists, cited to the file that implements it. Where the law or the business has not yet decided something, the text carries a marked variable such as `[[GOVERNING_LAW]]` rather than a guess.

None of these documents has been reviewed by counsel. None is approved for publication. Publishing any of them as enforceable customer terms before the owner and qualified legal counsel have signed off is prohibited by the review procedure in `docs/operations/LEGAL-REVIEW-PACKET.md`, and the proof `scripts/legal-packets-guard.ts` (`npm run test:legal-packets`) fails the build if the DRAFT banner is removed from any file in this folder.

## The six packets

| # | File | What it is | Depends on |
|---|---|---|---|
| 1 | `PACKET-1-PLATFORM-SUBSCRIPTION-AND-SERVICES-AGREEMENT.md` | The master subscription and services agreement between the platform entity and a subscribing brokerage, team or solo agent. | Packets 2–6 are schedules to it (order of precedence in Packet 1 §24). |
| 2 | `PACKET-2-AUTONOMOUS-AI-OPERATIONS-AND-AUTHORITY-SCHEDULE.md` | What the AI managers may do unattended, what needs a human, and the code gate that enforces each line. | Packet 1 §7 (responsibilities) and §8 (human approval). |
| 3 | `PACKET-3-ACQUISITION-ENRICHMENT-DATA-RIGHTS-AND-INTEGRATION-SCHEDULE.md` | Lead acquisition and enrichment as an included subscription capability: territories, who owns and pays for each provider, scraping rules, freshness, dedup, suppression, data-subject requests. | Packet 1 §9 (data), Packet 4 (privacy), Packet 6 (tenant-owned providers). |
| 4 | `PACKET-4-PRIVACY-NOTICE-DPA-AND-SUBPROCESSORS.md` | The public privacy notice, the data processing addendum / service-provider terms, the subprocessor list (by name, from the code's own registries), AI processing, retention and deletion, incident handling, export. | Packet 1 §9, §12, §13. |
| 5 | `PACKET-5-ACCEPTABLE-USE-AND-MARKETING-COMPLIANCE.md` | What a subscriber and its users may and may not do with sources, outreach channels, housing advertising, content, listing photos and provider accounts. | Packet 1 §6, §11. |
| 6 | `PACKET-6-TENANT-OWNED-PROVIDER-CONNECTION-SCHEDULE.md` | The reusable schedule a subscriber completes when it connects its own provider account, with per-provider variations only where the provider's terms or the code require one. | Packet 3 §5, Packet 4 §8. |

The owner and attorney delivery packet — cover memorandum, decision table, placeholders, state checklist, risk summary, redline ledger, status, sign-off sheet, publication procedure and the example tenant-facing packet — is `docs/operations/LEGAL-REVIEW-PACKET.md`.

## Conventions used in every packet

- **Banner.** The first line of every file is the DRAFT banner. It stays until the sign-off sheet in the review packet is complete for that document.
- **Variables.** Anything the owner or counsel must decide is written `[[LIKE_THIS]]` and listed in the file's variables table with its status. A price is never written; it is always a `[[PRICE_*]]` variable.
- **Drafting notes.** Text in a blockquote beginning **Drafting note** is for the owner and counsel and is not contract text. It explains why a clause reads the way it does, which code it reflects, or which decision it waits on.
- **Code citations.** `path/to/file.ts::symbolName` names the function, constant or type that enforces or records the thing the clause describes. The proof checks that each cited file exists and that each cited symbol is defined in it.
- **American English** throughout (license, organization, honor, canceled); the proof refuses the British spelling of license anywhere in this folder.
- **No model names.** The AI gateway and the vendors behind it are named as companies and services, never as model identifiers.

## What is deliberately not here

- Consumer-facing marketing consent language for a brokerage's own Contacts. That is a different consent from the subscriber's contract and is recorded by `lib/kernel/compliance/require-contact-consent.ts`; Packet 5 explains the subscriber's obligations around it, but the words a Contact agrees to belong to the brokerage and its counsel.
- Brokerage listing agreements, buyer representation agreements, referral agreements and commission disclosures. Those are the subscriber's instruments with its clients; the platform stores and routes them, it does not author them.
- Pricing. The catalog (`subscription_tiers`, administered through `lib/billing/plan-catalog.ts`) is the only place a price lives.
