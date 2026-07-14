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
 * niche & outline → write it in 30 days IN THE AGENT'S OWN VOICE →
 * publish on Amazon KDP → the best-seller launch week.
 *
 * SCOPE, precisely (owner clarification): what authors ONCE PER BROKERAGE
 * is the COURSE — the shared coaching curriculum every agent in the
 * tenancy studies. Each agent's BOOK is their own: their niche, their
 * voice, their stories — the course exists to coach EVERY agent through
 * writing THEIR book. Voice is the whole game: a book that sounds like
 * AI wrote it is worthless as authority, so the writing module is built
 * around voice-preservation technique (dictate first, AI structures
 * second, the agent's phrasings survive every edit). Niche-driven, not
 * market-data-driven: the outline grows from the topic the agent picks
 * and what THEY uniquely know. Idempotent per program tag; rides the
 * weekly recruit-outreach cron. HONEST coaching: the launch module
 * teaches category strategy and a real launch push — never fake reviews
 * or bought ranks. recruiting_manager owns education.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { OnboardingTopic } from "@/lib/education/onboarding-curriculum"

type Svc = SupabaseClient<any, any, any>

export const BOOK_PROGRAM_TAG = (key: string) => `program:book_authority:${key}`

export const BOOK_TOPICS: OnboardingTopic[] = [
  {
    key: "niche_and_outline",
    label: "Your book is your listing presentation: pick YOUR niche, build the outline",
    audienceRoles: ["agent", "broker"],
    brief: "IN DEPTH, for an agent who has never written anything longer than an email: why a book wins listings (authority the competition can't fake); how to choose the ONE niche only YOU can own — walk 8+ real niche archetypes (neighborhood insider guide, first-time-buyer handbook, downsizing parent playbook, relocation guide, investor primer, divorce-sale survival, military PCS moves, luxury positioning) with what makes each work, who buys it, and how to test the pick in one weekend; then build the 10-chapter outline from what the agent ALREADY KNOWS AND SAYS — the questions clients ask them weekly, the stories they tell at kitchen tables — chapter by chapter, with a worked example outline for two different niches. The topic drives the book; no market-data dump required.",
  },
  {
    key: "write_with_ai_team",
    label: "Write it in 30 days — in YOUR voice, never AI's",
    audienceRoles: ["agent"],
    brief: "THE VOICE IS THE WHOLE GAME — a book that sounds like AI wrote it is worthless as authority, so teach the voice-preservation workflow step by step: record yourself ANSWERING a real client question for 10 minutes (that transcript IS your voice sample); dictate each chapter as if explaining to one specific client; let AI structure, tighten, and fix grammar but give it the hard rule 'keep my phrasings, my stories, my rhythms — restructure, never rewrite'; the read-aloud test (if you wouldn't SAY a sentence, cut it); how to spot and strip AI-sounding tells (hedged both-sides paragraphs, 'in today's fast-paced market', symmetrical lists). Then the 30-day chapter-a-day schedule, the two editing passes, the compliance read (fair-housing language, no guarantees), and getting a real cover designed affordably — each explained fully, not summarized.",
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
