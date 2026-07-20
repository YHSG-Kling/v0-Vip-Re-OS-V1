# Mobile Readiness — the honest posture (v1)

The OS runs on phones today, for both sides of the product: **staff** (agents,
brokers, TCs, ISAs, lenders, vendors, compliance, admins) and **their contacts**
(the client portal). This document states exactly what ships, what deliberately
does not, and what v2 adds. Verified by `scripts/mobile-readiness-simulator.ts`.

## What ships in v1

### 1. Installable PWA (agent + portal)
- `app/manifest.ts` — Next 15 metadata route serving `/manifest.webmanifest`
  (auto-linked in `<head>` on every page, including the portal). Name/tagline/
  theme color resolve from the DB-driven product brand
  (`platform_settings.product_brand` via `lib/platform/product-brand.ts`) with
  hard fallbacks to `DEFAULT_PRODUCT_BRAND`, so the manifest is always valid
  even when the DB is unreachable at build time.
- Icons: `public/icon-192.png`, `icon-512.png` (purpose `any`, rounded) and
  `icon-maskable-192.png`, `icon-maskable-512.png` (full-bleed, mark inside the
  80% maskable safe zone), generated from the default brand lettermark
  (#0F172A / #F59E0B). `public/apple-icon.png` matches for iOS home-screen
  installs. If the platform is renamed, regenerate the icon set — the manifest
  name updates itself from the DB.
- `display: standalone`, `start_url: /dashboard` (unauthenticated opens
  redirect to `/login` and return), app shortcuts for Dashboard / CRM / Calendar.
- iOS: `appleWebApp` metadata (`app/layout.tsx` `generateMetadata`) so "Add to
  Home Screen" installs standalone under the brand name.

### 2. Viewport + safe areas
- Root `viewport` export (`app/layout.tsx`): `device-width`, `initialScale: 1`,
  `viewportFit: 'cover'`, `themeColor` matching the brand primary. Applies to
  every route — dashboards, portal, external portals.
- The mobile bottom nav pads itself with `env(safe-area-inset-bottom)` so tap
  targets clear the iOS home indicator on notched phones.

### 3. Role-driven mobile bottom navigation (already wired, now hardened)
- `app/config/navigation-config.ts` defines `mobileBottomNav` for **all 12
  roles** (agent, broker, isa, admin, vendor, contact, compliance_officer, tc,
  lender, title_agent, superadmin, team_lead).
- `app/components/layout/app-shell.tsx` renders it via
  `MobileBottomNav items={navigation.mobileBottomNav}` in a fixed bottom bar,
  hidden at `lg:` and up, with `pb-20 lg:pb-0` on `<main>` so content never
  hides behind it. A slide-in drawer exposes the full sidebar on mobile.
- A dedicated mobile companion area also exists at `app/mobile/*` (assistant,
  approvals, voice, contacts) with its own bottom nav — an on-the-go cockpit
  for agents.

### 4. Client portal on phones
- The portal (`app/portal/[contactId]/*`) bypasses the staff shell and has its
  own mobile posture: `container px-4` layout, horizontally scrollable tab nav
  (`overflow-x-auto`, `whitespace-nowrap`), 2-column card grids that fit a
  phone, and the AI chat launcher. It inherits the global viewport export and
  the PWA manifest — contacts can install the portal to their home screen too.

### 5. Push notifications (already live, PWA-compatible)
- A web-push rail exists end-to-end: `lib/providers/web-push.ts` (VAPID),
  `app/actions/push-subscriptions.ts`, `app/components/shared/push-permission-toggle.tsx`,
  and `public/push-sw.js` (display + click-through routing). Installed-PWA
  push on Android works with this rail as-is; iOS ≥ 16.4 supports web push
  **only for installed (home-screen) PWAs** — which the manifest now enables.

## What deliberately does NOT ship in v1 (the honest part)

- **No offline/caching service worker.** Verdict: Next 15 App Router streams
  RSC payloads and every authenticated surface rides Supabase auth cookies. A
  caching SW is a known footgun here (stale RSC payloads, broken auth
  redirects, cache-poisoned dashboards) — worse than none. Installability does
  not require one on modern Chrome/Edge/Android or iOS. The only service
  worker is `push-sw.js`, which has **no fetch handler** and can never
  intercept navigation. Offline mode is a v2 item, done properly (workbox-style
  network-first on a narrow allowlist + an offline fallback page), not a v1
  checkbox.
- **Static icons, dynamic name.** The brand name is a DB setting; icons are
  build assets. A rename needs an icon regen (documented in `app/manifest.ts`).
- `app/mobile-optimizations.css` exists but is **not imported** anywhere
  (pre-existing dead CSS; left untouched — its blanket 44px min-height on all
  inputs would distort checkboxes if blindly enabled). Touch-target sizing is
  handled by the components themselves.

## The sellable story (one paragraph)

Agents install the OS on their phone like a native app — home-screen icon,
full-screen standalone launch, role-aware bottom navigation, voice assistant,
approvals on the go, and push notifications. Their clients get the same: the
branded portal installs to a contact's home screen, works phone-first, and
pushes deal updates. No app store, no update friction, one codebase.

## v2 roadmap
1. Offline fallback page + narrow network-first caching (post-auth-audit).
2. Push deep-links per notification type (rail exists; add per-event URLs).
3. Per-tenant dynamic icons (brand cascade → generated maskable icons).
4. `screenshots` in the manifest for richer Android install sheets.

## Verify
`npx tsx scripts/mobile-readiness-simulator.ts` (suggested npm script:
`test:mobile-readiness`).
