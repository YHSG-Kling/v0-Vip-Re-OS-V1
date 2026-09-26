// lib/marketing/creative-playbooks.ts
// ─────────────────────────────────────────────────────────────────────────────
// CREATIVE CAMPAIGN PLAYBOOKS (owner spec): strategic, attention-grabbing
// campaigns that ride POPULAR consumer sites so the agent gets seen — the
// flagship is the ZESTIMATE CHALLENGE (challenge the online estimate the
// homeowner already checked; the QR lands on the agent's home-value page where
// an AUTO-RENDERED avatar video presents why the automated number can't be
// trusted).
//
// NO HARDCODED CONTENT (owner rule): this catalog carries ONLY strategy —
// per-step BRIEFS describing what the copy must accomplish. Every consumer-
// facing word (postcard, email, SMS, voicedrop, social caption, landing page,
// VIDEO SCRIPT) is AI-authored at install time through the charter path
// (brand-voice grounded, compliance-gated, deterministic SKIP on failure —
// never fallback prose). The instantiator lives in
// app/actions/creative-playbooks.ts and composes the EXISTING governed rails.

export type PlaybookAssetKind =
  | "lead_magnet" | "qr" | "video"
  | "direct_mail_postcard" | "direct_mail_letter"
  | "email" | "sms" | "voicedrop" | "social_post" | "bundle"

export interface PlaybookStep {
  kind: PlaybookAssetKind
  /** Internal label (shelf/asset naming — not consumer copy). */
  label: string
  /** The STRATEGY BRIEF the AI author writes the actual copy from. */
  brief: string
  /** Minutes after the previous bundle step (bundle channels only). */
  sendAfterMinutes?: number
}

export interface CreativePlaybook {
  key: string
  title: string
  /** The strategic angle — internal picker copy, never sent to a consumer. */
  strategy: string
  whyItWorks: string
  /** Which popular surface it rides. */
  ridesOn: string
  steps: PlaybookStep[]
}

