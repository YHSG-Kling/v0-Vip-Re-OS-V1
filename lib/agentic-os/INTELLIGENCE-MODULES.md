# Intelligence modules — run mode reference

Quick map of the 8 intelligence modules to their trigger: **AUTO** (cron / event) vs **MANUAL**
(quick-action button in the UI). Every module is **gateway-routed** (single egress, never-throws,
healer-observable) and **tenant-aware** (uses the canonical scoping rules:
`raw_leads` = platform-only · `leads` = platform OR brokerage · `contacts` = agent / team /
brokerage / platform).

| # | Module | Run mode | Trigger / location |
|---|---|---|---|
| 1 | `lib/lead-pipeline/contact-signal-rescrape.ts` | **AUTO** | Called by lifecycle event-reactor when a contact signal fires (`tcpa_consent_granted`, `deal_under_contract`, `inspection_completed`, `address_changed`, `email_changed`, `phone_changed`) |
| 2 | `lib/agentic-os/deal-investigator.ts` | **MANUAL** | "Run investigation" button in `ContactQuickActions.tsx` → `runDealInvestigatorAction` |
| 3 | `lib/external/socrata-client.ts` + `socrata-market-registry.ts` | **AUTO** | Daily cron sweep iterates `getMarketDatasets({state, city})` per active brokerage market; LOCAL data per market — Austin uses `data.austintexas.gov`, Dallas uses `data.dallasopendata.com`, etc. NATIONAL coverage, not NYC-only |
| 4 | `lib/external/vision-property.ts` | **MANUAL** (per-image) **+ AUTO** (per scrape batch with photos) | Agent click on a listing image, OR the daily scrape cron when `raw_data` includes photo URLs |
| 5 | `lib/lead-pipeline/relisting-detector.ts` | **AUTO** | Daily scraping cron tail — emits `listing_relisted` kernel event, reactor handles fan-out |
| 6 | `lib/analytics/intent-phrase-rollup.ts` | **MANUAL** (dashboard) **+ AUTO** (weekly cron suggested) | Dashboard widget query; queries can also feed the next scrape's query bank |
| 7 | `lib/external/email-verifier.ts` | **MANUAL** ("Quick" / "Deep" buttons) **+ AUTO** (via `contact-signal-rescrape` on `email_changed`) | `verifyContactEmailAction` server action |
| 8 | `lib/external/lob-address-verify.ts` | **MANUAL** ("Verify" button) **+ AUTO** (via `contact-signal-rescrape` on `address_changed`) | `verifyContactAddressAction` server action |

## UI surface

Drop `<ContactQuickActions />` on any contact detail page:

```tsx
import { ContactQuickActions } from "@/components/contact/ContactQuickActions"

<ContactQuickActions
  contactId={contact.id}
  hasEmail={!!contact.email}
  hasAddress={!!contact.mailing_address}
  emailVerified={contact.email_verified}
  addressVerified={contact.mailing_address_verified}
/>
```

Three buttons: **Run investigation** (#2), **Verify email** Quick (Tier 1+2, free) / Deep (Tier 3, PDL ~$0.01), **Verify address** (Lob). Each shows result inline with cost. Server actions enforce contact-ownership authorization — agent must own the contact, OR be brokerage staff in the contact's brokerage, OR platform admin — so a non-authorized click returns a structured `Forbidden` (no row leak).

## National coverage (Socrata #3)

The application is for ALL US markets. The per-market registry (`lib/external/socrata-market-registry.ts`) covers Austin, Dallas, Chicago, Los Angeles, San Francisco, New York, Phoenix, Atlanta, Miami, Seattle, Denver out of the box and is trivially extensible (add a new `[k("STATE","City")]:` entry with the local Socrata host + dataset 4x4). Calls fall through to a "configure your local open-data portal" path when the market isn't registered yet, so adding a new metro is a single-line PR — not a code change.
