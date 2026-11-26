/**
 * lib/forms/form-document-reader.ts — THE AI FORM READER PROPOSES, WITH EVIDENCE; A PERSON DECIDES (wave 156, lane 156C).
 *
 * Owner (wave 156): "AI document readers should identify fields, legal description, governing clauses, signer boxes and requirements
 * with evidence per field; offer reviewable prefill into the existing FormWizard rather than inventing fill values. The agent actually
 * fills CDA; no AI CDA auto-fill, per owner ruling."
 *
 * THE SAME SHAPE AS THE INTAKE COACH (lib/forms/intake-from-notes.ts): deterministic reading first (the PDF's own AcroForm — field
 * names and signature boxes are FACTS of the file, not guesses), a routed MODEL ASSIST for what only reading the text can find (legal
 * description, governing clauses, requirements), and a VERIFIER every model proposal must pass:
 *   · it carries an EVIDENCE quote that appears in the document's own text (whitespace / case normalised);
 *   · a proposed prefill VALUE must be a verbatim span of that quote — the reader transcribes, it does not compute or compose;
 *   · a prefill target must be a field that exists in the PDF;
 *   · nothing is applied: every surviving proposal is `pending_review` for the FormWizard's existing review step.
 * A Commission Disbursement Authorization (CDA) is refused outright — the agent fills the CDA (standing owner ruling).
 * Spend is booked through generateObjectRouted on the existing `offer_data_extraction` key (no new route, no new vendor).
 */

import { z } from "zod"
// isCdaForm — the ONE CDA detector — lives in lib/forms/form-read-apply.ts (pure; the FormWizard client imports it too).
import { isCdaForm } from "./form-read-apply"

export { isCdaForm }

export const DOCUMENT_READ_KINDS = ["field", "legal_description", "clause", "signer_box", "requirement"] as const
export type DocumentReadKind = (typeof DOCUMENT_READ_KINDS)[number]
export const DOCUMENT_TEXT_MAX_CHARS = 24000

export interface DocumentReadProposal {
  kind: DocumentReadKind
  /** The PDF field this proposal would prefill (kind "field"), or a label. */
  target: string
  /** The proposed prefill value (kind "field" / "legal_description" only). */
  value?: string | null
  evidence: { page?: number | null; quote: string }
}

export interface DocumentReadResult {
  ok: boolean
  refused?: string
  /** Facts of the file: every fillable field and every signature / initials box. */
  structure: { fields: string[]; signerBoxes: string[] }
  /** Proposals that passed the verifier — each awaits a person in the FormWizard review step. */
  suggestions: Array<DocumentReadProposal & { status: "pending_review"; via: "structure" | "model" }>
  dropped: Array<{ proposal: DocumentReadProposal; why: string }>
  notes: string[]
}


const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()

/** PURE: signature / initials boxes among the PDF's field names. */
function signerBoxesFrom(fields: readonly string[]): string[] {
  return fields.filter((f) => /(^|[^a-z])(sig|sign|signature|initial|initials)([^a-z]|$)/i.test(f.replace(/([a-z])([A-Z])/g, "$1 $2")))
}

/** PURE: the verifier. Only what the document itself states survives, and nothing is applied. */
function verifyDocumentReadProposals(text: string, fields: readonly string[], proposals: DocumentReadProposal[]): { kept: DocumentReadProposal[]; dropped: Array<{ proposal: DocumentReadProposal; why: string }> } {
  const hay = norm(text)
  const fieldSet = new Set(fields)
  const kept: DocumentReadProposal[] = []
  const dropped: Array<{ proposal: DocumentReadProposal; why: string }> = []
  for (const p of proposals) {
    const quote = norm(p.evidence?.quote ?? "")
    if (!(DOCUMENT_READ_KINDS as readonly string[]).includes(p.kind)) { dropped.push({ proposal: p, why: "unknown kind" }); continue }
    if (quote.length < 4) { dropped.push({ proposal: p, why: "no evidence quote" }); continue }
    if (!hay.includes(quote)) { dropped.push({ proposal: p, why: "the quote is not in the document" }); continue }
    if (p.kind === "field" && !fieldSet.has(p.target)) { dropped.push({ proposal: p, why: `the PDF has no field "${p.target}"` }); continue }
    if (p.value != null && p.value !== "") {
      if (p.kind !== "field" && p.kind !== "legal_description") { dropped.push({ proposal: p, why: "only a field or the legal description carries a value" }); continue }
      if (!quote.includes(norm(p.value))) { dropped.push({ proposal: p, why: "the value is not stated in its evidence (the reader transcribes, it does not compose)" }); continue }
    }
    kept.push(p)
  }
  return { kept, dropped }
}

