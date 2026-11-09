"use client"

// LANE 1 (m481) — the platform-staff authoring surface for subscription
// agreements. CRUD only; the tenant signs on THEIR billing page. No e-sign
// provider anywhere in this lane — the in-app signature record IS the record.
//
// WAVE 151 (lane 151A): a template is a VERSION with a content hash and an
// approval record. New text is a DRAFT (inactive); a text still carrying the
// draft banner (docs/legal/** — lane 151A2) can be neither approved nor made
// active; approval is RECORDED (who / when / reference) by a superadmin; only an
// approved version can be made active; editing an active / approved / accepted
// text creates a NEW version (the accepted text is never changed underneath a
// tenant) and activating it tells the earlier signers to re-accept.

import { useRef, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  upsertSubscriptionContractTemplateAction,
  setSubscriptionContractTemplateActiveAction,
  approveSubscriptionContractTemplateAction,
  planPlatformContractDocumentUploadAction,
  attachPlatformContractDocumentAction,
  listSubscriptionContractTemplatesAction,
  type SubscriptionContractTemplate,
  type TenantContractSignatureRow,
} from "@/app/actions/superadmin/subscription-contracts"
import { createClient } from "@/lib/supabase/client"

const shortHash = (h: string | null) => (h && h.length >= 12 ? `${h.slice(0, 12)}…` : h ?? "—")

