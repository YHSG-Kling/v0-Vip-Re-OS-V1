"use client"

/**
 * DOCUMENT WORKSPACE — the surface for the folder/template half of
 * app/actions/dotloop-integration.ts, plus the AI drafting capability from
 * app/actions/ai-document-intelligence.ts.
 *
 * Four exported capabilities had ZERO callers before this file existed:
 *   getDocumentTemplates          -> document_templates (platform catalogue)
 *   generateDocumentFromTemplate  -> client_documents + document_audit_trail
 *   createDocumentFolder          -> document_folders
 *   getDocumentFolders            -> document_folders (the reader)
 *   aiGenerateDocument            -> pure draft, writes nothing
 *
 * HONESTY NOTE ON THE TEMPLATE CATALOGUE: document_templates is
 * PLATFORM-OWNED (no brokerage_id column; dt_insert requires
 * is_platform_admin()) and currently holds ZERO rows. This panel therefore says
 * so out loud rather than rendering an empty dropdown that reads as broken.
 */

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FolderPlus, FileSignature, Loader2, Sparkles, FolderOpen } from "lucide-react"
import {
  createDocumentFolder,
  getDocumentFolders,
  getDocumentTemplates,
  generateDocumentFromTemplate,
} from "@/app/actions/dotloop-integration"
import type {
  DocumentFolderSummary,
  DocumentTemplateSummary,
} from "@/app/actions/dotloop-integration"
import { aiGenerateDocument } from "@/app/actions/ai-document-intelligence"

/**
 * THE SUBMIT GATE'S VOCABULARY — every value createDocumentFolder accepts, and
 * no others.
 *
 * It is a local copy because a "use server" module may only export async
 * functions, so the action's own constant cannot be imported. The list mirrors
 * the LIVE `document_folders_type_check`:
 *   CHECK (folder_type IS NULL OR folder_type = ANY
 *          (ARRAY['transaction','client','template','marketing','compliance']))
 * scripts/transaction-document-wiring-simulator.ts asserts this array and the
 * action's validation array are element-for-element identical, so a drift in
 * either one fails the build gate rather than producing a control that offers a
 * value the database refuses.
 */
const DOCUMENT_FOLDER_TYPES = [
  "transaction", "client", "template", "marketing", "compliance",
] as const

const AI_DOCUMENT_TYPES = [
  "cover_letter",
  "offer_summary",
  "counter_proposal",
  "property_description",
  "agent_remarks",
] as const
type AiDocumentType = (typeof AI_DOCUMENT_TYPES)[number]

interface Verdict {
  ok: boolean
  headline: string
  detail?: string
}