export const CREATIVE_PLAYBOOKS: CreativePlaybook[] = [
  {
    key: "zestimate_challenge",
    title: "The Zestimate Challenge",
    strategy: "Challenge the online home-value estimate the homeowner has already looked up.",
    whyItWorks:
      "Every homeowner has already checked their online estimate — you're not introducing an idea, you're challenging one they're emotionally invested in. The QR lands on YOUR home-value page where your auto-rendered avatar video (their online estimate framing the background) presents why an automated model that has never seen their kitchen can't price their home — and the form captures the valuation request.",
    ridesOn: "Zillow (the estimate they already checked)",
    steps: [
      {
        kind: "lead_magnet",
        label: "Zestimate Challenge capture page",
        brief:
          "A home-valuation capture page challenging the automated online estimate (Zillow-style Zestimate). Angle: the computer model has never seen their home, their renovation, or their street's bidding wars — a licensed local expert's number is different. Promise: watch the short video breakdown, then get the real number within 24 hours. Tone: confident, respectful of the homeowner's intelligence, zero hype.",
      },
      {
        kind: "video",
        label: "Why you can't trust the online number",
        brief:
          "A 60-90 second spoken avatar presentation, delivered by the agent, explaining why an automated home-value estimate (like a Zestimate) cannot be trusted for THEIR specific home: it's a statistical average of the ZIP code, it has never seen the interior, renovations, lot position, or the emotional dynamics of local bidding wars; estimates routinely miss by tens of thousands in either direction. Close by inviting them to request the real number through the form on this page. Spoken, warm, first person, no jargon, no pressure.",
      },
      {
        kind: "qr",
        label: "Zestimate Challenge QR",
        brief: "lead_capture",
      },
      {
        kind: "direct_mail_postcard",
        label: "Zestimate Challenge — postcard",
        brief:
          "A postcard whose headline directly asks whether the homeowner agrees with the number Zillow gave their home. Body: the computer guessed — it has never seen their home; scanning the QR shows a short video on why the online number misses by tens of thousands and what a local expert would actually list at. CTA: scan for the real number.",
      },
      {
        kind: "email",
        sendAfterMinutes: 4320,
        label: "Zestimate Challenge — follow-up email",
        brief:
          "A 3-day follow-up email to homeowners who received the postcard. Subject should reference 'that number Zillow gave you' with curiosity, not clickbait. Body: validate that most homeowners quietly wonder if the online estimate is right; explain in one honest sentence why it's a ZIP-code average; invite them to watch the agent's short breakdown video and get the real number via the link placeholder {{magnet_url}}. Short, personal, no pressure.",
      },
      {
        kind: "sms",
        sendAfterMinutes: 8640,
        label: "Zestimate Challenge — nudge SMS",
        brief:
          "A day-6 one-line SMS nudge: casually ask if the online number for their place looked right, and offer the 90-second reality check + their real number at {{magnet_url}}. Friendly, under 160 characters.",
      },
      { kind: "bundle", label: "The Zestimate Challenge", brief: "" },
    ],
  },
  {
    // WAVE 82D (owner verbatim: "finding out what your home is worth in todays
    // market can make you feel overwhelmed when comparing all of these
    // sites...we can help"). The creative itself (cards + spread + hook + CTA)
    // is composed by lib/marketing/estimate-comparison.ts from APPROVED
    // captures with human-confirmed figures; the channel copy below stays
    // AI-authored from briefs (the catalog's owner rule).
    key: "estimate_comparison",
    title: "The Estimate Comparison",
    strategy: "Show the homeowner that the big home-value websites disagree about the same house — then offer the local, human read.",
    whyItWorks:
      "Homeowners already check two or three sites and feel overwhelmed when the numbers don't match. Putting every site's figure side by side, with the spread, names that confusion out loud — you're not arguing with an estimate, you're resolving a contradiction they already felt. The QR lands on your home-value review page.",
    ridesOn: "The home-value websites every homeowner has already checked (Zillow, Realtor.com, Redfin, Homes.com)",
    steps: [
      {
        kind: "lead_magnet",
        label: "Estimate Comparison — home-value review page",
        brief:
          "A home-value REVIEW request page for homeowners who saw that the big websites disagree about their home. Angle: every site runs its own model on its own data and none has been inside the home; a local review looks at condition, updates and what buyers are actually paying nearby. Promise a no-obligation review conversation; no specific or instant figure is promised on the page. Tone: calm, respectful, zero hype.",
      },
      { kind: "qr", label: "Estimate Comparison QR", brief: "lead_capture" },
      {
        kind: "direct_mail_postcard",
        label: "Estimate Comparison — postcard",
        brief:
          "A postcard whose art is the estimate comparison (each website's figure on its own card, the spread between highest and lowest). Headline options to pick from or sharpen: 'Four websites. Four different prices. Which one is right?' / 'Your home has four online prices. It only sells for one.' / 'The internet can't agree on what your home is worth.' Body: it's normal to feel overwhelmed comparing these sites — each uses different data and none has walked through the home. CTA: scan for a free, no-obligation home-value review. Never promise a number; the figures are the websites', not the agent's.",
      },
      {
        kind: "social_post",
        sendAfterMinutes: 0,
        label: "Estimate Comparison — social carousel",
        brief:
          "A carousel caption for the comparison graphic: open with a pattern-interrupt hook about the websites disagreeing on the same home; one honest sentence on why (different data, none has seen inside); invite a DM with the word VALUE for a no-obligation home-value review. No address, no promise of a number, no people or neighborhood descriptions (fair housing).",
      },
      {
        kind: "email",
        sendAfterMinutes: 4320,
        label: "Estimate Comparison — follow-up email",
        brief:
          "A 3-day follow-up email. Subject along the lines of 'Why four websites can't agree on your home's value' — curiosity, not clickbait. Body: validate that the mismatch is confusing; explain in one sentence why the sites disagree; invite a no-obligation home-value review via {{magnet_url}}. Short, personal, no pressure, no number promised.",
      },
      {
        kind: "video",
        label: "Why the websites disagree",
        brief:
          "A 45-60 second spoken presentation over the comparison graphic (screenshot treatment): open with the hook that the big home-value websites show different prices for the same home; walk the figures one at a time and land the spread; explain that each site uses its own data and none has been inside the home; close by inviting a free, no-obligation home-value review through the page. Warm, first person, no jargon, never state a value.",
      },
      { kind: "bundle", label: "The Estimate Comparison", brief: "" },
    ],
  },
  {
    key: "neighbor_brag",
    title: "The Neighbor Brag (Just-Sold Radius)",
    strategy: "Ride the just-sold sign every neighbor watched — their comps just changed.",
    whyItWorks:
      "A nearby sale is the one market event every neighbor genuinely cares about. Riding the sale everyone saw the sign for, the agent becomes the one who explains what it means for THEIR equity — the QR lands on the home-value page pre-framed by the comp.",
    ridesOn: "The just-sold listing every neighbor watched",
    steps: [
      {
        kind: "lead_magnet",
        label: "Neighbor Brag capture page",
        brief:
          "A home-valuation capture page framed by a recent nearby sale: a home near them just closed, comps move values, see what it did to theirs. Promise the updated number with the new comp factored in, within 24 hours.",
      },
      { kind: "qr", label: "Neighbor Brag QR", brief: "lead_capture" },
      {
        kind: "direct_mail_postcard",
        label: "Neighbor Brag — postcard",
        brief:
          "A postcard to the radius around a just-closed sale: the sale down the street just moved their home's value; homes like theirs are the comps buyers' agents pull; scan to see what the latest closing means for their equity.",
      },
      {
        kind: "social_post",
        sendAfterMinutes: 0,
        label: "Neighbor Brag — social",
        brief:
          "A social caption celebrating another neighborhood closing (no address, no price — compliance): if you own nearby your comps just changed; invite DMs with a one-word trigger to get an updated value, no strings.",
      },
      { kind: "bundle", label: "The Neighbor Brag", brief: "" },
    ],
  },
  {
    key: "rate_drop_reactivation",
    title: "The Rate-Drop Wake-Up",
    strategy: "Reframe stalled buyers around the MONTHLY PAYMENT that just changed, not the price.",
    whyItWorks:
      "Every stalled buyer anchored on a monthly payment, not a price. When rates move, the SAME house costs a different monthly number — that reframe reactivates buyers who ghosted, and it rides the rate headlines they're already seeing everywhere.",
    ridesOn: "The rate headlines on every news feed",
    steps: [
      {
        kind: "email",
        label: "Rate-Drop — reactivation email",
        brief:
          "A reactivation email to a buyer who went quiet when the monthly payment didn't work: rates moved, the same price point now pencils differently; offer to re-run the numbers on the homes they liked with today's rates, tonight, if they reply with one word. Empathetic, zero guilt, one clear ask.",
      },
      {
        kind: "sms",
        sendAfterMinutes: 2880,
        label: "Rate-Drop — SMS",
        brief: "A two-day follow-up SMS: rates moved, the monthly-payment math on homes they liked changed; reply with one word for the updated numbers. Under 160 characters.",
      },
      {
        kind: "voicedrop",
        sendAfterMinutes: 5760,
        label: "Rate-Drop — voicedrop",
        brief:
          "A 20-30 second warm ringless voicemail from the agent: with the recent rate move the monthly payment on the homes they looked at genuinely changed; the agent ran the new numbers and a couple were surprising; invite a call or text back for a two-minute walkthrough. Conversational, spoken, no script-reading feel.",
      },
      { kind: "bundle", label: "The Rate-Drop Wake-Up", brief: "" },
    ],
  },
  {
    key: "anniversary_equity",
    title: "The Purchase-Anniversary Equity Reveal",
    strategy: "Turn the purchase anniversary into an equity gift, not a pitch.",
    whyItWorks:
      "An anniversary is personal, positive, and expected to be celebrated — which makes the equity number feel like a gift instead of a pitch. It's the lowest-resistance touch in real estate and it compounds yearly for life.",
    ridesOn: "Their own purchase memory (and the estimate sites they check)",
    steps: [
      {
        kind: "email",
        label: "Anniversary Equity — email",
        brief:
          "A home-purchase-anniversary email: celebrate the milestone warmly, note the market moved since they bought, and offer their year-one equity snapshot (the real one, not the website guess) — free, just reply, because it's their anniversary. Celebratory, generous, zero sales pressure.",
      },
      {
        kind: "voicedrop",
        sendAfterMinutes: 1440,
        label: "Anniversary Equity — voicedrop",
        brief:
          "A 20-second warm ringless voicemail on the home anniversary: the agent remembers closing day, pulled together what the home has done since (the honest version, not the website number), and will text the one-page equity snapshot if they reply. Personal and brief.",
      },
      { kind: "bundle", label: "The Purchase-Anniversary Equity Reveal", brief: "" },
    ],
  },
  {
    key: "open_house_neighbor_vip",
    title: "The Neighbor-First Open House",
    strategy: "Make the neighbors the VIP guests of the open house they'd snoop at anyway.",
    whyItWorks:
      "Neighbors come to open houses anyway (everyone knows it). Making them the VIP guest converts the snooping into conversations — every neighbor is a future seller, and the QR captures who's curious about their own value while they're standing in the comp.",
    ridesOn: "The open house the whole street is curious about",
    steps: [
      {
        kind: "lead_magnet",
        label: "Neighbor VIP capture page",
        brief:
          "A capture page for open-house neighbor previews: they've just seen inside the comp that will set their street's prices — now see what it means for their own number. Promise the updated value after the preview.",
      },
      { kind: "qr", label: "Neighbor VIP Open House QR", brief: "open_house" },
      {
        kind: "direct_mail_postcard",
        label: "Neighbor VIP — invite postcard",
        brief:
          "An invite postcard: before Saturday's public open house, the street gets a private neighbor preview hour; come see the comp that will set the street's prices, and scan to see what it means for their own home. Exclusive but warm, not gimmicky.",
      },
      {
        kind: "sms",
        sendAfterMinutes: 4320,
        label: "Neighbor VIP — reminder SMS",
        brief: "A reminder SMS the day before: neighbor preview hour comes first; come see the home setting the street's comps and bring questions about their own number. Under 160 characters.",
      },
      { kind: "bundle", label: "The Neighbor-First Open House", brief: "" },
    ],
  },
  {
    key: "expired_rescue",
    title: "The Expired-Listing Second Opinion",
    strategy: "Dignify the failure — the home didn't fail, the plan did — and give the relaunch plan away.",
    whyItWorks:
      "Expired sellers are burned and defensive — every agent calls the morning it expires with the same pitch. A letter that dignifies the failure plus a voicedrop that asks for nothing lands differently, and giving the 14-day relaunch plan away builds the trust every other agent is trying to shortcut.",
    ridesOn: "The portal listing history every buyer (and the seller) can see",
    steps: [
      {
        kind: "direct_mail_letter",
        label: "Expired Rescue — letter",
        brief:
          "A letter to an expired-listing seller that says what the other letters won't: their home didn't fail, the plan did — photos, price story, and buyer targeting are choices, and different choices get different outcomes. The agent has prepared the exact 14-day relaunch plan they'd run, and the seller can read it before ever talking to anyone. Sign off with genuine no-pressure: the plan is theirs either way. Dignified, specific, zero desperation.",
      },
      {
        kind: "voicedrop",
        sendAfterMinutes: 2880,
        label: "Expired Rescue — voicedrop",
        brief:
          "A 25-second ringless voicemail two days after the letter: acknowledge they've heard from a dozen agents this week, so this is different — no ask for the listing; the 14-day relaunch plan is in the mail, keep it, use it with whoever they choose; a text away if they want a walkthrough. Calm and generous.",
      },
      { kind: "bundle", label: "The Expired-Listing Second Opinion", brief: "" },
    ],
  },
]

