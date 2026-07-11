/**
 * lib/onboarding/onboarding-decisions.ts
 *
 * THE ONBOARDING DECISION ROOM — the first-week surface is DECISIONS the
 * OS pre-analyzed, not configuration to learn. The setup-readiness
 * checklist (same card) covers "go configure X"; this covers "here's
 * work the team already prepared — approve it." Same house methodology
 * as the seller decision room and the document kernel: preload what can
 * be known, present the decision with its EVIDENCE (real counts, never
 * fabricated momentum), let the human approve on an existing rail.
 *
 * Every decision routes to a rail that already runs — the jobs surface,
 * the approval queue, the tenant site, the document kernel — so day one
 * IS the product, not a tutorial about it. The one new act is adopting
 * the proposed AI assistant identity (a real go-live item: the widget,
 * calls, and briefings speak as a NAMED assistant once it exists).
 *
 * Pure composer + live facts loader. NOT server-only (simulator-driven).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export interface OnboardingDecisionFacts {
  brandName: string | null
  aiIdentityConfigured: boolean
  contactsImported: number
  sphereSignals: number
  pendingApprovals: number
  socialConnected: boolean
  siteSlug: string | null
  documentsScanned: number
}

export type DecisionState = "ready" | "waiting" | "done"

export interface OnboardingDecision {
  key: string
  title: string
  /** the preloaded evidence line — real numbers only. */
  evidence: string
  /** what saying yes does, in plain language. */
  recommendation: string
  state: DecisionState
  action: { label: string; href: string }
  /** true when the card's primary act is the in-place adopt (assistant identity). */
  adoptable?: boolean
}

/** PURE: facts → the decisions waiting on the human. Honest by construction:
 *  a zero-fact tenant gets WAITING cards with the unblocking step, never an
 *  invented "3 things are ready". */
export function composeOnboardingDecisions(f: OnboardingDecisionFacts): OnboardingDecision[] {
  const decisions: OnboardingDecision[] = []

  decisions.push(f.aiIdentityConfigured
    ? {
        key: "meet_your_assistant", title: "Your AI assistant", state: "done",
        evidence: "Your named assistant is configured — it fronts your site chat, calls, and briefings.",
        recommendation: "Nothing waiting here.",
        action: { label: "Adjust identity", href: "/dashboard/admin/ai-identity" },
      }
    : {
        key: "meet_your_assistant", title: "Name your AI assistant", state: "ready", adoptable: true,
        evidence: `Your website chat, phone reception, and briefings are ready to speak as a named assistant${f.brandName ? ` for ${f.brandName}` : ""} — right now they fall back to a generic identity.`,
        recommendation: `Adopt the proposed identity${f.brandName ? ` ("${f.brandName} Assistant")` : ""} in one click — you can rename or restyle it any time.`,
        action: { label: "Customize instead", href: "/dashboard/admin/ai-identity" },
      })

  decisions.push(f.contactsImported > 0
    ? {
        key: "first_sphere_pass", title: "Work your book — first pass", state: "ready",
        evidence: `${f.contactsImported.toLocaleString("en-US")} contact${f.contactsImported === 1 ? "" : "s"} imported${f.sphereSignals > 0 ? `; ${f.sphereSignals} carr${f.sphereSignals === 1 ? "ies" : "y"} a live signal (value check, life event, anniversary, or gone quiet)` : ""} — the ranked who-to-work-today list is already built.`,
        recommendation: "Open the Jobs surface and run the sphere pass — every touch goes through your approval.",
        action: { label: "See who to work today", href: "/dashboard/jobs" },
      }
    : {
        key: "first_sphere_pass", title: "Import your book", state: "waiting",
        evidence: "No contacts yet — the sphere engine has nothing to rank until your book is in.",
        recommendation: "Import your contacts (CSV or CRM) and the ranked list builds itself.",
        action: { label: "Import contacts", href: "/dashboard/contacts/import" },
      })

  decisions.push(f.pendingApprovals > 0
    ? {
        key: "first_approvals", title: "Your first approvals are staged", state: "ready",
        evidence: `${f.pendingApprovals} AI-staged draft${f.pendingApprovals === 1 ? "" : "s"} wait${f.pendingApprovals === 1 ? "s" : ""} in the queue.`,
        recommendation: "Approve or reject each — every decision teaches the team your taste, and a spotless record lets it EARN standing autonomy.",
        action: { label: "Review the queue", href: "/dashboard/marketing/approvals" },
      }
    : f.socialConnected
      ? {
          key: "first_approvals", title: "First content is on its way", state: "waiting",
          evidence: "Channels connected — the cadence stages your first drafts on its next pass.",
          recommendation: "Nothing to do; your approval queue fills on its own.",
          action: { label: "Open the queue", href: "/dashboard/marketing/approvals" },
        }
      : {
          key: "first_approvals", title: "Connect a channel", state: "waiting",
          evidence: "No social channels connected — staged content has nowhere to publish.",
          recommendation: "Connect one platform and the team starts staging gated drafts.",
          action: { label: "Connect socials", href: "/dashboard/profile" },
        })

  decisions.push(f.siteSlug
    ? {
        key: "your_website", title: "Your website is already live", state: "ready",
        evidence: `Your hosted site is up at /site/${f.siteSlug} — listings, agents, blog, and the AI chat, no domain required.`,
        recommendation: "Review it once, then share the link — search engines and AI assistants already index it.",
        action: { label: "View your site", href: `/site/${f.siteSlug}` },
      }
    : {
        key: "your_website", title: "Your website", state: "waiting",
        evidence: "Your tenant slug isn't set yet — the hosted site activates with it.",
        recommendation: "Finish brokerage basics in settings and the site goes live automatically.",
        action: { label: "Open settings", href: "/settings" },
      })

  decisions.push(f.documentsScanned > 0
    ? {
        key: "first_deal_file", title: "The deal file kernel is reading", state: "done",
        evidence: `${f.documentsScanned.toLocaleString("en-US")} document${f.documentsScanned === 1 ? "" : "s"} scanned — extracted facts and derived deadlines are on their ledgers.`,
        recommendation: "Nothing waiting here.",
        action: { label: "Open documents", href: "/dashboard/documents" },
      }
    : {
        key: "first_deal_file", title: "Upload one deal document", state: "ready",
        evidence: "The document kernel is idle — it reads every upload, verifies the facts with you, and tracks deadlines straight from the paperwork.",
        recommendation: "Upload any deal PDF and watch the team read it, extract the facts, and propose the next move.",
        action: { label: "Upload a document", href: "/dashboard/documents" },
      })

  return decisions
}

