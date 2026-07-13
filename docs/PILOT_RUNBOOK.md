# Pilot Brokerage Runbook — signup to earned autonomy in two weeks

One page. Every step below is a settings screen or a click on a rail that already
runs — no code. The arc IS the sales demo: by day 14 the pilot's broker has
granted the AI team its first standing autonomy from their own approval history.

## Phase 0 — Platform (you, once per environment)

All providers are PLATFORM setup — tenants never see them.

1. Deploy to production with env: `NEXT_PUBLIC_APP_URL` (https), `CRON_SECRET`,
   Twilio master creds + `TWILIO_PHONE_NUMBER`, `SENDGRID_API_KEY`,
   `STRIPE_SECRET_KEY` (live) + `STRIPE_WEBHOOK_SECRET`, one model key,
   `ELEVENLABS_API_KEY`, `DID_API_KEY`, `BATCHDATA_MCP_URL` (funded),
   RentCast + scraper (Apify/ZenRows) keys, `GEOAPIFY_API_KEY` (nearby-life
   POI data — OpenStreetMap via Geoapify; unset = the portal simply skips
   local-lifestyle suggestions, never invents them).
2. Open **/dashboard/superadmin → Go-Live Readiness** — every required domain
   green (the board probes the real vendors, including the records provider;
   out-of-balance reads broken, never silently ready).
3. Publish pricing to Stripe (the one-click publish tool), bind the platform
   reception number ("Bind platform number"), run "Verify A2P pipeline (mock)".

## Phase 1 — Signup + hour one (the pilot, guided)

4. Broker signs up (tier picked: solo / team / brokerage). The tenant site goes
   live at `/site/<slug>` automatically; the onboarding curriculum authors
   itself for their tier.
5. **The Decision Room** (top of the dashboard) greets them with prepared work,
   each card carrying real evidence:
   - **Adopt "«Brand» Assistant"** — one click; the site chat, phone reception,
     and briefings speak as a named assistant immediately.
   - **Import your book** → the ranked "who to work today" list builds itself;
     run the first sphere pass from the Jobs surface.
   - **Connect one social channel** → the cadence stages the first gated drafts.
   - **Upload one deal PDF** → the document kernel reads it, verifies facts with
     them, and tracks the first deadline straight from the paperwork.
   - Every card has a "quick lesson" link; anything else: ask the assistant —
     *"how do I set up my voice twin?"* answers from the curriculum on demand.
6. Setup checklist (same card, below): license + E&O, voice twin + avatar
   (Twin Studio), mobile + email connection, profile.

## Phase 2 — Week one (the AI team at work, human on the gate)

7. Daily: approve/reject the staged drafts in the approval queue. Say it out
   loud in the demo: **every decision is recorded, and a spotless record lets
   the team EARN standing moves.**
8. Watch the Command Center: the managers-talking feed, the Trust Meter, deal
   proposals resolving one-click (deadline conflicts, stage advances).
9. Sunday night: the Partners' Meeting arrives — the week presented by the AI
   team, including the trust deltas.

## Phase 3 — Week two (the moment)

10. Around the 10th consistent approval on a deal-file shape (or the 20th on a
    content shape), the feed proposes: *"Earned autonomy: you've approved N of
    N — grant this one move?"* The broker grants it on the feed.
11. Open **Earned Autonomy** (Command Center): the grant, the evidence it was
    earned on, every autonomous act since, revoke in one click. **This screen is
    the close** — no competitor can show it.

## What to measure (all on the reports surface, ledger-backed)

- Assets produced + posts published; draft adoption rate
- Deadlines tracked from paperwork; conflicts caught
- Median first response; follow-up gaps closed
- Attributed credit dollars (measured, not claimed)
- Grants earned + autonomous acts (the trust curve)

## If something looks wrong

- OS Sentinel (`/dashboard/superadmin/sentinel`) — one state-of-the-OS board.
- Every autonomous act traces to a `policy_decisions` row; every send to a
  compliance event. Nothing is unexplainable by design.
