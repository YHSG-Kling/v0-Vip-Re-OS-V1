export interface EmpathyResponse {
  pain: string
  empathy: string
  trust: string
  value: string
  solution: string
}

export const EMPATHY_RESPONSES = {
  "first-time-buyer": {
    pain_points: [
      {
        pain: "Worried about qualifying for a mortgage",
        empathy:
          "I get it - the mortgage process can feel really overwhelming, especially when everyone's throwing around terms like DTI and PMI. It's totally normal to feel unsure about whether you'll qualify.",
        trust:
          "I've helped 47 first-time buyers navigate this exact situation in the last 2 years. Most of them thought they wouldn't qualify too.",
        value:
          "Here's a simple pre-qualification checklist I created - it'll show you exactly where you stand in about 5 minutes. No commitment, no credit pull, just clarity.",
        solution:
          "And if you want, I can introduce you to a lender who explains things in plain English (not mortgage-speak). They'll give you the real answer in 24 hours.",
      },
      {
        pain: "Fear of overpaying or making a bad decision",
        empathy:
          "That fear of 'am I making a huge mistake?' is so real. This is probably the biggest purchase you'll ever make, and the stakes feel incredibly high.",
        trust:
          "Here's what I've learned after helping dozens of first-timers: the fear doesn't go away completely, but clarity helps a ton.",
        value:
          "I'll pull comparable sales in any area you're considering - you'll see exactly what similar homes sold for recently. No guesswork.",
        solution:
          "Throughout this process, I'll be your 'BS detector' - if something doesn't make sense or feel right, we'll pump the brakes and figure it out together.",
      },
      {
        pain: "Don't know where to start or who to trust",
        empathy:
          "The whole process feels like a black box, and everyone you talk to seems to want your business. It's hard to know who's actually looking out for you.",
        trust:
          "I've been doing this for 8 years, and I still remember how confusing it was when I bought my first home. No one explained things clearly.",
        value:
          "I put together a 'First-Time Buyer Roadmap' that breaks everything down step-by-step. It's free, no strings attached.",
        solution:
          "If you want to chat, I'm happy to answer questions with zero pressure. Seriously - even if you never work with me, I want you to feel confident in this decision.",
      },
    ],
  },

  "military-buyer": {
    pain_points: [
      {
        pain: "PCS timeline pressure - need to find something fast",
        empathy:
          "PCS stress is real. You're juggling orders, family, logistics, AND trying to find housing in a place you might not even know yet. That's a lot.",
        trust:
          "As a military family specialist, I've worked with 30+ active duty families during PCS. I know the timeline pressure you're under.",
        value:
          "I've put together a 'PCS Fast-Track Toolkit' - it includes virtual tour protocols, base commute times, and a school district breakdown. Yours free, even if we never work together.",
        solution:
          "If it makes sense, I can start searching this week and have 5 solid options ready for video tours by Friday.",
      },
      {
        pain: "Worried about VA loan complications or stigma",
        empathy:
          "I've heard the horror stories too - sellers who won't accept VA loans, or agents who make you feel like your benefit is a liability. That's frustrating and honestly disrespectful.",
        trust:
          "I've closed 40+ VA loans, and I know exactly how to position your offer so sellers take you seriously. Your VA benefit is an advantage, not a problem.",
        value:
          "Here's a one-page 'VA Loan Myth-Buster' I share with listing agents - it addresses every misconception and shows why VA buyers are solid.",
        solution: "I'll advocate for you and make sure sellers understand you're a strong buyer. Period.",
      },
    ],
  },

  "downsizing-seller": {
    pain_points: [
      {
        pain: "Emotional attachment to longtime family home",
        empathy:
          "Leaving a home where you raised your family, celebrated holidays, and built a lifetime of memories - that's not 'just a real estate transaction.' It's saying goodbye to a chapter of your life.",
        trust:
          "I've helped 20+ families navigate downsizing, and every single one has felt this exact way. The practical side is easy - it's the emotional side that matters.",
        value:
          "Let's take this at your pace. No pressure, no timelines you're not comfortable with. I have a downsizing guide that breaks it into small, manageable steps.",
        solution:
          "When you're ready, I'll make sure this home sells for what it's worth AND help you find the next chapter that feels right.",
      },
      {
        pain: "Overwhelmed by decades of belongings and decluttering",
        empathy:
          "Looking around at 20, 30, 40 years of accumulated stuff and thinking 'where do I even start?' can be paralyzing. It's not just clutter - it's your life.",
        trust:
          "I work with organizers and estate sale pros who specialize in helping people through this exact process. They're patient, respectful, and understand this isn't easy.",
        value:
          "Here's a simple 'Room-by-Room Downsizing Checklist' that makes it less overwhelming. Start with one room, take your time.",
        solution:
          "I can connect you with resources now, even if you're months away from listing. No obligation, just genuine help.",
      },
    ],
  },

  "luxury-buyer": {
    pain_points: [
      {
        pain: "Need discretion and privacy in the search process",
        empathy:
          "When you're at a certain level, every move you make feels public. The last thing you want is word getting out about where you're looking or what you're considering.",
        trust:
          "I've represented high-profile clients, executives, and celebrities. Discretion isn't a nice-to-have - it's the foundation of how I work.",
        value:
          "All searches are handled through private channels - no public showings, no property alerts that trace back to you. Total confidentiality.",
        solution: "If you'd like to explore what's available quietly, I can arrange private viewings on your schedule.",
      },
      {
        pain: "Concerned about property being worth the premium price",
        empathy:
          "At this price point, you're not just buying a house - you're making a significant financial decision. The margin for error feels smaller because the stakes are higher.",
        trust:
          "I provide comprehensive market analysis, including off-market comparables and neighborhood trajectory insights you won't find on Zillow.",
        value:
          "You'll see exactly why a property is priced the way it is, backed by data and 15 years of luxury market experience.",
        solution: "I'll make sure you have complete clarity before making any decision. No pressure, just information.",
      },
    ],
  },

  divorce: {
    pain_points: [
      {
        pain: "Navigating home sale during emotional divorce process",
        empathy:
          "Selling your home during a divorce adds stress on top of stress. This house represents a shared past, and now it's one more thing to negotiate and divide.",
        trust:
          "I've worked with 15+ divorcing couples, and I understand this requires sensitivity, patience, and absolute neutrality on my part.",
        value:
          "I'll communicate clearly with both parties (and attorneys), keep emotions out of the business side, and make this as smooth as possible.",
        solution:
          "My job is to get you both to the closing table with the best outcome possible, so you can each move forward.",
      },
    ],
  },

  fsbo: {
    pain_points: [
      {
        pain: "Frustrated with lack of showings or lowball offers",
        empathy:
          "You've been doing everything yourself - listing, photos, showings, negotiations - and it's not going the way you hoped. That's exhausting and demoralizing.",
        trust:
          "I've helped 30+ FSBO sellers who hit this exact wall. There's no shame in trying it yourself first - it shows you're savvy and proactive.",
        value:
          "Let me pull a comparative market analysis and show you where your pricing and marketing stand versus sold homes. No cost, no obligation.",
        solution:
          "If it makes sense to work together, I'll bring professional marketing, qualified buyers, and negotiation expertise. If not, at least you'll have better data.",
      },
    ],
  },

  "investor-buyer": {
    pain_points: [
      {
        pain: "Need properties with actual cash flow potential",
        empathy:
          "You're not looking for a 'cute home' - you need numbers that work. Cap rate, cash-on-cash return, exit strategy. Most agents don't get that.",
        trust:
          "I've helped investors acquire 50+ properties in the last 3 years. I run the same analysis you do: rent comps, expense ratios, appreciation trends.",
        value:
          "I'll send you a market report showing actual cap rates by neighborhood, average days-on-market for rentals, and vacancy trends.",
        solution:
          "If you want deal flow that makes sense for your strategy, I can set up alerts and send you properties before they hit the MLS.",
      },
    ],
  },

  "relocation-buyer": {
    pain_points: [
      {
        pain: "Moving to unfamiliar area - need local insights",
        empathy:
          "Moving to a new city where you don't know the neighborhoods, schools, or even where to buy groceries - that's disorienting and stressful.",
        trust:
          "I've helped 40+ relocation buyers get oriented and confident about their new area. I lived here my whole life and know these neighborhoods inside out.",
        value:
          "I'll send you a 'Newcomer's Guide' with neighborhood breakdowns, commute times, school ratings, and local recommendations (coffee shops, parks, restaurants).",
        solution:
          "When you're ready to visit, I'll arrange a full area tour - not just houses, but the actual community. You'll feel way more confident after that.",
      },
    ],
  },

  "estate-sale": {
    pain_points: [
      {
        pain: "Handling parent's estate while grieving",
        empathy:
          "Losing a parent is devastating, and now you're dealing with their property, belongings, and estate logistics. It feels overwhelming and frankly unfair that you have to do this right now.",
        trust:
          "I've worked with 25+ families going through probate and estate sales. I understand this is about your family, not just a transaction.",
        value:
          "I can help coordinate estate services, cleanouts, and repairs if needed - taking things off your plate during an already difficult time.",
        solution:
          "When you're ready, I'll handle the sale process with care and respect for your family's situation. No rush, no pressure.",
      },
    ],
  },

  "military-seller": {
    pain_points: [
      {
        pain: "PCS orders came - need to sell fast from across the country",
        empathy:
          "Getting PCS orders and realizing you have to sell your home remotely while managing a cross-country (or international) move - that's incredibly stressful.",
        trust:
          "I've helped 35+ military families sell during PCS. I know you need someone who can handle everything while you're focused on the move and your family.",
        value:
          "I'll manage repairs, staging, showings, and negotiations remotely. You'll get photo/video updates and I'll handle contractor coordination so you don't have to fly back.",
        solution:
          "My goal is to get you top dollar with minimal stress, so you can focus on your next duty station and your family's transition.",
      },
      {
        pain: "Worried about selling in a tough market or timing",
        empathy:
          "When your move date is set by orders (not market conditions), selling becomes even more stressful. You don't have the luxury of 'waiting for a better time.'",
        trust:
          "I've sold homes in every market condition - and I know how to price and market strategically to get you sold within your PCS timeline.",
        value:
          "I'll create a custom marketing plan and pricing strategy based on your specific timeline and local market conditions.",
        solution: "We'll get this done on time so you can focus on your next chapter without this hanging over you.",
      },
    ],
  },

  "relocation-seller": {
    pain_points: [
      {
        pain: "Managing home sale remotely from new city/state",
        empathy:
          "You've already moved for work, and now you're trying to manage repairs, showings, and negotiations from hundreds or thousands of miles away. It's exhausting.",
        trust:
          "I've helped 50+ relocating sellers handle the entire process remotely. I become your eyes, ears, and boots-on-the-ground.",
        value:
          "I'll coordinate everything - contractors, staging, inspections, showings. You'll get regular updates with photos/video, and I'll handle all in-person tasks.",
        solution:
          "You can focus on settling into your new role and city while I take care of selling your home. You won't need to fly back multiple times.",
      },
      {
        pain: "Timing pressure - carrying two mortgages or need proceeds for new home",
        empathy:
          "The financial pressure of two housing payments (or needing your equity for the new home) adds serious stress to an already complicated situation.",
        trust:
          "I understand the urgency. I'll price strategically and market aggressively to get you sold as quickly as possible without leaving money on the table.",
        value:
          "Let me pull a market analysis and give you realistic timelines and pricing strategy based on current conditions.",
        solution:
          "We'll create a plan that gets this sold efficiently so you can move forward financially and emotionally.",
      },
    ],
  },

  "first-time-seller": {
    pain_points: [
      {
        pain: "Don't know what to expect or how the process works",
        empathy:
          "Selling a home for the first time is almost as confusing as buying was - except now there's even more on your shoulders. What repairs? How to price it? When to list? It's a lot of unknowns.",
        trust:
          "I've guided 100+ first-time sellers through this exact process. I remember my first home sale - nobody explained anything clearly and I felt overwhelmed.",
        value:
          "I created a 'First-Time Seller Guide' that walks through every step: prep, pricing, marketing, showings, negotiations, and closing. You'll know exactly what to expect.",
        solution:
          "I'll be with you every step of the way, explaining things in plain language and making sure you feel confident in every decision.",
      },
      {
        pain: "Worried about pricing it wrong and leaving money on the table",
        empathy:
          "The fear of pricing too low and losing thousands, or pricing too high and scaring away buyers - it keeps you up at night. You only get one shot at this.",
        trust:
          "I run comprehensive comparative market analysis on every listing - you'll see exactly how I arrived at the recommended price, backed by recent sales data.",
        value:
          "I'll explain the pricing strategy in detail, and we'll adjust based on feedback. You'll never be in the dark about why we're doing what we're doing.",
        solution:
          "My job is to get you the highest price the market will bear, while selling in a timeframe that works for you.",
      },
    ],
  },

  "luxury-seller": {
    pain_points: [
      {
        pain: "Need privacy and discretion - don't want public attention",
        empathy:
          "When your home is a significant asset and your move might draw attention, the last thing you want is curiosity seekers, unqualified looky-loos, or public speculation.",
        trust:
          "I specialize in discreet luxury sales. Every showing is pre-qualified, every buyer is vetted, and marketing is handled through private networks when requested.",
        value:
          "I'll create a custom privacy protocol - from quiet listings to private viewings to non-disclosure agreements for qualified buyers.",
        solution:
          "Your privacy is paramount. We'll get this sold at the right price, to the right buyer, with total discretion.",
      },
      {
        pain: "Property has unique features - worried about finding the right buyer",
        empathy:
          "Your home isn't for everyone - the custom finishes, unique architecture, or premium amenities require a buyer who truly appreciates (and can afford) what you've built.",
        trust:
          "I've sold 30+ luxury properties and know how to identify and target the specific buyer profile who will value what makes your home special.",
        value:
          "I'll create a bespoke marketing campaign highlighting the unique features and distribute it to my network of qualified luxury buyers and agents.",
        solution:
          "We'll find the buyer who sees the value and is willing to pay for it. It may take longer, but we'll get the right outcome.",
      },
    ],
  },

  upsizing: {
    pain_points: [
      {
        pain: "Need to coordinate buying new home and selling current one",
        empathy:
          "The timing dance of upsizing is stressful - you don't want to be homeless with kids, but you also don't want to carry two mortgages or lose your dream home.",
        trust:
          "I've helped 60+ families coordinate dual transactions. There are strategies to manage timing: contingencies, bridge loans, rent-backs, strategic timing.",
        value:
          "Let me explain your options and create a dual-transaction timeline that minimizes risk and stress. We'll map out every scenario.",
        solution:
          "Whether we sell first, buy first, or coordinate simultaneously, I'll make sure you land safely in your new home without drama.",
      },
      {
        pain: "Urgency - outgrowing current home (family size, work-from-home needs)",
        empathy:
          "When your current home genuinely doesn't work anymore - too many people, not enough space, no home office - every day feels cramped and frustrating. You're ready to move yesterday.",
        trust:
          "I understand the urgency. I'll work fast to get you into a home that fits your life, while making sure we don't skip important steps or make emotional decisions.",
        value:
          "I'll start searching immediately and set up showings this week. When we find the right one, I'll negotiate aggressively to get it secured.",
        solution:
          "We'll move as quickly as the market allows, but I'll make sure you're making smart decisions even under time pressure.",
      },
    ],
  },
}