/**
 * THE ESTIMATE-TYPE PLAYS (wave 83, lane 83C — owner verbatim: "you removed
 * the zestimate playbook which you shouldn't have done because there can be
 * more than one 'estimate' type play. zestimate is marketing campaigns
 * strictly.").
 *
 * FINDING (git log -S zestimate_challenge -- lib/marketing/creative-playbooks.ts,
 * 2026-09-26): the ONLY commit touching the key is 5a9313bf (Round 36, which
 * added it); no commit on this branch removed or renamed it, and at d35fe4a4
 * it sits first in CREATIVE_PLAYBOOKS with its install path
 * (app/actions/creative-playbooks.ts `playbook.key === "zestimate_challenge"` →
 * ensureZestimateChallengeStill), its card (estimate-stills-card.tsx) and its
 * autonomous still capture intact. What 82D did was ADD `estimate_comparison`
 * beside it — so nothing needed restoring; what was missing was a rule that
 * the two plays coexist. This list IS that rule: both keys must resolve, and
 * scripts/estimate-comparison-guard.ts fails if either play is dropped or one
 * is folded into the other. A new estimate-type play is ADDED here, never
 * substituted for an existing one.
 */
export const ESTIMATE_PLAY_KEYS = ["zestimate_challenge", "estimate_comparison"] as const

