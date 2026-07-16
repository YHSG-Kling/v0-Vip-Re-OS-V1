// lib/marketing/creative-playbooks.ts
// ─────────────────────────────────────────────────────────────────────────────
// CREATIVE CAMPAIGN PLAYBOOKS (owner spec): strategic, attention-grabbing
// campaigns that ride POPULAR consumer sites so the agent gets seen — the
// flagship is the ZESTIMATE CHALLENGE ("Do you agree with what Zillow gave you
// as your home value?" postcard + QR → the agent's home-value page with a
// video slot explaining why an automated estimate can't be trusted).
//
// This is a CODE-VERSIONED catalog (seeded knowledge, reviewed like code — no
// parallel DB table to drift) that one click INSTANTIATES through the rails
// that already exist and are already governed:
//   · lead magnets  (createLeadMagnet → public /lm/[slug] capture page)
//   · QR codes      (createQrCodeAction → tracked scans)
//   · channel presets (upsertCampaignPreset — compliance-GATED at save)
//   · direct-mail presets (upsertDirectMailPreset — same gate discipline)
//   · campaign bundles (upsertCampaignBundle — ordered multi-channel dispatch)
// NOTHING here sends by itself — instantiation stocks the shelves; dispatch
// stays behind the existing approval + compliance chokepoints.

export type PlaybookAssetKind = "lead_magnet" | "qr" | "direct_mail_postcard" | "direct_mail_letter" | "email" | "sms" | "voicedrop" | "social_post" | "bundle"

export interface PlaybookStep {
  kind: PlaybookAssetKind
  /** Copy fields, interpreted per kind by the instantiator. */
  fields: Record<string, string>
  /** Minutes after the previous bundle step (bundle channels only). */
  sendAfterMinutes?: number
}

export interface CreativePlaybook {
  key: string
  title: string
  /** The strategic hook — why this gets the agent SEEN. */
  hook: string
  whyItWorks: string
  /** Which popular surface it rides. */
  ridesOn: string
  steps: PlaybookStep[]
}

