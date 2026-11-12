# E2E (headless) tests

Playwright headless tests for the app's critical flows — primarily the
real-estate heart-of-business path: **offer → forms/packet → eSign →
document-compliance gate → accept → transaction → stages**.

## Where these run

They run on a machine/CI that has BOTH:

1. **The app's Supabase env** — `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (and any other
   `.env.local` vars). Without these the app can't connect to the DB and every
   page errors.
2. **Playwright browsers** — `npx playwright install chromium`.

The restricted build/agent container has neither (no app env, no browser
download), so the suite is intended for CI / local, not that container.

## Commands

```bash
npm run test:e2e            # boots `next dev` and runs all specs
E2E_BASE_URL=https://<preview-url> npm run test:e2e   # test a deployed preview
```

## Authenticated flows

`offer-to-transaction.flow.spec.ts` needs a logged-in agent. Provide a saved
Supabase session as a Playwright storageState and point `E2E_AUTH_STATE` at it:

```bash
E2E_AUTH_STATE=e2e/.auth/agent.json npx playwright test offer-to-transaction
```

To produce `e2e/.auth/agent.json`, log in as a seeded test agent once and save
`page.context().storageState({ path: "e2e/.auth/agent.json" })` (a global-setup
that signs in via Supabase OTP/password for a dedicated test user). Seed the test
brokerage/agent/listing with the same fixtures the DB-layer tests use, and clean
them up afterward.

`portal-login.spec.ts` is unauthenticated and runs as-is.

## Production UI smoke in CI (wave 142, lane 142I)

`ui-smoke.spec.ts` (tagged `@smoke`) and `portal-login.spec.ts` hit PUBLIC pages
only — home, `/login`, `/portal/login`, an unknown path — so they run against any
deployed preview or production URL with no seeded session, on two projects
(`chromium` desktop and `mobile-chromium`, a 393 px phone).

The CI job is `ui-smoke` in `.github/workflows/e2e.yml`. It runs when a deployed
URL is given, in either of two ways:

1. **Manual:** Actions → e2e → *Run workflow* → fill `ui_smoke_base_url`.
2. **Standing:** set the repository variable `UI_SMOKE_BASE_URL` (Settings →
   Secrets and variables → Actions → Variables); every nightly run then smokes it.

Without a URL the job prints `⊘ skipped — UI_SMOKE_BASE_URL is not set` and exits
0 — a STATED skip, never a pass. `scripts/production-readiness-guard.ts` (B11)
holds the wiring (the job, the config read, this note) and classifies the
blocker WAITING_EXTERNAL until a run with a URL is recorded.

```bash
UI_SMOKE_BASE_URL=https://<preview-url> npx playwright test --grep @smoke   # locally, same thing
```

`UI_SMOKE_BASE_URL` is read ONLY by `playwright.config.ts` (a root config file,
outside the runtime env census), so it is not an `.env.example` row.

## Feature certification across desktop / tablet / phone (wave 143, lane 143J)

`playwright.config.ts` now has three projects — `chromium` (desktop 1280), `tablet-chromium` (820 × 1180 touch)
and `mobile-chromium` (393 px phone). `feature-certification.spec.ts` is the rendered half of
`docs/architecture/FEATURE-CERTIFICATION.md`:

- **`@smoke` public surface** — `/login`, `/pricing`, `/get-started`, `/signup`, `/trust`, `/demo`, `/portal/login`:
  answers (< 500), renders, fits the viewport (no horizontal scroll), throws nothing in the page.
- **`@smoke` anonymous refusal** — every certified feature's route sends a signed-out visitor to sign-in (or says so)
  and shows no workspace shell: the fail-closed check. Both `@smoke` blocks run against a deployed URL with no session,
  so the `ui-smoke` job picks them up when `UI_SMOKE_BASE_URL` is set.
- **Signed-in block** — each route renders for a seeded agent without an error boundary, fits the viewport and throws
  nothing; the usage and billing cards never draw a measurement nobody took. Needs `E2E_AUTH_STATE` (above); without it
  the block is SKIPPED with that reason, never passed.

The route list is `e2e/feature-certification.routes.json`, GENERATED from the certification registry — regenerate it (and
the document) with `npx tsx scripts/feature-certification-guard.ts --write-doc`; the guard fails when it drifts.

```bash
UI_SMOKE_BASE_URL=https://<preview-url> npx playwright test feature-certification --grep @smoke
E2E_AUTH_STATE=e2e/.auth/agent.json npx playwright test feature-certification
```

**Status: authored, not run** — WAITING_EXTERNAL on a deployed URL (`UI_SMOKE_BASE_URL`) and a seeded session
(`E2E_AUTH_STATE`); the agent sandbox has neither a browser nor the app environment.
