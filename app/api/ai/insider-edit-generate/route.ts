import { generateText } from "ai"
import { NextResponse } from "next/server"
import type { InsiderEditInput, InsiderEditNewsletter, InsiderEditSection } from "@/types"

const THEM_FIRST_SYSTEM_PROMPT = `You are "The Insider," a curated real estate newsletter curator with quiet confidence and specific editorial taste. Your tone is low-stress, high-quality, and micro-editorial.

FORBIDDEN WORDS/PHRASES: "Hurry," "Act fast," "Don't miss out," generic "Luxury," "Amazing," "Spectacular," "Must see"

REQUIRED TONE: 
- Quiet confidence over hype
- Specific details over generic praise
- Curiosity-driven language
- Micro-editorial (like a fine magazine)
- Personal POV mixed with market insight

You are generating curated weekly opportunity newsletters that feature ONE listing but frame it through lifestyle, community, and opportunity lenses. The newsletter is NOT a property blast—it's a "deal of the week" that tells a story.

Each section should be 150-200 words, specific, and avoid all hard-sell language.`

const SECTION_PROMPTS = {
  hook: `Create "The Hook" - a personal point of view about the market THIS WEEK. This should be a single paragraph with quiet confidence about market dynamics (e.g., "The market isn't crashing, it's calibrating" or "Inventory isn't tight, it's curated"). Make it feel like an insider sharing a genuine perspective, not a sales pitch. Should feel like the opening line of a thoughtful blog post.`,

  events: `Create a "Curated Events" section. List 2-3 LOCAL events happening this week in the neighborhood. For each event, include: Event Name, Date/Time, Vibe (1-2 words describing the feeling). Events should feel authentic to the neighborhood's character, not generic. End with a casual connector to why these events matter for understanding the lifestyle.`,

  civic: `Create "Development Watch" - a section about civic/infrastructure news in the neighborhood. This could be: new schools opening, zoning changes, hospital expansions, transit improvements, or neighborhood development. Write it in the tone of "here's what's actually happening that matters." 2-3 items, 1-2 sentences each.`,

  deal: `Create "The Opportunity" section presenting the listing. START with: "For the buyer who wants [specific lifestyle/outcome]:" then describe the property focusing on: 1) The lifestyle fit, 2) One unique/hidden value point, 3) Market positioning. Use the property highlights provided. Avoid MLS-speak. Make it feel like a discovery, not a listing.`,

  eats: `Create "Community & Eats" - a single paragraph recommending ONE restaurant/cafe in the neighborhood. This should feel like a personal recommendation from someone who knows the area. Focus on the experience/vibe, not just food. End with why locals love it.`,
}

async function generateSection(
  sectionType: InsiderEditSection["sectionType"],
  context: Partial<InsiderEditInput> & { pressureTestHighlights: string[]; listingAddress?: string },
): Promise<InsiderEditSection> {
  const userPrompt = `${SECTION_PROMPTS[sectionType]}

Context:
- Neighborhood: ${context.city}, ${context.zipCode}
- Neighborhood Vibe: ${context.vibe}
- Property Address: ${context.listingAddress || "TBD"}
${sectionType === "deal" ? `- Unique Features: ${context.pressureTestHighlights.join(", ")}` : ""}

Generate only the section content, no headers or labels.`

  const { text } = await generateText({
    model: "openai/gpt-4-turbo",
    system: THEM_FIRST_SYSTEM_PROMPT,
    prompt: userPrompt,
  })

  const sectionTitles: Record<InsiderEditSection["sectionType"], string> = {
    hook: "This Week's Market POV",
    events: "Curated Events",
    civic: "Development Watch",
    deal: "The Opportunity",
    eats: "Community & Eats",
  }

  return {
    sectionType,
    title: sectionTitles[sectionType],
    content: text,
    editableContent: text,
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as InsiderEditInput & { createdByUserId: string }

    // Generate all sections in parallel
    const sections = await Promise.all(
      (["hook", "events", "civic", "deal", "eats"] as const).map((sectionType) =>
        generateSection(sectionType, {
          ...body,
          listingAddress: body.listingUrl.split("/").filter((p) => p)[3] || "Listing",
        }),
      ),
    )

    // Extract first section as preview text
    const previewText = sections[0].content.split(".")[0] + "."

    // Generate subject line
    const subjectLineResult = await generateText({
      model: "openai/gpt-4-turbo",
      system:
        "Generate a compelling, curiosity-driven email subject line (50 chars max) for a real estate newsletter. No hype words. Example: 'The quiet appeal of Williamsburg'",
      prompt: `For a neighborhood: ${body.city}, vibe: ${body.vibe}. Subject line:`,
    })

    const newsletter: InsiderEditNewsletter = {
      id: `insider-${Date.now()}`,
      title: `The Insider Edit - ${body.city}`,
      listingAddress: body.listingUrl,
      listingUrl: body.listingUrl,
      vibe: body.vibe,
      zipCode: body.zipCode,
      city: body.city,
      sections,
      pressureTestHighlights: body.pressureTestHighlights,
      emailHtml: `<html><body>${sections.map((s) => `<h2>${s.title}</h2><p>${s.content}</p>`).join("")}</body></html>`,
      emailPreviewText: previewText,
      status: "draft",
      tone: body.agentPastToneContext ? "custom" : "curator",
      createdByUserId: body.createdByUserId,
      createdAt: new Date().toISOString(),
    }

    return NextResponse.json(newsletter)
  } catch (error) {
    console.error("[InsiderEditGenerate] Error:", error)
    return NextResponse.json({ error: "Failed to generate newsletter" }, { status: 500 })
  }
}
