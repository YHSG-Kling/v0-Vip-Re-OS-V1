/**
 * lib/external/vision-property.ts
 *
 * Claude Vision adapter for property images — derives motivation / staging / condition signals
 * text-scraping competitors miss. One Haiku Vision call per image returns a structured score the
 * lead pipeline can fold into `motivationScore`, lifting deferred-maintenance / poor-staging /
 * overgrown / boarded-up properties (months on market) above generic listings.
 *
 * Routes through the canonical connector-gateway. Cost: ~$0.002-0.005 per call with Haiku.
 */
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = process.env.VISION_PROPERTY_MODEL ?? "claude-haiku-4-5-20251001"

export interface PropertyVisionScore {
  /** 0..100 — higher = more motivated-seller signal (deferred maintenance, poor staging, etc.). */
  motivationBoost: number
  /** 0..100 condition score (100 = pristine; 0 = severe disrepair). */
  conditionScore:  number
  /** 0..100 staging quality (100 = professional staging; 0 = no staging / chaotic). */
  stagingScore:    number
  /** Discrete signals the model picked up — useful for analytics + AI-ISA scripts. */
  signals: {
    deferredMaintenance:  boolean
    overgrownYard:        boolean
    boardedWindows:       boolean
    visiblePersonalItems: boolean   // unsold/owner-still-living = often more motivated
    professionalPhotos:   boolean
    vacantInterior:       boolean
  }
  /** One-sentence rationale the LLM produced (for audit + downstream prompts). */
  rationale: string
  /** Approximate USD cost (token-based). */
  cost: number
  error: string | null
}

export async function scorePropertyImage(params: {
  /** Public image URL Anthropic can fetch — listing-photo CDN URLs work directly. */
  imageUrl: string
  /** Optional context: address / list price / days-on-market that biases the rationale. */
  context?: string
}): Promise<PropertyVisionScore> {
  const empty: PropertyVisionScore = {
    motivationBoost: 0, conditionScore: 0, stagingScore: 0,
    signals: { deferredMaintenance:false, overgrownYard:false, boardedWindows:false, visiblePersonalItems:false, professionalPhotos:false, vacantInterior:false },
    rationale: "", cost: 0, error: null,
  }
  if (!params.imageUrl) return { ...empty, error: "imageUrl required" }
  if (!ANTHROPIC_KEY)   return { ...empty, error: "missing ANTHROPIC_API_KEY" }

  const userText =
    "Look at this real-estate listing photo and respond ONLY with JSON of this exact shape:\n" +
    `{\n` +
    `  "motivationBoost": 0-100,\n` +
    `  "conditionScore":  0-100,\n` +
    `  "stagingScore":    0-100,\n` +
    `  "signals": { "deferredMaintenance": bool, "overgrownYard": bool, "boardedWindows": bool, "visiblePersonalItems": bool, "professionalPhotos": bool, "vacantInterior": bool },\n` +
    `  "rationale": "one sentence"\n` +
    `}\n` +
    (params.context ? `\nCONTEXT: ${params.context}\n` : "") +
    "\nScore high motivationBoost when you see deferred maintenance / overgrown yard / boarded windows / non-staged interior / personal items left behind. Low when staging is professional and condition is pristine."

  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<any>({
    connector: "anthropic",
    baseUrl:   "https://api.anthropic.com/v1",
    path:      "messages",
    method:    "POST",
    auth:      { style: "header", name: "x-api-key", value: ANTHROPIC_KEY },
    headers:   { "anthropic-version": "2023-06-01" },
    body: {
      model: MODEL, max_tokens: 512,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: params.imageUrl } },
          { type: "text",  text: userText },
        ],
      }],
    },
  })

  if (!res.ok || !res.data) return { ...empty, error: res.error ?? "anthropic call failed" }

  const text = (res.data.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trim()
  let parsed: any
  try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")) }
  catch (e) { return { ...empty, error: `json parse failed: ${(e as Error).message}` } }

  const usage = res.data.usage ?? {}
  const cost = (usage.input_tokens ?? 0) / 1_000_000 * 1.0 + (usage.output_tokens ?? 0) / 1_000_000 * 5.0
  const clip = (n: unknown) => Math.max(0, Math.min(100, Number(n) || 0))
  return {
    motivationBoost: clip(parsed.motivationBoost),
    conditionScore:  clip(parsed.conditionScore),
    stagingScore:    clip(parsed.stagingScore),
    signals: {
      deferredMaintenance:  !!parsed.signals?.deferredMaintenance,
      overgrownYard:        !!parsed.signals?.overgrownYard,
      boardedWindows:       !!parsed.signals?.boardedWindows,
      visiblePersonalItems: !!parsed.signals?.visiblePersonalItems,
      professionalPhotos:   !!parsed.signals?.professionalPhotos,
      vacantInterior:       !!parsed.signals?.vacantInterior,
    },
    rationale: String(parsed.rationale ?? "").slice(0, 500),
    cost,
    error: null,
  }
}