/** Live facts — real counts from the tenant's own tables, nothing invented. */
export async function loadOnboardingDecisionFacts(
  svc: Svc,
  input: { brokerageId: string },
): Promise<OnboardingDecisionFacts> {
  const [brand, identity, contacts, socialAccounts, brokerage, docs, socialPending, nlPending] = await Promise.all([
    svc.from("brokerages").select("name, slug").eq("id", input.brokerageId).maybeSingle(),
    svc.from("ai_identity_profiles").select("id", { count: "exact", head: true })
      .eq("scope_type", "brokerage").eq("scope_id", input.brokerageId),
    svc.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", input.brokerageId),
    svc.from("social_media_accounts").select("id", { count: "exact", head: true })
      .eq("brokerage_id", input.brokerageId).eq("is_active", true),
    svc.from("brokerages").select("slug").eq("id", input.brokerageId).maybeSingle(),
    svc.from("documents").select("id", { count: "exact", head: true })
      .eq("brokerage_id", input.brokerageId).not("scanned_at", "is", null),
    svc.from("social_posts").select("id", { count: "exact", head: true })
      .eq("brokerage_id", input.brokerageId).eq("approval_status", "pending").eq("ai_generated", true),
    svc.from("newsletter_campaigns").select("id", { count: "exact", head: true })
      .eq("brokerage_id", input.brokerageId).eq("approval_status", "pending_review").eq("is_ai_generated", true),
  ])

  // The sphere ranked list — the strongest onboarding evidence there is.
  let sphereSignals = 0
  if ((contacts.count ?? 0) > 0) {
    try {
      const { rankSphereActions } = await import("@/lib/sphere/next-best-actions")
      sphereSignals = (await rankSphereActions(svc as any, { brokerageId: input.brokerageId, limit: 8 })).length
    } catch { /* evidence stays 0 — never invented */ }
  }

  return {
    brandName: (brand.data as any)?.name ?? null,
    aiIdentityConfigured: (identity.count ?? 0) > 0,
    contactsImported: contacts.count ?? 0,
    sphereSignals,
    pendingApprovals: (socialPending.count ?? 0) + (nlPending.count ?? 0),
    socialConnected: (socialAccounts.count ?? 0) > 0,
    siteSlug: (brokerage.data as any)?.slug ?? null,
    documentsScanned: docs.count ?? 0,
  }
}