export function getEmpathyResponse(personaId: string, painPoint: string): EmpathyResponse | null {
  const persona = EMPATHY_RESPONSES[personaId as keyof typeof EMPATHY_RESPONSES]
  if (!persona) return null

  // Find matching pain point (case-insensitive partial match)
  const match = persona.pain_points.find(
    (p) =>
      p.pain.toLowerCase().includes(painPoint.toLowerCase()) || painPoint.toLowerCase().includes(p.pain.toLowerCase()),
  )

  return match || null
}

export function getAllEmpathyResponses(personaId: string): EmpathyResponse[] {
  const persona = EMPATHY_RESPONSES[personaId as keyof typeof EMPATHY_RESPONSES]
  return persona?.pain_points || []
}

export function listAllPersonas(): string[] {
  return Object.keys(EMPATHY_RESPONSES)
}

// ─── CRM-PERSONA BRIDGE (2026-08-27, lane CB — §1.2 the missing consumer) ────
//
// This authored library sat behind ONE uncalled HTTP route since it shipped.
// Its persona ids are their own dialect ("first-time-buyer", "estate-sale"),
// while the live CRM speaks the contacts/leads `persona` CHECK vocabulary
// (divorce, downsize, expired, first_time, foreclosure, fsbo, luxury, military,
// other, probate, relocated, senior, upsize — scripts/check-vocabularies.ts)
// plus a buyer/seller side from contact_type / lead_type. Two spellings of one
// idea is a §6 defect; this map is the ONE bridge, so the nurture rail can pull
// the authored Them-First arc for the persona it is actually writing to.
//
// Published blind spot: the library has NO authored content for expired,
// foreclosure, senior or other — those return null and the caller writes
// without an exemplar rather than borrowing a wrong persona's script.