/**
 * THE PLAYS WHOSE COPY MAY QUOTE THE REAL ZESTIMATE (wave 84, lane 84B — owner
 * verbatim: "for the zestimate challenge it is oky to have a real number as we
 * aren't using it as our true value.").
 *
 * The Zestimate Challenge ALONE: its whole premise is "Zillow says $X — is
 * that right?" (the industry's own shape: "sold $243,000 over the Zestimate",
 * nowbam.com 2025-05-21; "screenshot the Zestimate… 'what's your take on this
 * valuation?'", CrossCountry Mortgage 2023-10-09). The figure is ZILLOW's,
 * quoted AS Zillow's — attributed, dated, "not an appraisal" (Zillow's own
 * terms) and never the agent's opinion of value, a price the home will sell
 * for, or an appraisal. It reaches the copy only when a human has CONFIRMED
 * it off the APPROVED still (estimate-comparison.ts confirmComparisonFigure →
 * metadata.confirmed_figure_usd); no figure → the brief is unchanged.
 * NOT relaxed: the Estimate Comparison keeps "never promise a number" for its
 * own voice, and the AI ISA's home-value review CALLBACK still speaks no
 * number (lib/ai-isa/qualification-playbook.ts schedule_home_value_review) —
 * nothing in lib/ai-isa or lib/voice reads this (the zestimate-only proof).
 */
