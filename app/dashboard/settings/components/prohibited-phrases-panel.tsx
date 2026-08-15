"use client"

/**
 * app/dashboard/settings/components/prohibited-phrases-panel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BROKERAGE'S OWN PROHIBITED WORDS — where a broker actually adds one.
 *
 * Owner's ruling: "the users can also add in their settings prohibited words."
 *
 * Rendered on TWO surfaces, both reached from the settings navigation:
 *   • /dashboard/settings           — the Settings Control Center grid, alongside
 *     Lead Routing and Showing Requirements. Broker + admin only (that page's gate).
 *   • /compliance/settings          — where the settings command strip's
 *     "Compliance" button already goes, and the ONLY compliance-settings surface a
 *     COMPLIANCE OFFICER can reach: /dashboard/settings redirects anyone whose
 *     user_type is not broker/admin, while RLS explicitly grants phrase writes to
 *     is_compliance_officer_role(). One surface would have locked out the role the
 *     database was written to admit.
 *
 * THE FEDERAL CATALOGUE IS SHOWN BUT NEVER OFFERED FOR EDITING. Its 25 rows carry
 * `brokerage_id IS NULL` and RLS refuses a tenant write against them — so drawing
 * an Edit button there would draw a button that cannot work. They are listed
 * because a broker adding words needs to see what is already covered, and because
 * the list being visible is the only way to notice if it ever goes empty.
 *
 * Severity is a THREE-WAY PICKER, never free text: `prohibited_phrases_severity_check`
 * admits {info, warning, critical} and nothing else. The labels say which one
 * actually stops content (only Critical does), because the scan grades
 * critical → blocking and the other two pass through.
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ShieldAlert, Plus, Trash2, Pencil, Lock, X, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import {
  PHRASE_SEVERITIES,
  PHRASE_SEVERITY_LABELS,
  PHRASE_SEVERITY_HELP,
  PHRASE_CATEGORIES,
  PHRASE_CATEGORY_LABELS,
  DEFAULT_PHRASE_SEVERITY,
  DEFAULT_PHRASE_CATEGORY,
  validateEffectivePhrasePattern,
  type PhraseSeverity,
} from "@/lib/compliance/phrase-vocabulary"
import {
  listCompliancePhrases,
  addCompliancePhrase,
  updateCompliancePhrase,
  deleteCompliancePhrase,
  type CompliancePhraseView,
} from "@/app/actions/compliance-phrases"

const EMPTY_DRAFT = {
  phrase: "",
  phrasePattern: "",
  category: DEFAULT_PHRASE_CATEGORY as string,
  severity: DEFAULT_PHRASE_SEVERITY as PhraseSeverity,
  suggestedAlternative: "",
  notes: "",
  isActive: true,
}

type Draft = typeof EMPTY_DRAFT

function severityBadgeVariant(severity: string): "destructive" | "secondary" | "outline" {
  if (severity === "critical") return "destructive"
  if (severity === "warning") return "secondary"
  return "outline"
}

function draftFrom(row: CompliancePhraseView): Draft {
  return {
    phrase: row.phrase,
    phrasePattern: row.phrasePattern ?? "",
    category: row.category ?? DEFAULT_PHRASE_CATEGORY,
    severity: (PHRASE_SEVERITIES as readonly string[]).includes(row.severity)
      ? (row.severity as PhraseSeverity)
      : DEFAULT_PHRASE_SEVERITY,
    suggestedAlternative: row.suggestedAlternative ?? "",
    notes: row.notes ?? "",
    isActive: row.isActive,
  }
}

export function ProhibitedPhrasesPanel({ className }: { className?: string }) {
  const [federal, setFederal] = useState<CompliancePhraseView[]>([])
  const [own, setOwn] = useState<CompliancePhraseView[]>([])
  const [canManage, setCanManage] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showFederal, setShowFederal] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [isPending, startTransition] = useTransition()

  const load = useCallback(async () => {
    const res = await listCompliancePhrases()
    setCanManage(res.canManage)
    if (!res.ok) {
      // A refusal is NOT an empty catalogue. Say which one happened.
      setLoadError(res.error ?? "The phrase catalogue could not be read.")
      setFederal([])
      setOwn([])
      setLoading(false)
      return
    }
    setLoadError(null)
    setFederal(res.federal)
    setOwn(res.own)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function resetForm() {
    setDraft(EMPTY_DRAFT)
    setAdding(false)
    setEditingId(null)
  }

  /** Same compile check the server runs and the scanner will run. Surfaced as the
   *  user types so a bad pattern is caught before a round trip. */
  const patternCheck = validateEffectivePhrasePattern(draft.phrase, draft.phrasePattern)
  const patternError = draft.phrase.trim() && !patternCheck.ok ? patternCheck.error : null

  function submit() {
    const payload = {
      phrase: draft.phrase,
      phrasePattern: draft.phrasePattern,
      category: draft.category,
      severity: draft.severity,
      suggestedAlternative: draft.suggestedAlternative,
      notes: draft.notes,
      isActive: draft.isActive,
    }
    startTransition(async () => {
      const res = editingId
        ? await updateCompliancePhrase(editingId, payload)
        : await addCompliancePhrase(payload)
      if (!res.ok) {
        toast.error(res.error ?? "The phrase could not be saved.")
        return
      }
      toast.success(
        editingId
          ? `Updated "${payload.phrase.trim()}".`
          : `"${payload.phrase.trim()}" is now on this brokerage's list.`,
      )
      resetForm()
      await load()
    })
  }

  function remove(row: CompliancePhraseView) {
    if (!window.confirm(`Remove "${row.phrase}" from this brokerage's prohibited words?`)) return
    startTransition(async () => {
      const res = await deleteCompliancePhrase(row.id)
      if (!res.ok) {
        toast.error(res.error ?? "The phrase could not be removed.")
        return
      }
      toast.success(`Removed "${row.phrase}".`)
      await load()
    })
  }

  const formOpen = adding || editingId !== null

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4" />
          Prohibited Words
        </CardTitle>
        <CardDescription>
          Words and phrases this brokerage will not allow in listing and marketing copy,
          on top of the federal Fair Housing list. Every piece of content is scanned
          against both before it can be approved.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {loadError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {/* ── THIS BROKERAGE'S OWN WORDS ─────────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              This brokerage&apos;s words
              {!loading && !loadError ? ` (${own.length})` : ""}
            </Label>
            {canManage && !formOpen && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(EMPTY_DRAFT)
                  setEditingId(null)
                  setAdding(true)
                }}
                disabled={isPending}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add a word
              </Button>
            )}
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : own.length === 0 && !loadError ? (
            <p className="text-sm text-muted-foreground">
              This brokerage has not added any words of its own. The federal Fair Housing
              list below still applies to every piece of content.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {own.map((row) => (
                <li key={row.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium break-words">{row.phrase}</span>
                      <Badge variant={severityBadgeVariant(row.severity)} className="text-[10px]">
                        {row.severity}
                      </Badge>
                      {!row.isActive && (
                        <Badge variant="outline" className="text-[10px]">paused</Badge>
                      )}
                    </div>
                    {row.phrasePattern && (
                      <p className="text-xs text-muted-foreground font-mono break-all">
                        /{row.phrasePattern}/gi
                      </p>
                    )}
                    {row.suggestedAlternative && (
                      <p className="text-xs text-muted-foreground break-words">
                        Suggest instead: {row.suggestedAlternative}
                      </p>
                    )}
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${row.phrase}`}
                        disabled={isPending}
                        onClick={() => {
                          setDraft(draftFrom(row))
                          setAdding(false)
                          setEditingId(row.id)
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${row.phrase}`}
                        disabled={isPending}
                        onClick={() => remove(row)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!loading && !canManage && !loadError && (
            <p className="text-xs text-muted-foreground">
              Adding or changing these words is limited to a broker, an admin or a
              compliance officer.
            </p>
          )}
        </div>

        {/* ── ADD / EDIT FORM ─────────────────────────────────────────────── */}
        {canManage && formOpen && (
          <div className="space-y-3 rounded-md border bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                {editingId ? "Edit prohibited word" : "Add a prohibited word"}
              </p>
              <Button size="sm" variant="ghost" onClick={resetForm} disabled={isPending}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="phrase-text">Word or phrase</Label>
              <Input
                id="phrase-text"
                value={draft.phrase}
                placeholder="e.g. guaranteed appreciation"
                onChange={(e) => setDraft((d) => ({ ...d, phrase: e.target.value }))}
                disabled={isPending}
              />
              <p className="text-xs text-muted-foreground">
                Required. With no match pattern below, the scan looks for this text
                directly, case-insensitively.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="phrase-severity">Severity</Label>
                <Select
                  value={draft.severity}
                  onValueChange={(v) => setDraft((d) => ({ ...d, severity: v as PhraseSeverity }))}
                  disabled={isPending}
                >
                  <SelectTrigger id="phrase-severity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PHRASE_SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>{PHRASE_SEVERITY_LABELS[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {PHRASE_SEVERITY_HELP[draft.severity]}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="phrase-category">Category</Label>
                <Select
                  value={draft.category}
                  onValueChange={(v) => setDraft((d) => ({ ...d, category: v }))}
                  disabled={isPending}
                >
                  <SelectTrigger id="phrase-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PHRASE_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>{PHRASE_CATEGORY_LABELS[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Shown to the agent alongside the flagged phrase.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="phrase-alternative">Suggested alternative (optional)</Label>
              <Input
                id="phrase-alternative"
                value={draft.suggestedAlternative}
                placeholder="e.g. historically strong market"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, suggestedAlternative: e.target.value }))
                }
                disabled={isPending}
              />
              <p className="text-xs text-muted-foreground">
                Shown to the agent on the content submission form and in pending approvals,
                so they can fix the copy without guessing.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="phrase-pattern">Match pattern (optional)</Label>
              <Input
                id="phrase-pattern"
                value={draft.phrasePattern}
                placeholder="e.g. guarantee(d|s)?\s+(appreciation|returns?)"
                className="font-mono text-xs"
                onChange={(e) => setDraft((d) => ({ ...d, phrasePattern: e.target.value }))}
                disabled={isPending}
              />
              <p className="text-xs text-muted-foreground">
                A regular expression, matched case-insensitively. Leave it blank and the
                scan matches the phrase itself, which is usually what you want.
              </p>
              {patternError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{patternError}</span>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="phrase-notes">Internal note (optional)</Label>
              <Textarea
                id="phrase-notes"
                rows={2}
                value={draft.notes}
                placeholder="Why this brokerage prohibits it — for your own reviewers."
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                disabled={isPending}
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-2">
                <Switch
                  id="phrase-active"
                  checked={draft.isActive}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, isActive: v }))}
                  disabled={isPending}
                />
                <Label htmlFor="phrase-active" className="text-xs font-normal">
                  Active — included in every scan
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={resetForm} disabled={isPending}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={submit}
                  disabled={isPending || !draft.phrase.trim() || !!patternError}
                >
                  {isPending ? "Saving…" : editingId ? "Save changes" : "Add word"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── THE FEDERAL CATALOGUE — READ-ONLY, NO CONTROLS DRAWN ────────── */}
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Lock className="h-3 w-3" />
              Federal list
              {!loading && !loadError ? ` (${federal.length})` : ""}
            </Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowFederal((s) => !s)}
              disabled={loading || federal.length === 0}
            >
              {showFederal ? "Hide" : "Show"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Fair Housing, RESPA and advertising phrases maintained by the platform. They
            apply to every brokerage and cannot be edited or removed here.
          </p>
          {!loading && !loadError && federal.length === 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                The federal list came back empty. That is not expected — report it before
                relying on a compliance scan.
              </span>
            </div>
          )}
          {showFederal && federal.length > 0 && (
            <ul className="divide-y rounded-md border">
              {federal.map((row) => (
                <li key={row.id} className="px-3 py-2 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm break-words">{row.phrase}</span>
                    <Badge variant={severityBadgeVariant(row.severity)} className="text-[10px]">
                      {row.severity}
                    </Badge>
                    {row.category && (
                      <span className="text-[10px] text-muted-foreground">
                        {row.category.replace(/_/g, " ")}
                      </span>
                    )}
                  </div>
                  {row.suggestedAlternative && (
                    <p className="text-xs text-muted-foreground break-words">
                      Suggest instead: {row.suggestedAlternative}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