function VerdictNote({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return null
  return (
    <Alert variant={verdict.ok ? "default" : "destructive"} className="mt-2">
      <AlertDescription className="text-xs">
        <span className="font-medium">{verdict.headline}</span>
        {verdict.detail ? <span className="block mt-0.5">{verdict.detail}</span> : null}
      </AlertDescription>
    </Alert>
  )
}

export function DocumentWorkspacePanel() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)

  // ── FOLDERS ───────────────────────────────────────────────────────────────
  const [folders, setFolders] = useState<DocumentFolderSummary[]>([])
  const [foldersError, setFoldersError] = useState<string | null>(null)
  const [folderName, setFolderName] = useState("")
  const [folderType, setFolderType] = useState<(typeof DOCUMENT_FOLDER_TYPES)[number]>("transaction")
  const [folderVerdict, setFolderVerdict] = useState<Verdict | null>(null)

  const loadFolders = async () => {
    const res = await getDocumentFolders()
    if (!res.success) {
      // A failed read must never render as "no folders" — that is a clean-looking
      // gate produced by a broken query.
      setFoldersError(res.error ?? "Could not load folders.")
      setFolders([])
      return
    }
    setFoldersError(null)
    setFolders(res.folders)
  }

  // ── TEMPLATES ─────────────────────────────────────────────────────────────
  const [templates, setTemplates] = useState<DocumentTemplateSummary[]>([])
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [templateId, setTemplateId] = useState<string>("")
  const [documentName, setDocumentName] = useState("")
  const [variableValues, setVariableValues] = useState<Record<string, string>>({})
  const [templateVerdict, setTemplateVerdict] = useState<Verdict | null>(null)

  const loadTemplates = async () => {
    const res = await getDocumentTemplates()
    if (!res.success) {
      setTemplatesError(res.error ?? "Could not load templates.")
      setTemplates([])
      return
    }
    setTemplatesError(null)
    setTemplates(res.templates)
  }

  useEffect(() => {
    void loadFolders()
    void loadTemplates()
  }, [])

  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null

  // ── AI DRAFT ──────────────────────────────────────────────────────────────
  const [aiType, setAiType] = useState<AiDocumentType>("cover_letter")
  const [aiContext, setAiContext] = useState("")
  const [aiDraft, setAiDraft] = useState<string | null>(null)
  const [aiVerdict, setAiVerdict] = useState<Verdict | null>(null)

  const submitFolder = () => {
    setBusy("folder")
    setFolderVerdict(null)
    startTransition(async () => {
      const res = await createDocumentFolder({ folderName, folderType })
      setBusy(null)
      if (!res.success) {
        setFolderVerdict({ ok: false, headline: res.error ?? "Could not create the folder." })
        return
      }
      setFolderVerdict({ ok: true, headline: `Folder "${res.folder?.folderName}" created.` })
      setFolderName("")
      await loadFolders()
      router.refresh()
    })
  }

  const submitTemplate = () => {
    setBusy("template")
    setTemplateVerdict(null)
    startTransition(async () => {
      const res = await generateDocumentFromTemplate({
        templateId,
        documentName,
        variables: variableValues,
      })
      setBusy(null)
      if (!res.success) {
        setTemplateVerdict({ ok: false, headline: res.error ?? "Could not generate the document." })
        return
      }
      const unresolved = res.document?.unresolvedVariables ?? []
      setTemplateVerdict({
        ok: true,
        headline: `"${res.document?.documentName}" created${
          res.document?.signatureStatus ? ` (${res.document.signatureStatus})` : ""
        }.`,
        // Reported, not swallowed: a contract shipped with literal {{braces}} in
        // it is a defect the agent needs to know about NOW.
        detail:
          unresolved.length > 0
            ? `Still unfilled: ${unresolved.join(", ")} — edit the document before sending it.`
            : undefined,
      })
      setDocumentName("")
      setVariableValues({})
      router.refresh()
    })
  }

  const submitAiDraft = () => {
    setBusy("ai")
    setAiVerdict(null)
    setAiDraft(null)
    startTransition(async () => {
      let context: Record<string, any> = {}
      if (aiContext.trim()) {
        try {
          context = JSON.parse(aiContext)
        } catch {
          context = { notes: aiContext }
        }
      }
      const res = await aiGenerateDocument({ documentType: aiType, context })
      setBusy(null)
      if (!res.success) {
        setAiVerdict({ ok: false, headline: res.error ?? "Draft failed." })
        return
      }
      setAiDraft(res.document?.content ?? null)
      // HONEST: this action returns text and writes NOTHING. Saying "saved"
      // would be a lie the next reader would discover the hard way.
      setAiVerdict({ ok: true, headline: "Draft ready — copy it out; nothing was saved." })
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-blue-600" />
          Folders, templates &amp; drafting
        </CardTitle>
      </CardHeader>

      <CardContent className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── FOLDERS ─────────────────────────────────────────────────────── */}
        <section>
          <p className="text-sm font-medium flex items-center gap-1.5">
            <FolderPlus className="h-3.5 w-3.5" />
            Filing folders
          </p>

          {foldersError ? (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription className="text-xs">{foldersError}</AlertDescription>
            </Alert>
          ) : folders.length === 0 ? (
            <p className="text-xs text-muted-foreground mt-1">No folders yet.</p>
          ) : (
            <ul className="mt-1 text-xs space-y-0.5 max-h-32 overflow-y-auto">
              {folders.map((f) => (
                <li key={f.id} className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {f.folderType ?? "—"}
                  </Badge>
                  <span className="truncate">{f.folderName}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 space-y-2">
            <div>
              <Label className="text-xs">Folder name</Label>
              <Input
                className="h-8 text-xs"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="e.g. 2026 Listing Compliance"
              />
            </div>
            <div>
              <Label className="text-xs">Type</Label>
              {/* Built from DOCUMENT_FOLDER_TYPES, which mirrors the live
                  document_folders_type_check — the control cannot offer a value
                  the database would refuse. */}
              <Select value={folderType} onValueChange={(v) => setFolderType(v as any)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOCUMENT_FOLDER_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="text-xs capitalize">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={pending || !folderName.trim()}
              onClick={submitFolder}
            >
              {busy === "folder" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Create folder
            </Button>
            <VerdictNote verdict={folderVerdict} />
          </div>
        </section>

        {/* ── TEMPLATES ───────────────────────────────────────────────────── */}
        <section>
          <p className="text-sm font-medium flex items-center gap-1.5">
            <FileSignature className="h-3.5 w-3.5" />
            New from template
          </p>

          {templatesError ? (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription className="text-xs">{templatesError}</AlertDescription>
            </Alert>
          ) : templates.length === 0 ? (
            <p className="text-xs text-muted-foreground mt-1">
              No document templates have been published to the platform catalogue yet, so there is
              nothing to generate from. Templates are added by a platform admin.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              <div>
                <Label className="text-xs">Template</Label>
                <Select
                  value={templateId}
                  onValueChange={(v) => {
                    setTemplateId(v)
                    setVariableValues({})
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Choose a template" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id} className="text-xs">
                        {t.templateName}
                        {t.requiresClientSignature ? " · needs signature" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-xs">Document name</Label>
                <Input
                  className="h-8 text-xs"
                  value={documentName}
                  onChange={(e) => setDocumentName(e.target.value)}
                />
              </div>

              {selectedTemplate && selectedTemplate.variables.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-[11px] text-muted-foreground">
                    Fill the template&apos;s placeholders — anything left blank is reported back, not
                    silently shipped.
                  </p>
                  {selectedTemplate.variables.map((v) => (
                    <div key={v}>
                      <Label className="text-[11px]">{v}</Label>
                      <Input
                        className="h-7 text-xs"
                        value={variableValues[v] ?? ""}
                        onChange={(e) =>
                          setVariableValues((prev) => ({ ...prev, [v]: e.target.value }))
                        }
                      />
                    </div>
                  ))}
                </div>
              ) : null}

              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={pending || !templateId || !documentName.trim()}
                onClick={submitTemplate}
              >
                {busy === "template" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                Generate document
              </Button>
              <VerdictNote verdict={templateVerdict} />
            </div>
          )}
        </section>

        {/* ── AI DRAFT ────────────────────────────────────────────────────── */}
        <section>
          <p className="text-sm font-medium flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            AI draft
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Written in your brand voice. Returns text only — nothing is stored.
          </p>

          <div className="mt-2 space-y-2">
            <div>
              <Label className="text-xs">Kind</Label>
              <Select value={aiType} onValueChange={(v) => setAiType(v as AiDocumentType)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AI_DOCUMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="text-xs capitalize">
                      {t.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Context</Label>
              <Textarea
                rows={3}
                className="text-xs"
                value={aiContext}
                onChange={(e) => setAiContext(e.target.value)}
                placeholder="Buyers, property, price, timeline — plain text or JSON"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={pending}
              onClick={submitAiDraft}
            >
              {busy === "ai" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Draft it
            </Button>
            <VerdictNote verdict={aiVerdict} />
            {aiDraft ? (
              <pre className="text-xs whitespace-pre-wrap border rounded p-2 bg-muted/40 max-h-56 overflow-auto">
                {aiDraft}
              </pre>
            ) : null}
          </div>
        </section>
      </CardContent>
    </Card>
  )
}
