/**
 * app/api/ai/generate-module-content/route.ts
 *
 * POST — called by the admin Education client's "Generate with AI" button.
 * Drafts a training module from a topic: title, description, body, and a
 * multiple-choice quiz.
 *
 * WHY THIS FILE EXISTS. The button has always POSTed here; the route never
 * existed. The failure was silent in the worst possible way — the caller wrapped
 * everything in `if (res.ok) { … }` with no else, and a 404 is not a network
 * error, so the catch never fired either. The admin clicked Generate, the
 * spinner ran and cleared, and NOTHING happened: no content, no error, no clue.
 * Twice as bad as a visible failure, because there is nothing to report.
 *
 * Auth: session required, and the caller must be able to administer education
 * for the brokerage they name — a training module is brokerage-wide content.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { generateAIResponse } from "@/lib/ai"

const SYSTEM_PROMPT = `You are a real estate brokerage training director. Draft ONE training module.

Output ONLY a valid JSON object. No markdown, no code fences, no explanation.

Shape, exactly:
{
  "title": string,
  "description": string,
  "content": string,
  "questions": [
    { "question": string, "choices": [string, string, string, string], "correct": 0 }
  ]
}

Rules:
- "content" is the lesson body in plain paragraphs. 250-500 words. No markdown headings.
- "questions": 3 to 5 items. EXACTLY four choices each. "correct" is the 0-based
  index of the right choice and must be between 0 and 3.
- Write for the named roles. Be specific to United States residential real estate
  practice. Do NOT give legal advice; where a rule varies by state, say so.`

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const topic: string = (body.topic ?? "").toString().trim()
  const targetRoles: string[] = Array.isArray(body.targetRoles) ? body.targetRoles : []
  const brokerageId: string | null = body.brokerageId ?? null

  if (!topic) return NextResponse.json({ error: "A topic is required" }, { status: 400 })

  // The caller supplies brokerageId; never trust it. Authoring brokerage-wide
  // training is an admin act, so both the tenant AND the role are checked here.
  const { data: caller } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!caller?.brokerage_id) {
    return NextResponse.json({ error: "Your account has no brokerage yet" }, { status: 403 })
  }
  if (brokerageId && brokerageId !== caller.brokerage_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  if (!["admin", "broker", "broker_owner", "superadmin", "super_admin"].includes(caller.user_type ?? "")) {
    return NextResponse.json({ error: "Forbidden: brokerage admin only" }, { status: 403 })
  }

  try {
    const rolesLine = targetRoles.length
      ? `Target roles: ${targetRoles.join(", ")}.`
      : "Target roles: all agents."

    const response = await generateAIResponse({
      prompt: `${SYSTEM_PROMPT}\n\n${rolesLine}\nTopic: ${topic}`,
      maxTokens: 3000,
      metadata: {
        userId: user.id,
        brokerageId: caller.brokerage_id,
        feature: "education_module_content",
      },
    })

    // Models sometimes wrap JSON in a fence despite instructions.
    const raw = (response.text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "")

    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      return NextResponse.json(
        { error: "The model returned something that was not valid JSON. Try rephrasing the topic." },
        { status: 422 },
      )
    }

    // Validate rather than trust: a malformed quiz is worse than none, because
    // the admin would publish it without noticing the answer key is wrong.
    const questions = Array.isArray(parsed?.questions)
      ? parsed.questions
          .filter(
            (q: any) =>
              q &&
              typeof q.question === "string" &&
              q.question.trim() &&
              Array.isArray(q.choices) &&
              q.choices.length === 4 &&
              q.choices.every((c: any) => typeof c === "string") &&
              Number.isInteger(q.correct) &&
              q.correct >= 0 &&
              q.correct <= 3,
          )
          .slice(0, 5)
      : []

    return NextResponse.json({
      title: typeof parsed?.title === "string" ? parsed.title : "",
      description: typeof parsed?.description === "string" ? parsed.description : "",
      content: typeof parsed?.content === "string" ? parsed.content : "",
      questions,
    })
  } catch (err: any) {
    console.error("[generate-module-content] Error:", err?.message)
    return NextResponse.json(
      { error: err?.message ?? "AI generation failed" },
      { status: 500 },
    )
  }
}
