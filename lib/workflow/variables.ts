/**
 * lib/workflow/variables.ts
 *
 * Variable resolver for the Workflow OS variable graph.
 *
 * Templates use {{namespace.field}} syntax:
 *   {{contact.first_name}}
 *   {{trigger.listing_address}}
 *   {{enrollment.id}}
 *   {{step_1.image_url}}              — output from step at index 1
 *   {{step_welcome_email.sent_at}}    — output from step keyed by variable name
 *
 * Pipe transformers (appended after |):
 *   {{contact.first_name|upper}}
 *   {{contact.first_name|lower}}
 *   {{contact.email|url_encode}}
 *   {{contact.bio|truncate(120)}}
 *   {{listing.price|currency}}
 *   {{trigger.date|date(MMM D, YYYY)}}
 *   {{contact.name|slugify}}
 *   {{step_1.image_url|json_encode}}
 *
 * Missing variables resolve to empty string (never throws).
 */

// ─── Context ──────────────────────────────────────────────────────────────────

export interface VariableContext {
  contact?: Record<string, unknown>
  trigger?: Record<string, unknown>
  enrollment?: Record<string, unknown>
  listing?: Record<string, unknown>
  transaction?: Record<string, unknown>
  agent?: Record<string, unknown>
  brokerage?: Record<string, unknown>
  /**
   * Step outputs from previously completed steps.
   * Keys are either step indices ("step_1", "step_2") or output_variable_names
   * ("step_hero_image", "step_cma_pdf"). Both forms are registered.
   */
  steps?: Record<string, Record<string, unknown>>
}

// ─── Pipe transformers ────────────────────────────────────────────────────────

type Transformer = (value: string, arg?: string) => string

const TRANSFORMERS: Record<string, Transformer> = {
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  trim: (v) => v.trim(),

  url_encode: (v) => encodeURIComponent(v),
  json_encode: (v) => JSON.stringify(v),

  slugify: (v) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, ""),

  currency: (v) => {
    const n = parseFloat(v)
    if (isNaN(n)) return v
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(n)
  },

  truncate: (v, arg) => {
    const max = parseInt(arg ?? "100", 10)
    if (isNaN(max) || v.length <= max) return v
    return v.slice(0, max).replace(/\s+\S*$/, "") + "…"
  },

  date: (v, arg) => {
    // Lightweight date formatter — only common tokens
    const d = new Date(v)
    if (isNaN(d.getTime())) return v
    const fmt = arg ?? "YYYY-MM-DD"
    const pad = (n: number) => String(n).padStart(2, "0")
    const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    const MONTH_LONG  = ["January","February","March","April","May","June","July","August","September","October","November","December"]
    return fmt
      .replace("YYYY",  String(d.getFullYear()))
      .replace("MM",    pad(d.getMonth() + 1))
      .replace("DD",    pad(d.getDate()))
      .replace("M",     String(d.getMonth() + 1))
      .replace("D",     String(d.getDate()))
      .replace("MMMM",  MONTH_LONG[d.getMonth()])
      .replace("MMM",   MONTH_SHORT[d.getMonth()])
  },

  relative_date: (v) => {
    const d = new Date(v)
    if (isNaN(d.getTime())) return v
    const diff = Math.round((d.getTime() - Date.now()) / 86_400_000)
    if (diff === 0) return "today"
    if (diff === 1) return "tomorrow"
    if (diff === -1) return "yesterday"
    if (diff > 0) return `in ${diff} days`
    return `${Math.abs(diff)} days ago`
  },
}

// ─── Core resolver ────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{([\w.]+?)(?:\|([^}]+))?\}\}/g

/**
 * Resolve all {{namespace.field|transformer}} placeholders in a template string.
 * Returns the template with all known variables substituted.
 * Unknown variables are replaced with empty string.
 */
export function resolveVariables(template: string, ctx: VariableContext): string {
  if (!template || !template.includes("{{")) return template

  return template.replace(PLACEHOLDER_RE, (_match, path: string, pipeExpr?: string) => {
    const raw = resolvePath(path, ctx)
    const stringVal = raw === null || raw === undefined ? "" : String(raw)
    return applyPipe(stringVal, pipeExpr?.trim())
  })
}

/**
 * Resolve a dot-notation path like "contact.first_name" or "step_1.image_url"
 * against the VariableContext.
 */
