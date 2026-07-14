/**
 * lib/education/book-authority-program.ts
 *
 * THE BOOK AUTHORITY PROGRAM (owner directive: "an area to coach users how
 * to create a book and publish it on the best-seller Amazon list") — the
 * authority play nobody's CRM teaches: an agent with a book on the local
 * market wins listings before the appointment starts. Four curated
 * micro-courses on the SAME canonical education rail as everything else
 * (authorModuleFor → gated learning_modules drafts, pending_review,
 * approve → published → the academy + on-demand ask_guidance serve them):
 * niche & outline → write it in 30 days WITH the AI team → publish on
 * Amazon KDP → the best-seller launch week. Idempotent per program tag;
 * rides the weekly recruit-outreach cron beside the onboarding
 * curriculum. HONEST coaching: the launch module teaches category
 * strategy and a real launch push — never fake reviews or bought ranks.
 * recruiting_manager owns education.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { OnboardingTopic } from "@/lib/education/onboarding-curriculum"

type Svc = SupabaseClient<any, any, any>

export const BOOK_PROGRAM_TAG = (key: string) => `program:book_authority:${key}`

export const BOOK_TOPICS: OnboardingTopic[] = [
  {
    key: "niche_and_outline",
    label: "Your book is your listing presentation: pick the niche, build the outline",
    audienceRoles: ["agent", "broker"],
    brief: "Why a local-market book wins listings (authority the competition can't fake); choosing a niche a real agent can own (neighborhood guide, first-time-buyer handbook for THIS city, downsizing playbook, relocation guide); the 10-chapter outline template; mining your own closed deals, market updates, and blog posts for chapter material you already wrote.",
  },
  {
    key: "write_with_ai_team",
    label: "Write it in 30 days with your AI team",
    audienceRoles: ["agent"],
    brief: "The chapter-a-day workflow: dictate what you tell clients (you say it weekly already), let AI structure and tighten it, keep YOUR voice and YOUR local stories (the book must sound like the agent, not a robot); editing passes, a compliance read (fair-housing language, no guarantees), and getting a real cover designed affordably.",
  },
  {
    key: "publish_on_kdp",
    label: "Publishing on Amazon KDP, step by step",
    audienceRoles: ["agent"],
    brief: "The exact Amazon KDP flow: account setup, manuscript formatting (paperback + Kindle), cover specs, ISBN choices, pricing strategy for an authority book (price for credibility and gifting, not royalties), categories and keywords that fit local real estate, and ordering author copies to hand to every listing appointment.",
  },
  {
    key: "bestseller_launch",
    label: "The best-seller launch week — done honestly",
    audienceRoles: ["agent", "broker"],
    brief: "How the Amazon best-seller flag actually works (category-level, sales-velocity in a window); choosing 2-3 SPECIFIC, winnable categories; the one-week launch plan riding rails you already have — sphere email, social cadence, open-house giveaways, a launch price window; asking real readers for honest reviews (NEVER purchased or fake reviews — Amazon bans them and they poison trust); and turning 'best-selling author' into listing-presentation and farming copy afterward.",
  },
]

export interface BookProgramResult { topics: number; authored: number }

/** Author the program for one brokerage — idempotent per program tag. */
export async function runBookAuthorityProgram(svc: Svc, brokerageId: string): Promise<BookProgramResult> {
  const out: BookProgramResult = { topics: BOOK_TOPICS.length, authored: 0 }
  const { data: b } = await svc.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
  const tier = (((b as any)?.plan_tier ?? "solo_agent") as any)

  const { authorModuleFor, persistOnboardingModule } = await import("@/lib/education/onboarding-authoring")
  for (const topic of BOOK_TOPICS) {
    const tag = BOOK_PROGRAM_TAG(topic.key)
    const { data: existing } = await svc.from("learning_modules")
      .select("id").eq("brokerage_id", brokerageId).eq("is_ai_generated", true)
      .contains("gap_tags", [tag]).limit(1).maybeSingle()
    if (existing) continue
    const curriculum = await authorModuleFor(topic, tier).catch(() => null)
    if (!curriculum) continue
    const ok = await persistOnboardingModule(svc, brokerageId, tag, topic, curriculum)
    if (ok) out.authored++
  }
  return out
}

/** Autonomous: every brokerage missing the program (weekly recruit-outreach cron). */
export async function runBookAuthorityProgramAll(svc: Svc): Promise<{ brokerages: number; authored: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(200)
  let authored = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const r = await runBookAuthorityProgram(svc, b.id).catch(() => null)
    if (r) authored += r.authored
  }
  return { brokerages: (brokerages ?? []).length, authored }
}
