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