function resolvePath(path: string, ctx: VariableContext): unknown {
  const [namespace, ...rest] = path.split(".")
  const field = rest.join(".")

  // Step outputs: step_1, step_2, step_<variable_name>
  if (namespace.startsWith("step_") && ctx.steps) {
    const stepKey = namespace // "step_1" or "step_hero_image"
    const stepOutput = ctx.steps[stepKey]
    if (stepOutput && field) return deepGet(stepOutput, field)
    if (stepOutput && !field) return stepOutput
    return ""
  }

  const nsMap: Record<string, Record<string, unknown> | undefined> = {
    contact:     ctx.contact     ?? {},
    trigger:     ctx.trigger     ?? {},
    enrollment:  ctx.enrollment  ?? {},
    listing:     ctx.listing     ?? {},
    transaction: ctx.transaction ?? {},
    agent:       ctx.agent       ?? {},
    brokerage:   ctx.brokerage   ?? {},
  }

  const source = nsMap[namespace]
  if (!source) return ""
  return field ? deepGet(source, field) : source
}

function deepGet(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".")
  let cur: unknown = obj
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return ""
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function applyPipe(value: string, pipeExpr: string | undefined): string {
  if (!pipeExpr) return value

  // Support chained pipes: "upper|truncate(50)"
  const pipes = pipeExpr.split("|").map((p) => p.trim()).filter(Boolean)
  let result = value

  for (const pipe of pipes) {
    const match = pipe.match(/^(\w+)(?:\(([^)]*)\))?$/)
    if (!match) continue
    const [, name, arg] = match
    const fn = TRANSFORMERS[name]
    if (fn) result = fn(result, arg)
  }

  return result
}

// ─── Build VariableContext from enrollment row ────────────────────────────────

export interface EnrollmentVariableInput {
  contact?: Record<string, unknown> | null
  enrollment?: Record<string, unknown> | null
  listing?: Record<string, unknown> | null
  transaction?: Record<string, unknown> | null
  agent?: Record<string, unknown> | null
  brokerage?: Record<string, unknown> | null
  triggerMetadata?: Record<string, unknown> | null
  stepOutputs?: Record<string, Record<string, unknown>>
}

/**
 * Build a VariableContext from enrollment row data + loaded relations.
 * The step_outputs from the enrollment row are indexed both by step number
 * ("step_1") and by output_variable_name ("step_hero_image") so templates
 * can use either form.
 */
export function buildVariableContext(input: EnrollmentVariableInput): VariableContext {
  const steps: Record<string, Record<string, unknown>> = {}

  if (input.stepOutputs) {
    for (const [key, val] of Object.entries(input.stepOutputs)) {
      steps[key] = val
    }
  }

  return {
    contact:     input.contact     ?? {},
    enrollment:  input.enrollment  ?? {},
    listing:     input.listing     ?? {},
    transaction: input.transaction ?? {},
    agent:       input.agent       ?? {},
    brokerage:   input.brokerage   ?? {},
    trigger:     input.triggerMetadata ?? {},
    steps,
  }
}

// TOMBSTONE (orphan burn-down, lane E): `resolveStepConfig(config, ctx)` DELETED.
//
// It resolved {{variables}} across EVERY string field of a step object. Zero
// callers, and the workflow engine deliberately does not want that shape.
//
// SURVIVOR: lib/campaign-sequences/step-executor.ts:326-334 — the ONE place a
// workflow step is executed (the engine was consolidated to one; see
// `npm run test:workflow-engine-consolidation`). It resolves an EXPLICIT,
// enumerated allow-list of template fields — subject, body, image_prompt,
// social_caption_prompt, qr_target_url_pattern, listing_page_slug,
// voice_drop_script, video_script, task_title, task_notes_prompt,
// ad_audience_prompt, showing_notes, tour_start_address — into
// `StepContext.resolvedVars`, which the channel handlers then read BY NAME.
//
// The allow-list is the point, not an omission. Blanket-resolving every string
// on a `sequence_steps` row would also run the resolver over columns that are
// identifiers, not copy — channel, status, id, output_variable_name — and over
// operator-authored fields nobody declared as templates, which is how a literal
// brace sequence in a subject line silently becomes an empty string. It would
// also hand the handlers a resolvedVars map whose keys they never agreed on.
//
// Nothing merged: the survivor already calls `resolveVariables` (:120 in this
// file), which stays exported and is the shared primitive both would have used.
// A future field becomes templatable by being NAMED in that list — one line, and
// visible in review — rather than by being a string.
