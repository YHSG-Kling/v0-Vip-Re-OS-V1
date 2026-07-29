/**
 * lib/workflow/step-palette.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE STEP PALETTE. What a builder may offer, and what each step needs.
 *
 * Two builders edit the same campaign_sequences / campaign_sequence_steps rows,
 * and each restated its own step list:
 *
 *   /dashboard/campaigns/workflows       8 types (email, sms, direct_mail, wait,
 *                                        condition, assign_task, add_to_segment,
 *                                        remove_from_campaign)
 *   /dashboard/campaigns/sequences/[id]  7 channels (+ video, in_app, voice_drop,
 *                                        ai_call; − wait, condition, task, segment)
 *
 * Between them they reached 12 of the 23 the executor can dispatch. A sequence
 * built in one contained steps the other could not render, so opening it in the
 * wrong builder HID them — and eleven channels with working, registered adapters
 * (ad_campaign, ai_image, avm_cma, draft_document, listing_landing_page,
 * newsletter, schedule_showing, schedule_tour, send_for_esign, send_gift,
 * social_post) had no UI anywhere. Code shipped, dispatchable, unreachable.
 *
 * One spec now. Both builders render it, so neither can drift from the other,
 * from lib/workflow/adapters (which registers the executors) or from the
 * campaign_sequence_steps.channel CHECK (which decides what saves). The guard
 * proves those three agree — palette == CHECK == registry — and that every
 * `field.name` below is a real column on the table, so a field cannot be offered
 * that silently writes nowhere.
 *
 * ── GROUPS ──────────────────────────────────────────────────────────────────
 * The grouping is the owner's rule about video made general. Video is NOT a
 * channel — "video is delivered in a sms or email" — and the adapter agrees: it
 * renders a clip and stores the URL for a later step to send. Several steps are
 * like that. So a step is grouped by WHAT IT DOES, not by the fiction that
 * everything is a send:
 *
 *   deliver   reaches this person directly            (a message goes out)
 *   publish   reaches an audience                     (a post/ad/page goes live)
 *   produce   makes an asset a LATER step delivers    (no one is contacted)
 *   transact  moves the deal or the relationship      (booking, signature, gift)
 *   flow      controls the sequence itself            (no external effect)
 *
 * A "produce" step contacting nobody is exactly why it must not sit in a list
 * labelled "channels": a broker choosing Video expecting a send would get an
 * asset and silence.
 */

/** Which of the five things a step does. */
export type StepGroup = "deliver" | "publish" | "produce" | "transact" | "flow"

export const STEP_GROUP_LABELS: Record<StepGroup, string> = {
  deliver: "Reach this person",
  publish: "Reach an audience",
  produce: "Produce an asset",
  transact: "Move the deal",
  flow: "Control the flow",
}

export const STEP_GROUP_HELP: Record<StepGroup, string> = {
  deliver: "A message goes out to the contact on this step.",
  publish: "Content goes live to an audience rather than to one person.",
  produce: "Creates an asset for a LATER step to send. Nobody is contacted.",
  transact: "Books, signs, or sends something that moves the relationship.",
  flow: "Changes what the sequence does next. No outside effect.",
}

/**
 * `uuid` and `uuid_csv` exist because the column types demand them. Seven of
 * these columns are `uuid` and tour_property_ids is `uuid[]` — a plain text box
 * over them turns a typo into "invalid input syntax for type uuid" from the
 * database, which is not a sentence anyone should be shown. isInvalidValue()
 * catches it in the builder instead.
 */
export type StepFieldType =
  | "text" | "textarea" | "number" | "select" | "boolean" | "url"
  | "csv" | "uuid" | "uuid_csv"

export interface StepFieldSpec {
  /** MUST be a column on campaign_sequence_steps — the guard checks this. */
  name: string
  label: string
  type: StepFieldType
  options?: ReadonlyArray<{ value: string; label: string }>
  placeholder?: string
  help?: string
  /** The step cannot run without it; the builder marks it and warns on save. */
  required?: boolean
  /** The column is NOT NULL — a cleared input must fall back, never write null. */
  notNull?: boolean
  /** Used for notNull numbers when the input is cleared. */
  fallback?: number
}