const MODEL_SCHEMA = z.object({
  proposals: z.array(z.object({
    kind: z.enum(DOCUMENT_READ_KINDS),
    target: z.string().max(200),
    value: z.string().max(2000).nullable().optional(),
    evidence: z.object({ page: z.number().int().nullable().optional(), quote: z.string().max(2000) }),
  })).max(80),
})

const SYSTEM = [
  "You read a real-estate form's text. Identify: the legal description, governing clauses, requirements the form imposes, and for any fillable field whose value the document itself already states, that value.",
  "For EVERY item quote the exact words of the document in `evidence.quote`.",
  "Never compute, convert, summarise or improve wording. A value must be copied verbatim from the quote. If the document does not state it, omit it.",
  "Never propose a signature, an initial, a price or a date that is not printed in the document.",
].join(" ")

export interface DocumentReaderDeps {
  generate?: (args: { system: string; prompt: string; brokerageId: string; userId: string | null }) => Promise<{ proposals: DocumentReadProposal[] }>
}

async function routedGenerate(args: { system: string; prompt: string; brokerageId: string; userId: string | null }): Promise<{ proposals: DocumentReadProposal[] }> {
  const { generateObjectRouted } = await import("@/lib/ai/models")
  const { object } = await generateObjectRouted({
    feature: "offer_data_extraction", brokerageId: args.brokerageId, userId: args.userId,
    system: args.system, prompt: args.prompt, maxTokens: 2000, temperature: 0, schema: MODEL_SCHEMA,
  })
  return { proposals: (object as z.infer<typeof MODEL_SCHEMA>).proposals as DocumentReadProposal[] }
}

/**
 * Read a form. `fields` are the PDF's AcroForm names (lib/forms/pdf-form-fill.ts listPdfFields), `text` its extracted text. The
 * tenant is the SESSION's (the route resolves it); with no tenant the model assist is skipped and the structure still answers.
 */
export async function readFormDocument(
  input: { name: string; formCode?: string | null; fields: string[]; text: string; brokerageId: string | null; userId: string | null },
  deps: DocumentReaderDeps = {},
): Promise<DocumentReadResult> {
  const structure = { fields: [...input.fields], signerBoxes: signerBoxesFrom(input.fields) }
  const result: DocumentReadResult = { ok: true, structure, suggestions: [], dropped: [], notes: [] }
  if (isCdaForm(input)) {
    return { ...result, ok: false, refused: "This is a Commission Disbursement Authorization — the agent fills the CDA; the AI reader does not prefill it.", structure: { fields: [], signerBoxes: [] } }
  }
  for (const box of structure.signerBoxes) result.suggestions.push({ kind: "signer_box", target: box, value: null, evidence: { quote: box }, status: "pending_review", via: "structure" })
  const text = (input.text ?? "").slice(0, DOCUMENT_TEXT_MAX_CHARS)
  if (text.trim().length < 40) { result.notes.push("The PDF has no readable text layer — only its fields and signature boxes were read."); return result }
  if (!input.brokerageId) { result.notes.push("Model assist skipped: no tenant to book the AI spend against."); return result }
  try {
    const prompt = [`Form: ${input.name}`, `Fillable fields: ${input.fields.slice(0, 300).join(", ")}`, "", `Document text:\n"""${text}"""`].join("\n")
    const gen = await (deps.generate ?? routedGenerate)({ system: SYSTEM, prompt, brokerageId: input.brokerageId, userId: input.userId })
    const v = verifyDocumentReadProposals(text, input.fields, gen.proposals ?? [])
    for (const p of v.kept) result.suggestions.push({ ...p, status: "pending_review", via: "model" })
    result.dropped.push(...v.dropped)
  } catch (err) {
    result.notes.push(`Model assist unavailable (${err instanceof Error ? err.message : "error"}) — only the file's structure was read.`)
  }
  return result
}


// The reviewer's accept step lives in lib/forms/form-read-apply.ts (pure, no model import — the FormWizard client bundles it).
export { applyAcceptedSuggestions } from "./form-read-apply"
