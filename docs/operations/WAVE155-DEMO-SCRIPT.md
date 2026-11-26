# Wave 155 — the owner's scripted demo, per tenant shape (lane 155L, 2026-11-20)

**What this is.** The clicks for a controlled demonstration of the four existing tenant shapes (solo agent, team, brokerage,
multi-location brokerage), the seller / buyer journey, the content system and OS arbitration (directive §L2). Every route named
below exists in the repository, and `test:wave155-e2e-canaries` re-checks each one on every run (see "How this page is checked").

**Two kinds of step, never mixed up.**
- **SIMULATED** — the behavior is already proven in-repo on in-memory data with counted seams (the canary step named in brackets,
  from `scripts/wave155-e2e-canaries.ts` S1–S6 or the lane guard it cites). It proves the rule, not a live screen.
- **LIVE (owner)** — you click it on a preview deployment, signed in. It needs the P0 items of
  `docs/operations/WAVE155-P0-OWNER-ACTION-PACKET.md` first: P0-4 (a deployment) for every screen below, P0-1 / P0-2 / P0-3 / P0-5
  where marked. A LIVE step you complete is evidence for the packet's LIVE-PROBES line; nothing on this page is LIVE-VERIFIED yet.

**Never during a demo:** a real outreach message, a real mailing, a charge, an ad launch or a paid data pull. Use the seed tenant
and your own address as the recipient. Every outside send is refused until you set the email provider key — that refusal is the
correct screen, not a failure.

## 1. Solo agent

| # | Click (route) | Expected screen | Kind |
|---|---|---|---|
| 1 | `/signup` → `/onboarding` | the solo creation path: one tenant of your own, a trialing subscription | LIVE (owner) · [S1 registers] |
| 2 | `/legal` | the agreement the subscriber accepts (draft until P0-6) | LIVE (owner) · needs P0-6 before live billing |
| 3 | `/site/[slug]` | the solo storefront provisioned by its slug, no custom domain needed | LIVE (owner) · [S1 website] |
| 4 | `/dashboard/agent/qr-codes` | the agent's tracked codes; each image encodes `/api/qr/scan?slug=…`, never the raw page | LIVE (owner) · [S1 QR] |
| 5 | `/newsletters` | a draft whose sections are only verified facts (market, event, own active listing, community, one next action); missing facts are omitted, not invented | LIVE (owner) · [S1 newsletter] |
| 6 | `/portal/[contactId]/assistant` as the seed contact | a general question answered from the article; a lender question gets "what is on file" and one agent task | LIVE (owner) · needs P0-3 · [S1 portal] |
| 7 | `/leads` | no paid sample arrives: the Datafiniti door reads LICENSE-HELD (zero charged calls) | SIMULATED [S1 gated sample] · LIVE only after P0-7 |
| 8 | `/academy` → `/academy/module/[id]` | completion only after the quiz is passed at the course's bar (80 by default); reading alone never completes | LIVE (owner) · [S1 course] |
| 9 | `/dashboard/financials/commissions`, `/dashboard/agent/roi` | the agent's own commission amounts; never another agent's payout or the business's net | LIVE (owner) · [S1 commission] |

## 2. Team with a leader and a TC