export interface StepTypeSpec {
  /** campaign_sequence_steps.channel — the CHECK value. */
  channel: string
  label: string
  /** One line, in a broker's words, about what happens when this step runs. */
  description: string
  group: StepGroup
  /** lucide-react icon name; each builder maps it to its own imported component. */
  icon: string
  /** Brokerage feature flag that must be on, or null when always available. */
  flagKey: string | null
  fields: ReadonlyArray<StepFieldSpec>
}

/** Every step carries these; the builders render them outside the per-type block. */
export const COMMON_STEP_FIELDS: ReadonlyArray<StepFieldSpec> = [
  { name: "step_name", label: "Step name", type: "text", placeholder: "What this step is for" },
  { name: "delay_days", label: "Wait (days) before this step", type: "number" },
  { name: "delay_hours", label: "…plus hours", type: "number" },
]

const AI_INTENT: StepFieldSpec = {
  name: "ai_intent",
  label: "AI intent (optional)",
  type: "text",
  placeholder: "e.g. check in on their move timeline",
  help: "Set this and the copy is generated per contact from their persona instead of using the fixed text below.",
}

export const STEP_PALETTE: ReadonlyArray<StepTypeSpec> = [
  // ── deliver ────────────────────────────────────────────────────────────────
  {
    channel: "email", label: "Send Email", group: "deliver", icon: "Mail", flagKey: null,
    description: "Sends an email to the contact.",
    fields: [
      { name: "subject", label: "Subject", type: "text", required: true },
      { name: "body", label: "Body", type: "textarea", required: true },
      AI_INTENT,
    ],
  },
  {
    channel: "sms", label: "Send SMS", group: "deliver", icon: "MessageSquare", flagKey: null,
    description: "Sends a text message. Requires consent — the executor's TCPA gate blocks it otherwise.",
    fields: [
      { name: "body", label: "Message", type: "textarea", required: true },
      AI_INTENT,
    ],
  },
  {
    channel: "voice_drop", label: "Voicemail Drop", group: "deliver", icon: "Phone", flagKey: null,
    description: "Leaves a ringless voicemail in the contact's inbox. Their phone never rings.",
    fields: [
      { name: "voice_drop_script", label: "Script", type: "textarea", required: true },
      { name: "voice_drop_voice_id", label: "Voice", type: "text", help: "Leave blank to use the agent's cloned voice." },
    ],
  },
  {
    channel: "ai_call", label: "AI Call", group: "deliver", icon: "PhoneCall", flagKey: null,
    description: "Places a live outbound AI call. Never runs for an unconsented lead.",
    fields: [
      { name: "body", label: "Call objective", type: "textarea", required: true, help: "What the AI should accomplish on the call." },
    ],
  },
  {
    channel: "in_app", label: "In-App Message", group: "deliver", icon: "Layers", flagKey: null,
    description: "Posts a message into the contact's conversation thread in the portal.",
    fields: [{ name: "body", label: "Message", type: "textarea", required: true }],
  },
  {
    channel: "direct_mail", label: "Direct Mail", group: "deliver", icon: "Send", flagKey: "direct_mail_campaigns",
    description: "Prints and mails a physical piece to the contact's address.",
    fields: [
      {
        name: "direct_mail_piece_type", label: "Piece", type: "select", options: [
          { value: "postcard", label: "Postcard" },
          { value: "letter", label: "Letter" },
          { value: "notecard", label: "Notecard" },
        ],
      },
      { name: "direct_mail_template_id", label: "Template", type: "text" },
      { name: "qr_attached", label: "Print a QR code on it", type: "boolean" },
      { name: "qr_label", label: "QR label", type: "text" },
      { name: "qr_target_url_pattern", label: "QR destination", type: "url" },
    ],
  },
  {
    channel: "newsletter", label: "Send Newsletter", group: "deliver", icon: "Newspaper", flagKey: null,
    description: "Sends the brokerage newsletter, assembled from the sections you choose.",
    fields: [
      { name: "subject", label: "Subject", type: "text", required: true },
      { name: "newsletter_template_id", label: "Template", type: "uuid" },
      { name: "newsletter_section_ids", label: "Sections", type: "csv", help: "Comma-separated section IDs, in order." },
      { name: "body", label: "Intro copy", type: "textarea" },
      { name: "qr_attached", label: "Include a QR code", type: "boolean" },
    ],
  },

  // ── publish ────────────────────────────────────────────────────────────────
  {
    channel: "social_post", label: "Publish Social Post", group: "publish", icon: "Share2", flagKey: null,
    description: "Queues a post to the omnipresence engine for the chosen platform.",
    fields: [
      {
        name: "social_platform", label: "Platform", type: "select", required: true, options: [
          { value: "facebook", label: "Facebook" },
          { value: "instagram", label: "Instagram" },
          { value: "linkedin", label: "LinkedIn" },
          { value: "tiktok", label: "TikTok" },
          { value: "youtube", label: "YouTube" },
        ],
      },
      { name: "social_caption_prompt", label: "Caption prompt", type: "textarea", help: "Set this to have the caption written per post; otherwise the body below is used verbatim." },
      { name: "body", label: "Caption", type: "textarea" },
      {
        name: "social_image_source", label: "Image", type: "select", options: [
          { value: "step_output", label: "From an earlier step ({{step_N.image_url}})" },
          { value: "media_library", label: "Brokerage media library" },
          { value: "ai_generate", label: "Generate a new one" },
          { value: "listing_photo", label: "First listing photo" },
        ],
      },
    ],
  },
  {
    channel: "ad_campaign", label: "Launch Ad Campaign", group: "publish", icon: "Megaphone", flagKey: null,
    description: "Creates and launches a paid campaign on the chosen platform.",
    fields: [
      {
        name: "ad_platform", label: "Platform", type: "select", required: true, options: [
          { value: "facebook", label: "Facebook" },
          { value: "instagram", label: "Instagram" },
          { value: "google", label: "Google" },
          { value: "linkedin", label: "LinkedIn" },
          { value: "tiktok", label: "TikTok" },
        ],
      },
      {
        name: "ad_objective", label: "Objective", type: "select", options: [
          { value: "leads", label: "Leads" },
          { value: "traffic", label: "Traffic" },
          { value: "awareness", label: "Awareness" },
          { value: "conversions", label: "Conversions" },
        ],
      },
      { name: "ad_budget_cents", label: "Budget (cents)", type: "number", required: true },
      { name: "ad_audience_prompt", label: "Audience", type: "textarea", help: "Described in plain words; the ad builder turns it into targeting." },
    ],
  },
  {
    channel: "listing_landing_page", label: "Publish Listing Page", group: "publish", icon: "Globe", flagKey: null,
    description: "Publishes a single-property landing page.",
    fields: [
      { name: "listing_page_template_id", label: "Template", type: "uuid" },
      { name: "listing_page_slug", label: "URL slug", type: "text", placeholder: "123-main-st" },
    ],
  },

  // ── produce (contacts nobody — output feeds a later step) ──────────────────
  {
    channel: "video", label: "Produce Video", group: "produce", icon: "Video", flagKey: "video_campaigns",
    description: "Renders a talking-avatar video in the agent's cloned voice. Delivers nothing on its own — send it with a later Email or SMS step using {{step_N.video_url}}.",
    fields: [
      { name: "video_script", label: "Script", type: "textarea", required: true },
      { name: "video_template_id", label: "Template", type: "text" },
      { name: "video_voice_only", label: "Voice only (no avatar)", type: "boolean" },
      { name: "video_intro_url", label: "Intro clip", type: "url" },
      { name: "video_outro_url", label: "Outro clip", type: "url" },
      { name: "video_broll_urls", label: "B-roll clips", type: "csv" },
      { name: "video_background_url", label: "Background", type: "url" },
      { name: "video_logo_url", label: "Logo overlay", type: "url" },
      { name: "output_variable_name", label: "Output name", type: "text", help: "Later steps reference it as {{<name>.video_url}}." },
    ],
  },
  {
    channel: "ai_image", label: "Generate Image", group: "produce", icon: "Image", flagKey: null,
    description: "Generates an image for a later post or email to use.",
    fields: [
      { name: "image_prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "image_style", label: "Style", type: "select", options: [
          { value: "vivid", label: "Vivid" },
          { value: "natural", label: "Natural" },
        ],
      },
      {
        name: "image_aspect_ratio", label: "Aspect ratio", type: "select", options: [
          { value: "1:1", label: "Square (1:1)" },
          { value: "16:9", label: "Landscape (16:9)" },
          { value: "9:16", label: "Portrait (9:16)" },
        ],
      },
      { name: "output_variable_name", label: "Output name", type: "text" },
    ],
  },
  {
    channel: "avm_cma", label: "Build Valuation", group: "produce", icon: "TrendingUp", flagKey: null,
    description: "Builds an AVM, CMA or market report for the contact's property.",
    fields: [
      {
        name: "avm_report_type", label: "Report", type: "select", options: [
          { value: "avm", label: "AVM (automated value)" },
          { value: "cma", label: "CMA (comparative analysis)" },
          { value: "market_report", label: "Market report" },
        ],
      },
      {
        name: "avm_data_source", label: "Data source", type: "select", options: [
          { value: "perplexity", label: "Perplexity" },
          { value: "housecannary", label: "HouseCanary" },
          { value: "batchdata", label: "BatchData" },
        ],
      },
      { name: "avm_include_investor_adj", label: "Include investor adjustment", type: "boolean" },
      { name: "output_variable_name", label: "Output name", type: "text" },
    ],
  },
  {
    channel: "draft_document", label: "Draft Document", group: "produce", icon: "FileText", flagKey: null,
    description: "Drafts a document from a template. It is created for review, not sent.",
    fields: [
      {
        name: "document_type", label: "Document", type: "select", required: true, options: [
          { value: "offer", label: "Offer" },
          { value: "listing_agreement", label: "Listing agreement" },
          { value: "invoice", label: "Invoice" },
          { value: "market_report", label: "Market report" },
          { value: "avm_cma", label: "AVM / CMA" },
          { value: "custom", label: "Custom" },
        ],
      },
      { name: "document_template_id", label: "Template", type: "uuid" },
      { name: "document_state", label: "State forms", type: "text", help: "Two-letter code. Blank uses the transaction's state." },
      { name: "body", label: "Instructions", type: "textarea" },
    ],
  },

  // ── transact ───────────────────────────────────────────────────────────────
  {
    channel: "schedule_showing", label: "Schedule Showing", group: "transact", icon: "Calendar", flagKey: null,
    description: "Books a showing on a property for the contact.",
    fields: [
      { name: "showing_property_id", label: "Property", type: "uuid" },
      { name: "showing_external_source", label: "External source", type: "text", help: "For a property outside the brokerage's own listings." },
      { name: "tour_date_offset_days", label: "Days from now", type: "number", notNull: true, fallback: 0 },
      { name: "showing_duration_minutes", label: "Duration (minutes)", type: "number", notNull: true, fallback: 30 },
      { name: "showing_notes", label: "Notes", type: "textarea" },
    ],
  },
  {
    channel: "schedule_tour", label: "Schedule Tour", group: "transact", icon: "Route", flagKey: null,
    description: "Builds a multi-property tour route for the contact.",
    fields: [
      { name: "tour_property_ids", label: "Properties", type: "uuid_csv", required: true, help: "Property IDs, in the order you want them visited." },
      { name: "tour_start_address", label: "Start address", type: "text" },
      { name: "tour_date_offset_days", label: "Days from now", type: "number", notNull: true, fallback: 0 },
    ],
  },
  {
    channel: "send_for_esign", label: "Send for E-Signature", group: "transact", icon: "PenTool", flagKey: null,
    description: "Sends a document out for signature through the connected e-sign provider.",
    fields: [
      { name: "esign_document_id", label: "Document", type: "uuid", help: "Blank uses the latest approved document on the deal." },
      {
        name: "esign_recipient", label: "Recipient", type: "select", options: [
          { value: "contact", label: "The contact" },
          { value: "seller", label: "Seller" },
          { value: "buyer", label: "Buyer" },
          { value: "lender", label: "Lender" },
          { value: "opposing_agent", label: "Opposing agent" },
        ],
      },
      { name: "esign_provider", label: "Provider override", type: "text" },
      { name: "esign_subject", label: "Subject", type: "text" },
      { name: "esign_message", label: "Message", type: "textarea" },
    ],
  },
  {
    channel: "send_gift", label: "Send Gift", group: "transact", icon: "Gift", flagKey: null,
    description: "Sends a closing or milestone gift through a gifting vendor.",
    fields: [
      {
        name: "gift_occasion", label: "Occasion", type: "select", required: true, options: [
          { value: "closing", label: "Closing" },
          { value: "birthday", label: "Birthday" },
          { value: "anniversary", label: "Home anniversary" },
          { value: "referral_thank_you", label: "Referral thank-you" },
          { value: "just_because", label: "Just because" },
        ],
      },
      { name: "gift_amount_cents", label: "Budget (cents)", type: "number" },
      { name: "gift_provider_id", label: "Vendor", type: "uuid", help: "Blank lets the OS recommend one." },
      { name: "gift_custom_note", label: "Note", type: "textarea" },
      { name: "gift_recipient_address", label: "Ship to", type: "text" },
      { name: "gift_auto_pay", label: "Pay automatically", type: "boolean" },
    ],
  },

  // ── flow ───────────────────────────────────────────────────────────────────
  {
    channel: "wait", label: "Wait", group: "flow", icon: "Clock", flagKey: null,
    description: "Pauses before the next step.",
    fields: [],
  },
  {
    channel: "condition", label: "Condition", group: "flow", icon: "GitBranch", flagKey: null,
    description: "Continues only when the contact matches. Otherwise the sequence stops here.",
    fields: [
      { name: "condition_field", label: "Field", type: "text", required: true },
      {
        name: "condition_operator", label: "Is", type: "select", options: [
          { value: "equals", label: "equal to" },
          { value: "not_equals", label: "not equal to" },
          { value: "contains", label: "containing" },
          { value: "greater_than", label: "greater than" },
          { value: "less_than", label: "less than" },
          { value: "is_set", label: "set" },
          { value: "is_not_set", label: "not set" },
        ],
      },
      { name: "condition_value", label: "Value", type: "text" },
    ],
  },
  {
    channel: "assign_task", label: "Assign Task", group: "flow", icon: "CheckSquare", flagKey: null,
    description: "Creates a CRM task for a person on the deal.",
    fields: [
      { name: "task_title", label: "Task", type: "text", required: true },
      {
        name: "task_assignee_type", label: "Assign to", type: "select", options: [
          { value: "agent", label: "The contact's agent" },
          { value: "staff", label: "A staff member" },
          { value: "tc", label: "Transaction coordinator" },
          { value: "lender", label: "Lender" },
          { value: "vendor", label: "Vendor" },
          { value: "compliance_officer", label: "Compliance officer" },
          { value: "any_brokerage_member", label: "First available" },
        ],
      },
      { name: "task_assignee_id", label: "Specific person", type: "uuid", help: "Blank resolves by role." },
      { name: "task_due_offset_days", label: "Due in (days)", type: "number", notNull: true, fallback: 0 },
      { name: "task_notes_prompt", label: "Notes", type: "textarea" },
    ],
  },
  {
    channel: "add_to_segment", label: "Add to Segment", group: "flow", icon: "Tag", flagKey: null,
    description: "Adds the contact to a segment.",
    fields: [{ name: "body", label: "Segment", type: "text", required: true }],
  },
  {
    channel: "remove_from_campaign", label: "Remove from Campaign", group: "flow", icon: "UserMinus", flagKey: null,
    description: "Takes the contact out of this campaign. Nothing after this step runs.",
    fields: [{ name: "body", label: "Reason", type: "text" }],
  },
]