export const CREATIVE_PLAYBOOKS: CreativePlaybook[] = [
  {
    key: "zestimate_challenge",
    title: "The Zestimate Challenge",
    hook: "“Do you agree with what Zillow says your home is worth?”",
    whyItWorks:
      "Every homeowner has already looked up their Zestimate — you're not introducing an idea, you're challenging one they're emotionally invested in. The QR lands on YOUR home-value page with a video slot where you present, with their online estimate framing in the background, why an automated model that has never seen their kitchen can't price their home — and the form captures the valuation request.",
    ridesOn: "Zillow (the estimate they already checked)",
    steps: [
      {
        kind: "lead_magnet",
        fields: {
          name: "What's your home REALLY worth?",
          magnet_type: "home_valuation",
          description:
            "Zillow's computer guessed. It has never walked your street, seen your renovation, or watched your neighbor's bidding war. Watch the 90-second breakdown of why automated estimates miss by tens of thousands — then get the number a licensed local expert would actually list you at.",
          thank_you: "Your real valuation is on its way — I'll personally review your home's details and send it within 24 hours.",
          video_slot_note:
            "Record the 'why you can't trust the online number' breakdown with your avatar/clone (Videos → Create) and attach it to this magnet's landing copy — their estimate on screen behind you is the hook.",
        },
      },
      {
        kind: "qr",
        fields: { label: "Zestimate Challenge QR", purpose: "lead_capture" },
      },
      {
        kind: "direct_mail_postcard",
        fields: {
          name: "Zestimate Challenge — postcard",
          headline: "Do you agree with what Zillow says your home is worth?",
          body: "Their computer guessed {{zestimate_hint}}. It has never seen your home. Scan to watch why the online number misses by tens of thousands — and what a local expert would really list you at.",
          cta: "Scan for your REAL number",
        },
      },
      {
        kind: "email",
        sendAfterMinutes: 4320, // 3 days after the mail drop
        fields: {
          name: "Zestimate Challenge — follow-up email",
          subject: "About that number Zillow gave you…",
          body_text:
            "Most homeowners check their online estimate and quietly wonder if it's right. Here's the honest answer: the model is a statistical average of your ZIP code — it has never seen your home. I recorded a short breakdown of where it goes wrong and what your home would actually list at. Watch it here: {{magnet_url}}",
        },
      },
      {
        kind: "sms",
        sendAfterMinutes: 8640, // 6 days
        fields: {
          name: "Zestimate Challenge — nudge SMS",
          body: "Quick one — did Zillow's number for your place look right to you? 90-second reality check + your real number: {{magnet_url}}",
        },
      },
      { kind: "bundle", fields: { name: "The Zestimate Challenge" } },
    ],
  },
  {
    key: "neighbor_brag",
    title: "The Neighbor Brag (Just-Sold Radius)",
    hook: "“Your neighbor's sale just changed what YOUR home is worth.”",
    whyItWorks:
      "A nearby sale is the one market event every neighbor genuinely cares about. Riding the sale everyone saw the sign for, you become the agent who explains what it means for THEIR equity — the QR lands on your home-value page pre-framed by the comp.",
    ridesOn: "The just-sold listing every neighbor watched",
    steps: [
      {
        kind: "lead_magnet",
        fields: {
          name: "What the sale on your street means for your home",
          magnet_type: "home_valuation",
          description: "A home near you just closed. Comps move values — see what it did to yours.",
          thank_you: "I'll send your updated number within 24 hours — with the new comp factored in.",
        },
      },
      { kind: "qr", fields: { label: "Neighbor Brag QR", purpose: "lead_capture" } },
      {
        kind: "direct_mail_postcard",
        fields: {
          name: "Neighbor Brag — postcard",
          headline: "The sale down the street just moved your home's value",
          body: "Homes like yours are the comps buyers' agents pull. Scan to see what the latest closing means for your equity.",
          cta: "See your updated number",
        },
      },
      {
        kind: "social_post",
        sendAfterMinutes: 0,
        fields: {
          name: "Neighbor Brag — social",
          caption: "Another one closed in the neighborhood. If you own nearby, your comps just changed — DM me 'NUMBER' and I'll run your updated value, no strings.",
        },
      },
      { kind: "bundle", fields: { name: "The Neighbor Brag" } },
    ],
  },
  {
    key: "rate_drop_reactivation",
    title: "The Rate-Drop Wake-Up",
    hook: "“The payment that priced you out last year just changed.”",
    whyItWorks:
      "Every stalled buyer anchored on a monthly payment, not a price. When rates move, the SAME house costs a different monthly number — that reframe reactivates buyers who ghosted, and it rides the rate headlines they're already seeing everywhere.",
    ridesOn: "The rate headlines on every news feed",
    steps: [
      {
        kind: "email",
        fields: {
          name: "Rate-Drop — reactivation email",
          subject: "The math on that house just changed",
          body_text:
            "When we last talked, the monthly on your target range didn't work. Rates moved — the same price point now pencils differently. Want me to re-run the three homes you liked with today's numbers? Reply 'rerun' and I'll have them to you tonight.",
        },
      },
      {
        kind: "sms",
        sendAfterMinutes: 2880,
        fields: {
          name: "Rate-Drop — SMS",
          body: "Rates moved — the monthly payment math on homes you liked just changed. Want the updated numbers? Reply RERUN.",
        },
      },
      {
        kind: "voicedrop",
        sendAfterMinutes: 5760,
        fields: {
          name: "Rate-Drop — voicedrop",
          tts_script:
            "Hi, it's your agent — quick heads up, with the recent rate move the monthly payment on the homes we looked at has genuinely changed. I ran the new numbers and a couple of them surprised me. Call or text me back and I'll walk you through it in two minutes.",
        },
      },
      { kind: "bundle", fields: { name: "The Rate-Drop Wake-Up" } },
    ],
  },
  {
    key: "anniversary_equity",
    title: "The Purchase-Anniversary Equity Reveal",
    hook: "“One year ago today you bought it. Here's what it's done since.”",
    whyItWorks:
      "An anniversary is personal, positive, and expected to be celebrated — which makes the equity number feel like a gift instead of a pitch. It's the lowest-resistance touch in real estate and it compounds yearly for life.",
    ridesOn: "Their own purchase memory (and the estimate sites they check)",
    steps: [
      {
        kind: "email",
        fields: {
          name: "Anniversary Equity — email",
          subject: "Happy home-iversary 🏡 — here's what your home did this year",
          body_text:
            "One year ago you got the keys. Since then the market around you moved — and so did your equity. I put together your year-one equity snapshot (the real one, not the website guess). Want it? Just reply and it's yours — no strings, it's your anniversary.",
        },
      },
      {
        kind: "voicedrop",
        sendAfterMinutes: 1440,
        fields: {
          name: "Anniversary Equity — voicedrop",
          tts_script:
            "Happy home anniversary! I still remember closing day. I pulled together what your home has done since you bought it — the honest version, not the website number. Text me back and I'll send your one-page equity snapshot.",
        },
      },
      { kind: "bundle", fields: { name: "The Purchase-Anniversary Equity Reveal" } },
    ],
  },
  {
    key: "open_house_neighbor_vip",
    title: "The Neighbor-First Open House",
    hook: "“Before the public sees it Saturday — your street gets first look.”",
    whyItWorks:
      "Neighbors come to open houses anyway (everyone knows it). Making them the VIP guest converts the snooping into conversations — every neighbor is a future seller, and the QR captures who's curious about their own value while they're standing in the comp.",
    ridesOn: "The open house the whole street is curious about",
    steps: [
      {
        kind: "lead_magnet",
        fields: {
          name: "Neighbor preview — what this listing means for your home",
          magnet_type: "home_valuation",
          description: "You've seen inside the comp. Now see what it means for your own number.",
          thank_you: "Great meeting you at the preview — your updated value is on its way.",
        },
      },
      { kind: "qr", fields: { label: "Neighbor VIP Open House QR", purpose: "open_house" } },
      {
        kind: "direct_mail_postcard",
        fields: {
          name: "Neighbor VIP — invite postcard",
          headline: "Your street sees it first",
          body: "Before Saturday's public open house, neighbors get a private preview hour. Come see the comp that will set your street's prices — and scan to see what it means for your own home.",
          cta: "RSVP + your home's new math",
        },
      },
      {
        kind: "sms",
        sendAfterMinutes: 4320,
        fields: {
          name: "Neighbor VIP — reminder SMS",
          body: "Reminder: neighbor preview hour is first — come see the home setting your street's comps. Bring questions about your own number.",
        },
      },
      { kind: "bundle", fields: { name: "The Neighbor-First Open House" } },
    ],
  },
  {
    key: "expired_rescue",
    title: "The Expired-Listing Second Opinion",
    hook: "“Your home didn't fail. The plan did.”",
    whyItWorks:
      "Expired sellers are burned and defensive — every agent calls them the morning it expires with the same pitch. A letter that dignifies the failure ('the home was never the problem') plus a voicedrop that asks for nothing lands differently, and the QR shows them the marketing plan the last agent never had.",
    ridesOn: "The portal listing history every buyer (and the seller) can see",
    steps: [
      {
        kind: "direct_mail_letter",
        fields: {
          name: "Expired Rescue — letter",
          greeting: "I'll say what the other letters won't:",
          body: "Your home didn't fail — the plan did. The photos, the price story, the buyer targeting: those are choices, and different choices get different outcomes. I put together the exact 14-day relaunch I'd run for your home, and you can see it before you ever talk to me.",
          signoff: "No pressure — the plan is yours either way.",
        },
      },
      {
        kind: "voicedrop",
        sendAfterMinutes: 2880,
        fields: {
          name: "Expired Rescue — voicedrop",
          tts_script:
            "Hi — I know you've heard from a dozen agents this week, so I'll be different: I'm not asking for the listing. I mailed you the 14-day relaunch plan I'd run for your home. Read it, keep it, use it with whoever you choose. If you want me to walk you through it, I'm a text away.",
        },
      },
      { kind: "bundle", fields: { name: "The Expired-Listing Second Opinion" } },
    ],
  },
]

export function getPlaybook(key: string): CreativePlaybook | null {
  return CREATIVE_PLAYBOOKS.find((p) => p.key === key) ?? null
}