export const ZESTIMATE_FIGURE_PLAY_KEYS = ["zestimate_challenge"] as const

export function playMayQuoteZestimate(key: string): boolean {
  return (ZESTIMATE_FIGURE_PLAY_KEYS as readonly string[]).includes(key)
}

/** PURE: the brief addendum that hands the author Zillow's figure, attributed.
 *  `figureText` is already formatted (estimate-comparison.ts formatUsd);
 *  `asOf` is the still's capture date (YYYY-MM-DD) or null. */
export function zestimateFigureBrief(figureText: string, asOf: string | null): string {
  const when = asOf ? ` as shown on Zillow on ${asOf}` : " as shown on Zillow"
  return [
    `ZILLOW'S OWN FIGURE: Zillow's Zestimate for this home${when} is ${figureText}.`,
    `You MAY quote ${figureText} — always attributed to Zillow as its Zestimate (for example "Zillow's Zestimate says ${figureText}"), an automated estimate that is not an appraisal.`,
    `Never present it as the agent's value, the brokerage's opinion of value, an appraisal, or the price the home will sell for, and state no other dollar value for the home.`,
  ].join(" ")
}

export function getPlaybook(key: string): CreativePlaybook | null {
  return CREATIVE_PLAYBOOKS.find((p) => p.key === key) ?? null
}