/** PURE — the spec for a channel, or undefined if it is not a known step type. */
export function stepSpec(channel: string): StepTypeSpec | undefined {
  return STEP_PALETTE.find((s) => s.channel === channel)
}

/** PURE — every channel the palette offers. */
export function paletteChannels(): string[] {
  return STEP_PALETTE.map((s) => s.channel)
}

/** PURE — the palette in render order, grouped. Empty groups are omitted. */
export function paletteByGroup(): Array<{ group: StepGroup; label: string; help: string; steps: StepTypeSpec[] }> {
  const order: StepGroup[] = ["deliver", "publish", "produce", "transact", "flow"]
  return order
    .map((group) => ({
      group,
      label: STEP_GROUP_LABELS[group],
      help: STEP_GROUP_HELP[group],
      steps: STEP_PALETTE.filter((s) => s.group === group),
    }))
    .filter((g) => g.steps.length > 0)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** PURE — is this value one the COLUMN cannot store? Empty is never invalid;
 *  that is what `required` is for. */
export function isInvalidValue(field: StepFieldSpec, value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false
  if (field.type === "uuid") {
    return typeof value !== "string" || !UUID_RE.test(value.trim())
  }
  if (field.type === "uuid_csv") {
    const list = Array.isArray(value)
      ? (value as unknown[])
      : String(value).split(",").map((p) => p.trim()).filter(Boolean)
    return list.some((v) => typeof v !== "string" || !UUID_RE.test(v.trim()))
  }
  if (field.type === "number") {
    return typeof value === "number" ? !Number.isFinite(value) : Number.isNaN(Number(value))
  }
  return false
}

/**
 * PURE — fields whose value the column would REJECT. Seven of these columns are
 * `uuid` and tour_property_ids is `uuid[]`; without this a typo reaches Postgres
 * and comes back as "invalid input syntax for type uuid", which tells a broker
 * nothing and loses the whole save.
 */
export function invalidFields(
  channel: string,
  values: Record<string, unknown>,
): StepFieldSpec[] {
  const spec = stepSpec(channel)
  if (!spec) return []
  return spec.fields.filter((f) => isInvalidValue(f, values[f.name]))
}

/**
 * PURE — the value to WRITE for a field. A NOT NULL integer column
 * (showing_duration_minutes, task_due_offset_days, tour_date_offset_days) must
 * never receive null just because the broker cleared the box.
 */
export function storableValue(field: StepFieldSpec, value: unknown): unknown {
  if (value === undefined || value === "" || value === null) {
    return field.notNull ? (field.fallback ?? 0) : null
  }
  return value
}

/**
 * PURE — the required fields a step is missing. The builder shows this before
 * save, so a step cannot be persisted in a shape its adapter will refuse at
 * dispatch time (an ad with no platform, a tour with no properties).
 */
export function missingRequiredFields(
  channel: string,
  values: Record<string, unknown>,
): StepFieldSpec[] {
  const spec = stepSpec(channel)
  if (!spec) return []
  return spec.fields.filter((f) => {
    if (!f.required) return false
    const v = values[f.name]
    if (v === null || v === undefined) return true
    if (typeof v === "string") return v.trim() === ""
    if (Array.isArray(v)) return v.length === 0
    return false
  })
}