const CRM_PERSONA_TO_LIBRARY: Record<string, { buyer?: string; seller?: string; either?: string }> = {
  first_time: { buyer: "first-time-buyer", seller: "first-time-seller" },
  military:   { buyer: "military-buyer", seller: "military-seller" },
  luxury:     { buyer: "luxury-buyer", seller: "luxury-seller" },
  relocated:  { buyer: "relocation-buyer", seller: "relocation-seller" },
  downsize:   { either: "downsizing-seller" },
  upsize:     { either: "upsizing" },
  probate:    { either: "estate-sale" },
  divorce:    { either: "divorce" },
  fsbo:       { either: "fsbo" },
}

/**
 * Resolve the authored empathy pain-point exemplars for a live CRM contact.
 * `persona` is the contacts/leads persona value; `contactType` decides the
 * buyer/seller variant (contact_type "investor" gets the investor-buyer set).
 * Returns null when no authored content matches — never a wrong-persona script.
 */
export function empathyGuidanceForCrmPersona(
  persona: string | null | undefined,
  contactType: string | null | undefined,
): { libraryPersonaId: string; painPoints: EmpathyResponse[] } | null {
  const type = (contactType ?? "").toLowerCase()
  if (type === "investor") {
    return { libraryPersonaId: "investor-buyer", painPoints: getAllEmpathyResponses("investor-buyer") }
  }
  const entry = persona ? CRM_PERSONA_TO_LIBRARY[persona] : undefined
  if (!entry) return null
  const side: "buyer" | "seller" = type === "seller" ? "seller" : "buyer"
  // Prefer the exact side; "both"/unknown falls to buyer first, then seller,
  // then the side-less entry — never to silence when authored content exists.
  const id = entry.either ?? entry[side] ?? entry.buyer ?? entry.seller
  if (!id) return null
  const painPoints = getAllEmpathyResponses(id)
  return painPoints.length > 0 ? { libraryPersonaId: id, painPoints } : null
}
