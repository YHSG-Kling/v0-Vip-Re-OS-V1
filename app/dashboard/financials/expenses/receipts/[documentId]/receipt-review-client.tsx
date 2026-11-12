"use client"

// THE SIDE-BY-SIDE RECEIPT REVIEW (wave 152, lane 152D). Left: the receipt itself (a short-lived signed image, minted
// for this viewer) and the page the selected value was read from, with the quoted words highlighted. Right: the
// proposal — every value with its page, whether its words were found there, its confidence and why it is uncertain —
// plus the problems, possible duplicates, the books it goes on, and correction controls. Approve sends the corrected
// values to approveReceiptExpense (the one expense writer, the reviewer as the actor); Decline records nothing.
// No coordinates exist (the reader returns text), so the highlight is on the page's words — never an invented box.

import { useMemo, useState, Fragment } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertTriangle, CheckCircle2, Loader2, FileText } from "lucide-react"
import { approveReceiptExpense, rejectReceiptExpense } from "@/app/actions/financials"
import type { getReceiptReview } from "@/app/actions/financials"
import { EXPENSE_CATEGORIES } from "@/lib/documents/receipt-rules"

type Review = Extract<Awaited<ReturnType<typeof getReceiptReview>>, { ok: true }>["review"]
interface Message { whatHappened: string; whatItAffects: string; saved: string; whoActs: string; action: string }

const UNCERTAINTY: Record<string, string> = {
  not_shown_on_document: "Not shown on the receipt",
  value_not_in_a_recognizable_format: "Could not be read as a clear value",
  excerpt_not_found_on_page: "The quoted words were not found on the page",
  no_excerpt_cited: "No source words were given",
  year_not_shown: "No year is printed",
  date_not_in_excerpt: "The date is not in the quoted words",
  amount_not_in_excerpt: "The amount is not in the quoted words",
  kind_tightened_by_balance_due: "A balance is still due, so it is treated as unpaid",
  kind_not_recognized: "The document type was not recognized",
  no_category_signal_on_receipt: "Nothing on the receipt suggests a category",
  not_read: "Not read",
}

const display = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "number" ? v.toFixed(2) : String(v))

type FieldRow = Review["fields"][number]
const KINDS = ["receipt", "paid_invoice", "payment_proof", "refund", "credit_memo", "invoice_due", "statement", "quote", "not_financial"]

/** Where a value came from: a person, its page (words found there), or why it is uncertain. */
function Source({ f }: { f: FieldRow }) {
  return (
    <>
      {f.readBy === "human" ? <span className="text-muted-foreground">entered by a person</span>
        : f.evidenceLocated ? <span className="inline-flex items-center gap-1 text-green-700"><CheckCircle2 className="w-3 h-3" /> page {f.page}</span>
        : <span className="text-amber-700">{UNCERTAINTY[f.uncertainty ?? ""] ?? f.uncertainty ?? "Unconfirmed"}</span>}
      <span className="block text-muted-foreground">{f.confidence} confidence</span>
    </>
  )
}

/** The correction control for one value — a picker for the type and category, free entry otherwise. */
function Correction({ f, edits, setEdits }: { f: FieldRow; edits: Record<string, string>; setEdits: (e: Record<string, string>) => void }) {
  if (f.key === "expense.category") {
    return (
      <select aria-label="Category" className="h-9 rounded border bg-background text-xs" value={edits[f.key] ?? String(f.value ?? "other")} onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })}>
        {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    )
  }
  if (f.key === "expense.document_kind") {
    return (
      <select aria-label="Document type" className="h-9 rounded border bg-background text-xs" value={edits[f.key] ?? String(f.value ?? "")} onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })}>
        {KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
      </select>
    )
  }
  return <Input aria-label={`Correct ${f.label}`} className="h-9 text-xs" placeholder={f.key === "expense.date" ? "YYYY-MM-DD" : "Type a correction"} value={edits[f.key] ?? ""} onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })} />
}

function Highlighted({ text, excerpt }: { text: string; excerpt: string | null }) {
  if (!excerpt) return <>{text}</>
  const i = text.toLowerCase().indexOf(excerpt.toLowerCase())
  if (i < 0) return <>{text}</>
  return <>{text.slice(0, i)}<mark className="bg-yellow-200 dark:bg-yellow-700">{text.slice(i, i + excerpt.length)}</mark>{text.slice(i + excerpt.length)}</>
}

