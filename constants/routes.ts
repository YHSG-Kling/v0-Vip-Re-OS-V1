// constants/routes.ts
// ─────────────────────────────────────────────────────────────────────────────
// TOMBSTONE (orphan burn-down, lane E). `getNavItemUrl(navId)` and the
// `ROUTE_MAP` table it read were DELETED. Both had zero consumers anywhere in
// the tree — getNavItemUrl was ROUTE_MAP's only reader, and nothing read
// getNavItemUrl — so this module was a closed loop.
//
// SURVIVOR: app/config/navigation-config.ts:85 `NAVIGATION_BY_ROLE`. Every
// NavItem there carries its own authored `href`, and the live render path is
// `getNavigationForRole` (navigation-config.ts:1175) →
// app/components/layout/app-shell.tsx:145 → Sidebar / Header / MobileBottomNav,
// which read `item.href` directly. There is no id-to-URL indirection step for
// this map to have participated in.
//
// NOTHING WAS MERGED, and that is the finding rather than an oversight: the
// deleted table held no route the survivor lacks — it held WRONG ones. Of its
// ~68 entries, TWENTY-FIVE resolved to "/seed", the developer data-seeding page
// (app/seed/page.tsx): transactions, events, listing-intake, offer-lab,
// calendar, showings, buyer-tours, feedback-log, playbook, voice-call-bridge,
// ai-isa, documents, marketplace, inbox, oh-manager, closing-dashboard, cma,
// partners, notifications, shareable-assets, user-management, tc-dashboard,
// listing-distribution, buyer-dashboard, matches, home-value, seller-dashboard,
// listing-journey, ai-chat. Several more collapsed distinct destinations onto
// one page (six different ids all mapped to "/analytics"). Its fallback,
// `/${navId}`, invented a route from an id for anything unlisted. Wiring this to
// a sidebar would have sent agents to the seed page from two dozen menu items;
// carrying any of it onto NAVIGATION_BY_ROLE would have been carrying a defect.
//
// Kept as this note, with no exports, so the next person who needs "the id → URL
// map" finds out that the hrefs live on the nav items themselves.

export {}