export function SubscriptionContractsManager({
  initialTemplates,
  initialSignatures,
  canWrite,
  draftBanner,
}: {
  initialTemplates: SubscriptionContractTemplate[]
  initialSignatures: TenantContractSignatureRow[]
  canWrite: boolean
  /** The exact banner a draft carries (lib/legal/subscription-agreement.ts DRAFT_BANNER) — shown so staff know what blocks approval. */
  draftBanner: string
}) {
  const [templates, setTemplates] = useState(initialTemplates)
  const [editing, setEditing] = useState<{ id?: string; name: string; bodyText: string; versionLabel: string; sourcePath: string } | null>(null)
  const [approving, setApproving] = useState<{ id: string; note: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // ── the storage-path arm's control (LANE 1, m481, built 2026-09-07) ─────────
  // A minimal "Upload PDF" flow: mint a signed PUT (server action, superadmin
  // gated), PUT the bytes straight to Supabase Storage, then record the path on
  // the template row (hashed from its bytes, wave 151). See
  // app/actions/superadmin/subscription-contracts.ts's two actions for the write
  // half and app/actions/admin/subscription-agreement.ts for the tenant renderer.
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingUploadTemplateId, setPendingUploadTemplateId] = useState<string | null>(null)
  const [uploadingId, setUploadingId] = useState<string | null>(null)

  /** Re-read the catalogue after a write: the server computes the hash / blocker facts the list carries. */
  async function refresh() {
    const res = await listSubscriptionContractTemplatesAction()
    if (res.ok) setTemplates(res.templates)
  }

  function triggerUpload(templateId: string) {
    setError(null)
    setPendingUploadTemplateId(templateId)
    fileInputRef.current?.click()
  }

  async function uploadDocument(templateId: string, file: File) {
    if (file.type !== "application/pdf") {
      setError("Only a PDF may be attached as the agreement document")
      return
    }
    setUploadingId(templateId)
    try {
      const planRes = await planPlatformContractDocumentUploadAction({
        fileName: file.name,
        contentType: file.type,
        bytes: file.size,
      })
      if (!planRes.ok) { setError(planRes.error); return }

      // supabase-js RESOLVES a refusal (CLAUDE.md §3) — the storage error is read
      // rather than assumed absent.
      const supabase = createClient()
      const { error: putErr } = await supabase.storage
        .from(planRes.plan.bucket)
        .uploadToSignedUrl(planRes.plan.path, planRes.plan.token, file, { contentType: file.type })
      if (putErr) { setError(putErr.message); return }

      const attachRes = await attachPlatformContractDocumentAction({ templateId, storagePath: planRes.plan.path })
      if (!attachRes.ok) { setError(attachRes.error); return }
      await refresh()
    } finally {
      setUploadingId(null)
    }
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    const templateId = pendingUploadTemplateId
    e.target.value = ""
    setPendingUploadTemplateId(null)
    if (!file || !templateId) return
    void uploadDocument(templateId, file)
  }

  function save() {
    if (!editing) return
    setError(null); setNotice(null)
    startTransition(async () => {
      const res = await upsertSubscriptionContractTemplateAction({
        id: editing.id,
        name: editing.name,
        bodyText: editing.bodyText,
        versionLabel: editing.versionLabel.trim() || null,
        sourcePath: editing.sourcePath.trim() || null,
      })
      if (!res.ok) { setError(res.error); return }
      setNotice(res.supersededId
        ? `Saved as a NEW version (v${res.version}) — the earlier version stays exactly as tenants accepted it.${res.draftMarked ? " The text still carries the draft banner." : ""}`
        : `Saved v${res.version}${res.versionLabel ? ` (${res.versionLabel})` : ""} as a draft.${res.draftMarked ? " It carries the draft banner and cannot be approved until the owner and counsel approve the text." : ""}`)
      await refresh()
      setEditing(null)
    })
  }

  function approve() {
    if (!approving) return
    setError(null); setNotice(null)
    startTransition(async () => {
      const res = await approveSubscriptionContractTemplateAction({ templateId: approving.id, note: approving.note })
      if (!res.ok) { setError(res.error); return }
      setNotice("Approval recorded. The version can now be made active.")
      await refresh()
      setApproving(null)
    })
  }

  function setActive(id: string, active: boolean) {
    setError(null); setNotice(null)
    startTransition(async () => {
      const res = await setSubscriptionContractTemplateActiveAction(id, active)
      if (!res.ok) { setError(res.error); return }
      if (active) setNotice(`Active. ${res.retired ?? 0} earlier version${(res.retired ?? 0) === 1 ? "" : "s"} retired; ${res.reacceptanceNotified ?? 0} brokerage${(res.reacceptanceNotified ?? 0) === 1 ? "" : "s"} told to re-accept.`)
      await refresh()
    })
  }

  return (
    <div className="space-y-8">
      {error && <div role="alert" className="rounded border border-red-300 p-3 text-sm text-red-600">{error}</div>}
      {notice && <div role="status" className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900">{notice}</div>}

      <input
        type="file"
        accept="application/pdf"
        ref={fileInputRef}
        onChange={onFileChosen}
        className="hidden"
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Templates</h2>
          {canWrite && (
            <Button size="sm" onClick={() => setEditing({ name: "", bodyText: "", versionLabel: "", sourcePath: "" })} disabled={isPending}>
              New template
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground max-w-3xl">
          A new text is a <span className="font-medium">draft</span> and inactive. A text carrying the banner
          &ldquo;{draftBanner}&rdquo; cannot be approved or made active. Approval is a record of the owner&apos;s and counsel&apos;s
          decision (name who, and when). Only an approved version can be made active; editing an active, approved or accepted
          text creates a new version and leaves the accepted text untouched.
        </p>

        {templates.length === 0 && !editing && (
          <p className="text-sm text-muted-foreground border border-dashed rounded p-4">
            No subscription agreement authored yet — tenants have nothing to sign until one exists.
          </p>
        )}

        {templates.map((t) => (
          <div key={t.id} className="rounded border p-4 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{t.name}</span>
              <Badge variant="outline">{t.version_label ? `${t.version_label} (v${t.version})` : `v${t.version}`}</Badge>
              <Badge variant={t.approval_status === "approved" ? "default" : "secondary"}>{t.approval_status === "approved" ? "Approved" : "Draft"}</Badge>
              <Badge variant={t.is_active ? "default" : "outline"}>{t.is_active ? "Active" : "Not active"}</Badge>
              <Badge variant="outline">{t.signature_count} accepted</Badge>
              {t.draft_marked && <Badge variant="outline" className="text-amber-700">draft banner present</Badge>}
              {t.hash_matches === false && <Badge variant="outline" className="text-red-700">hash does not match the text</Badge>}
              {t.body_storage_path && <Badge variant="outline">Document attached</Badge>}
              {t.supersedes_template_id && <Badge variant="outline">supersedes an earlier version</Badge>}
              {canWrite && (
                <span className="ml-auto flex gap-2 flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing({ id: t.id, name: t.name, bodyText: t.body_text ?? "", versionLabel: t.version_label ?? "", sourcePath: t.source_path ?? "" })}
                    disabled={isPending}
                  >
                    {t.is_active || t.approval_status === "approved" || t.signature_count > 0 ? "New version from this" : "Edit"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => triggerUpload(t.id)}
                    disabled={isPending || uploadingId === t.id || t.is_active || t.approval_status === "approved" || t.signature_count > 0}
                  >
                    {uploadingId === t.id ? "Uploading…" : t.body_storage_path ? "Replace PDF" : "Upload PDF"}
                  </Button>
                  {t.approval_status !== "approved" && (
                    <Button size="sm" variant="outline" onClick={() => setApproving({ id: t.id, note: "" })} disabled={isPending || t.draft_marked} title={t.draft_marked ? "Remove the draft banner only once the owner and counsel have approved the text" : undefined}>
                      Record approval
                    </Button>
                  )}
                  {t.is_active ? (
                    <Button size="sm" variant="outline" onClick={() => setActive(t.id, false)} disabled={isPending}>Retire</Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setActive(t.id, true)} disabled={isPending || !!t.activation_blocker} title={t.activation_blocker ?? undefined}>Make active</Button>
                  )}
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Content sha256 <span className="font-mono">{shortHash(t.content_sha256)}</span>
              {t.approved_at ? ` · approved ${new Date(t.approved_at).toLocaleDateString()}${t.approval_note ? ` — ${t.approval_note}` : ""}` : " · not yet approved"}
              {t.source_path ? ` · source ${t.source_path}` : ""}
            </p>
            {!t.is_active && t.activation_blocker && (
              <p className="text-xs text-amber-700">Cannot be made active: {t.activation_blocker}</p>
            )}
            {t.body_text && (
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto border rounded p-2">
                {t.body_text}
              </pre>
            )}
            {!t.body_text && t.body_storage_path && (
              <p className="text-xs text-muted-foreground">
                This agreement is an uploaded document (no inline text) — the tenant is shown a signed link to it; its bytes were hashed when attached.
              </p>
            )}
            {approving?.id === t.id && (
              <div className="rounded border p-3 space-y-2">
                <label className="text-sm font-medium" htmlFor={`approval-note-${t.id}`}>Who approved this text, and when (owner / counsel, date or reference)</label>
                <input
                  id={`approval-note-${t.id}`}
                  className="w-full border rounded px-3 py-2 text-sm"
                  placeholder="e.g. Approved by the owner and outside counsel, 2026-11-20, engagement ref …"
                  value={approving.note}
                  onChange={(e) => setApproving({ id: t.id, note: e.target.value })}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={approve} disabled={isPending || !approving.note.trim()}>Record approval</Button>
                  <Button size="sm" variant="outline" onClick={() => setApproving(null)} disabled={isPending}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        ))}

        {editing && (
          <div className="rounded border p-4 space-y-3">
            <input
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="Contract name (e.g. VIP RE OS Subscription Agreement)"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                className="w-full border rounded px-3 py-2 text-sm"
                placeholder="Version label (read from the text's Version: line when left blank)"
                value={editing.versionLabel}
                onChange={(e) => setEditing({ ...editing, versionLabel: e.target.value })}
              />
              <input
                className="w-full border rounded px-3 py-2 text-sm"
                placeholder="Source (e.g. docs/legal/…​.md) — provenance only"
                value={editing.sourcePath}
                onChange={(e) => setEditing({ ...editing, sourcePath: e.target.value })}
              />
            </div>
            <textarea
              className="w-full border rounded px-3 py-2 text-sm font-mono min-h-48"
              placeholder="The full text of the agreement the tenant will read and sign…"
              value={editing.bodyText}
              onChange={(e) => setEditing({ ...editing, bodyText: e.target.value })}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={isPending}>Save as draft</Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(null)} disabled={isPending}>Cancel</Button>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Tenant acceptances</h2>
        <p className="text-xs text-muted-foreground max-w-3xl">
          A typed name is not an attestation. &ldquo;Typed name&rdquo; is the string the signer keyed
          in; <span className="font-medium">Account</span> is the server-resolved session that
          executed the agreement (<code>signed_by</code>) and <span className="font-medium">Method</span>{" "}
          is what the stored <code>signature</code> record says about HOW it was executed. Anything the
          record does not carry reads as <span className="font-medium">not recorded</span> — never as
          verified. <span className="font-medium">Version / hash</span> is the exact text the brokerage accepted;
          <span className="font-medium"> Authority</span> is why that account could sign for the brokerage.
        </p>
        {initialSignatures.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tenant has signed yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-4">Brokerage</th>
                  <th className="py-2 pr-4">Typed name</th>
                  <th className="py-2 pr-4">Account (signed_by)</th>
                  <th className="py-2 pr-4">Method</th>
                  <th className="py-2 pr-4">Version / hash</th>
                  <th className="py-2 pr-4">Authority</th>
                  <th className="py-2">Signed at</th>
                </tr>
              </thead>
              <tbody>
                {initialSignatures.map((s) => (
                  <tr key={s.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-4">{s.brokerage_name ?? s.brokerage_id}</td>
                    <td className="py-2 pr-4">{s.signed_name}{s.signatory_title ? <span className="block text-xs text-muted-foreground">{s.signatory_title}</span> : null}</td>
                    <td className="py-2 pr-4">
                      {s.signed_by ? (
                        <span className="flex flex-col">
                          <span>{s.signer_name ?? s.signer_email ?? "account no longer on the roster"}</span>
                          {s.signer_name && s.signer_email && (
                            <span className="text-xs text-muted-foreground">{s.signer_email}</span>
                          )}
                          <span className="text-[10px] text-muted-foreground font-mono">{s.signed_by.slice(0, 8)}</span>
                        </span>
                      ) : (
                        <Badge variant="outline" className="text-xs">account not recorded</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {s.attestation_method ? (
                        <span className="flex flex-col">
                          <Badge variant="secondary" className="text-xs w-fit">
                            {s.attestation_method.replace(/_/g, " ")}
                          </Badge>
                          {s.attestation_signed_at && (
                            <span className="text-[10px] text-muted-foreground">
                              attested {new Date(s.attestation_signed_at).toLocaleString()}
                            </span>
                          )}
                          {s.attestation_typed_name && s.attestation_typed_name !== s.signed_name && (
                            <span className="text-[10px] text-amber-700">
                              attestation name differs: {s.attestation_typed_name}
                            </span>
                          )}
                        </span>
                      ) : s.attestation_malformed ? (
                        <Badge variant="outline" className="text-xs text-amber-700">
                          attestation unreadable
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">method not recorded</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <span className="flex flex-col">
                        <span>{s.version_label ?? (s.template_version !== null ? `v${s.template_version}` : "—")}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">{shortHash(s.content_sha256)}</span>
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">{s.signatory_authority.length ? s.signatory_authority.join("; ") : "not recorded"}</td>
                    <td className="py-2">{new Date(s.signed_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