export function ReceiptReviewClient({ review }: { review: Review }) {
  const router = useRouter()
  const firstEvidenced = review.fields.find((f) => f.page)?.key ?? null
  const [selected, setSelected] = useState<string | null>(firstEvidenced)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [scope, setScope] = useState<string>(review.proposedScope ?? "agent")
  const [confirmNotDuplicate, setConfirmNotDuplicate] = useState(false)
  const [reversalOf, setReversalOf] = useState("")
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [reasons, setReasons] = useState<string[]>([])

  const done = review.state === "posted" || review.state === "rejected"
  const sel = review.fields.find((f) => f.key === selected) ?? null
  const page = useMemo(() => {
    const n = sel?.page ?? 1
    return review.pages.find((p) => p.page === n) ?? review.pages[0] ?? null
  }, [sel, review.pages])
  const isImage = review.storage.mime.startsWith("image/")
  const isPdf = review.storage.mime === "application/pdf"

  async function approve() {
    setBusy("approve"); setMessage(null); setReasons([])
    const corrections = Object.fromEntries(Object.entries(edits).filter(([, v]) => v.trim() !== ""))
    const r = await approveReceiptExpense({ documentId: review.documentId, corrections, scope: scope as "agent" | "team" | "brokerage", confirmNotDuplicate, reversalOfExpenseId: reversalOf.trim() || null })
    setMessage(r.message); setReasons(r.reasons ?? [])
    setBusy(null)
    if (r.ok) router.refresh()
  }
  async function reject() {
    setBusy("reject"); setMessage(null); setReasons([])
    const r = await rejectReceiptExpense({ documentId: review.documentId })
    setMessage(r.message); setReasons(r.reasons ?? [])
    setBusy(null)
    if (r.ok) router.refresh()
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* ── LEFT: the document and the page the selected value came from ── */}
      <div className="space-y-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" /> The receipt</CardTitle>
            {review.qualityFlags.length > 0 && <CardDescription>Photo quality: {review.qualityFlags.join(", ").replace(/_/g, " ")} — values were graded down for it.</CardDescription>}
          </CardHeader>
          <CardContent>
            {review.imageUrl && isImage && <img src={review.imageUrl} alt="Scanned receipt" className="max-h-[520px] w-full rounded border object-contain" />}
            {review.imageUrl && isPdf && <iframe src={review.imageUrl} title="Receipt PDF" className="h-[520px] w-full rounded border" />}
            {!review.imageUrl && <p className="text-sm text-muted-foreground">The original file could not be shown right now; the words read from it are below.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Page {page?.page ?? 1} — what was read{sel ? `, showing “${sel.label}”` : ""}</CardTitle>
            <CardDescription>{review.readBy === "vision" ? "Read from the image." : review.readBy === "native_text" ? "Taken from the file's own text." : ""}</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-xs"><Highlighted text={page?.text ?? ""} excerpt={sel?.excerpt ?? null} /></pre>
          </CardContent>
        </Card>
      </div>

      {/* ── RIGHT: the proposal ── */}
      <div className="space-y-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">{review.kindLabel} <Badge variant="outline">{review.state.replace(/_/g, " ")}</Badge></CardTitle>
            {review.summary && <CardDescription>AI summary (a reading aid, not a record): {review.summary}</CardDescription>}
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {review.issues.length > 0 && (
              <ul className="space-y-1">
                {review.issues.map((i) => (
                  <li key={i.code} className={i.blocking ? "text-destructive flex gap-1" : "text-muted-foreground flex gap-1"}>
                    <AlertTriangle className="w-4 h-4 shrink-0" /> {i.message}{i.blocking ? " (needs a fix before recording)" : ""}
                  </li>
                ))}
              </ul>
            )}
            {review.duplicates.exactFile && <p className="text-destructive">This exact file was already uploaded{review.duplicates.exactFile.postedExpenseId ? " and recorded" : ""}.</p>}
            {review.duplicates.sameCharge.length > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 p-2 dark:bg-amber-950/30">
                <p>Already recorded with the same merchant, date and total:</p>
                <ul className="ml-4 list-disc">{review.duplicates.sameCharge.map((d) => <li key={d.expenseId}>{d.description} — ${d.amount.toFixed(2)} on {d.expenseDate}</li>)}</ul>
                {!done && <label className="mt-1 flex items-center gap-2"><input type="checkbox" checked={confirmNotDuplicate} onChange={(e) => setConfirmNotDuplicate(e.target.checked)} /> This is a different purchase — record it anyway</label>}
              </div>
            )}
            {review.transactionLink && <p className="text-muted-foreground">Deal link: {review.transactionLink.verdict === "evidenced" ? "linked — the receipt shows the property address" : "not linked — the receipt does not show that property's address"}.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">What was read</CardTitle><CardDescription>Click a row to see where it came from. Type a correction to replace a value.</CardDescription></CardHeader>
          <CardContent>
            {/* Phone: one card per value (the page evidence and the correction stay together). */}
            <div className="space-y-2 md:hidden">
              {review.fields.map((f) => (
                <div key={f.key} onClick={() => setSelected(f.key)} className={`rounded border p-2 text-sm ${selected === f.key ? "bg-muted/50" : ""}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{f.label}</span>
                    <span>{display(f.value)}</span>
                  </div>
                  {f.correctedFrom !== null && <p className="text-xs text-muted-foreground">was {display(f.correctedFrom)}</p>}
                  <p className="text-xs"><Source f={f} /></p>
                  {!done && <div className="mt-1" onClick={(e) => e.stopPropagation()}><Correction f={f} edits={edits} setEdits={setEdits} /></div>}
                </div>
              ))}
            </div>
            {/* Tablet / desktop: the same values as a table. */}
            <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1">Field</th><th>Read</th><th>Source</th><th>Correction</th></tr></thead>
              <tbody>
                {review.fields.map((f) => (
                  <tr key={f.key} onClick={() => setSelected(f.key)} className={`border-t align-top cursor-pointer ${selected === f.key ? "bg-muted/50" : ""}`}>
                    <td className="py-1 pr-2 font-medium">{f.label}</td>
                    <td className="pr-2">
                      {display(f.value)}
                      {f.correctedFrom !== null && <span className="block text-xs text-muted-foreground">was {display(f.correctedFrom)}</span>}
                    </td>
                    <td className="pr-2 text-xs"><Source f={f} /></td>
                    <td onClick={(e) => e.stopPropagation()}>{!done && <Correction f={f} edits={edits} setEdits={setEdits} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {review.lineItems.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <p className="text-xs font-medium text-muted-foreground">Line items</p>
                <table className="w-full text-xs">
                  <tbody>
                    {review.lineItems.map((li, i) => (
                      <Fragment key={i}>
                        <tr className="border-t"><td className="py-0.5">{li.description ?? "—"}</td><td>{li.quantity ?? ""}</td><td>{li.amount === null ? "—" : `$${li.amount.toFixed(2)}`}</td><td className={li.evidence_located ? "text-green-700" : "text-amber-700"}>{li.evidence_located ? `page ${li.page}` : "not found on page"}</td></tr>
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {!done && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Record it</CardTitle><CardDescription>Nothing is on your books until you approve.</CardDescription></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="space-y-1">
                <Label htmlFor="receipt-scope">Whose books</Label>
                <select id="receipt-scope" className="h-8 w-full rounded border bg-background" value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="agent">My book (agent)</option>
                  <option value="team">My team</option>
                  {review.canPostBrokerage && <option value="brokerage">The brokerage</option>}
                </select>
              </div>
              {review.postingClass === "reversal" && (
                <div className="space-y-1">
                  <Label htmlFor="receipt-reversal">The expense this refund reverses</Label>
                  <Input id="receipt-reversal" placeholder="Expense ID from your expenses list" value={reversalOf} onChange={(e) => setReversalOf(e.target.value)} />
                </div>
              )}
              <div className="flex gap-2">
                <Button onClick={approve} disabled={busy !== null}>{busy === "approve" && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Approve and record</Button>
                <Button variant="outline" onClick={reject} disabled={busy !== null}>{busy === "reject" && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Decline</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {(message || done) && (
          <div role="status" className="rounded-lg border p-3 text-sm space-y-1">
            <p className="font-medium">{(message ?? review.message).whatHappened}</p>
            <p className="text-muted-foreground">{(message ?? review.message).whatItAffects} {(message ?? review.message).saved}</p>
            {reasons.length > 1 && <ul className="ml-4 list-disc text-muted-foreground">{reasons.slice(1).map((r) => <li key={r}>{r}</li>)}</ul>}
            <p className="text-muted-foreground">{(message ?? review.message).whoActs}</p>
            <a className="text-blue-600 hover:underline" href="/dashboard/financials/expenses">{(message ?? review.message).action}</a>
          </div>
        )}
      </div>
    </div>
  )
}