| # | Click (route) | Expected screen | Kind |
|---|---|---|---|
| 1 | `/dashboard/team`, `/dashboard/settings/teams`, `/dashboard/settings/team/tc` | the team anchored on its lead; the TC assigned | LIVE (owner) |
| 2 | `/dashboard/content/approvals` as the TC | the assigned contact's piece is offered for approval; another team's piece is not | LIVE (owner) · [S2 TC / delegate] |
| 3 | the same page as a peer agent of another team | the approval is refused and says who decides | LIVE (owner) · [S2 peer refused] |
| 4 | `/dashboard/marketing/content-intel/topics` → `/dashboard/marketing/video-staging` | a topic → an approved master → a staged reel, variants only where the platform permission exists | LIVE (owner) · [S2 variants] |
| 5 | `/dashboard/campaigns/roi` | the variant's outcome on its delivering channel; unmeasured stays "Not measured" | LIVE (owner) · [S2 outcome] |
| 6 | `/dashboard/transactions/[id]` (buyer agreement executed after the lead's held consult) | the signed-agreement appointment milestone once; a booking alone earns nothing | SIMULATED [S2 JOIN buyer agreement] · LIVE (owner) |

## 3. Brokerage and multi-location brokerage

| # | Click (route) | Expected screen | Kind |
|---|---|---|---|
| 1 | `/dashboard/settings/offices`, `/dashboard/admin/locations` | two offices, each head leading only their own | LIVE (owner) · [S3 offices] |
| 2 | `/dashboard/financials/expenses` as an office admin | own office's expenses only; no consolidated view | LIVE (owner) · [S3 office expenses] |
| 3 | `/dashboard/financials/brokerage` as the owner | the consolidated parent rollup across offices | LIVE (owner) · [S3 rollup] |
| 4 | `/dashboard/admin/marketing-approvals` as the delegated office | the brokerage-voice piece prepared with the brokerage's brand and return address | LIVE (owner) · [S3 office marketing] |
| 5 | the same page as office 2 | office 1's asset and queue entry are absent; publishing in the brokerage's name is refused | LIVE (owner) · [S3 PRIV-002] |
| 6 | `/api/documents/open?ref=…` for office 1's deal file, signed in as office 2's agent | "This document isn't available." | LIVE (owner) · needs P0-1 · [S3 documents] |
| 7 | `/dashboard/marketing/content-intel` (office circle share) | seen by the producer's own office only; the adopter result shows "unknown" until enough measured adopters | SIMULATED [S3 JOIN calibration] · LIVE (owner) |

## 4. Seller / buyer journey

| # | Click (route) | Expected screen | Kind |
|---|---|---|---|
| 1 | `/dashboard/listings/[id]` | the verified listing; an outside listing of the same address on its own label | LIVE (owner) · [S4 outside listing] |
| 2 | `/portal/[contactId]/journey` as the buyer | saved / shared homes, each saying where it came from | LIVE (owner) · needs P0-3 · [S4 shared homes] |
| 3 | `/dashboard/listings/[id]/offers` → `/dashboard/transactions/[id]` | addendum proposed through the one recorder; the outside-listing signing path | LIVE (owner) · [S4 addendum] |
| 4 | `/dashboard/transactions/[id]/milestones` | the lender's revised CD recorded by the lender's seat; an agent-reported receipt shown as pending, never governing | LIVE (owner) · [S4 vendor correction / CD receipt] |
| 5 | `/dashboard/transactions/[id]/cda` (brokerage with CDA on) | compliance approves the signed-off CDA; an executed credit-changing addendum re-opens it | LIVE (owner) · [S4 CDA on] |
| 6 | the same deal on a tenant with CDA off | no CDA step invented; the payout preference flow instead | SIMULATED [S4 CDA off] · LIVE (owner) |
| 7 | `/dashboard/financials/commissions` as the broker | the deterministic payout waterfall; the agent cannot mark their own commission paid; no double payout | LIVE (owner) · [S4 payout] — no money moves in a demo |

## 5. Content system

| # | Click (route) | Expected screen | Kind |
|---|---|---|---|
| 1 | three different people ask the same general question (two at `/portal/[contactId]/assistant`, one on `/site/[slug]`) | after the third distinct asker, ONE de-identified topic appears at `/dashboard/marketing/content-intel/topics` | SIMULATED [S5 FAQ cluster → topic] · LIVE (owner) |
| 2 | `/dashboard/marketing/video-staging` | the same asker count chooses an educational video (an artifact, delivered on a channel) | SIMULATED [S5 JOIN education artifact] |
| 3 | `/newsletters` | the same FAQ topic is selected as a newsletter section, with the topic as its provenance; another brokerage's topic is not (closed at merge — it was the code gap GAP-FAQ-NEWSLETTER) | SIMULATED [S5 JOIN topic → newsletter section] |
| 4 | `/dashboard/agent/qr-codes` | the video end card and the flyer each have their own tracked code on the same campaign | SIMULATED [S5 JOIN QR] · LIVE (owner) |
| 5 | scan the printed flyer code with a phone (`/api/qr/scan`) | redirect to the real page; the scan is counted with no identity | LIVE (owner) · after P0-4 |
| 6 | `/dashboard/content/approvals` → edit the approved piece | approval re-opens after a substantive edit | LIVE (owner) · [S5 approval] |
| 7 | `/dashboard/campaigns/roi`, `/dashboard/agent/roi` | follow-on and ROI: "Not measured" where nothing was measured | LIVE (owner) · [S5 ROI] |
| 8 | negatives: an expired topic; an event that changes after the draft | the expired topic is refused at intake; the changed event holds the issue before any send | SIMULATED [S5 NEGATIVE expired / changed] |

## 6. OS arbitration — one action per plane

| # | Plane · click (route) | Expected screen | Kind |
|---|---|---|---|
| 1 | platform · `/dashboard/superadmin/brokerages/[id]` (suspend the seed tenant) | its source pulls refused; platform support still reaches the account | SIMULATED [S6 platform] |
| 2 | tenant · a connection read naming another tenant | refused at the rights stage, zero provider calls | SIMULATED [S6 tenant] |
| 3 | agent · a commission term change proposed by the model | held; a person decides; one decision row | SIMULATED [S6 agent] |
| 4 | Lead · a paid pull above the approval | zero paid calls; held with its reason | SIMULATED [S6 Lead] |
| 5 | Contact · an SMS with no consent | refused at the send sink, one refusal row | SIMULATED [S6 Contact] |
| 6 | deal · `/dashboard/transactions/[id]/cda` approval | the session decides, the tenant is pinned | SIMULATED [S6 deal] · LIVE (owner) |
| 7 | finance · a payout proposed by the model | zero seams; the verified human path runs once | SIMULATED [S6 finance] |
| 8 | support · impersonation in read-only mode | writes refused; a full grant walks the account and never exceeds it | SIMULATED [S6 support] |
| 9 | reader · `/dashboard/admin/ai-audit`, `/dashboard/admin/manager-trust`, `/dashboard/admin/command-center` | the decision rows with who, why, which policy and what happened | LIVE (owner) |

## How this page is checked

`npm run test:wave155-e2e-canaries` checks that every backticked route on this page resolves to a page or route file under `app/`
(route groups ignored) and that every bracketed step tag names a scenario it runs. Health and smoke after P0-4: `/api/health`,
`/api/admin/health-status`, `/api/cron/dispatch` (cron-authenticated only).
