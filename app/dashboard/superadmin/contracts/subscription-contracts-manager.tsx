"use client"

// LANE 1 (m481) — the platform-staff authoring surface for subscription
// agreements. CRUD only; the tenant signs on THEIR billing page. No e-sign
// provider anywhere in this lane — the in-app signature record IS the record.

import { useRef, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  upsertSubscriptionContractTemplateAction,
  setSubscriptionContractTemplateActiveAction,
  planPlatformContractDocumentUploadAction,
  attachPlatformContractDocumentAction,
  type SubscriptionContractTemplate,
  type TenantContractSignatureRow,
} from "@/app/actions/superadmin/subscription-contracts"
import { createClient } from "@/lib/supabase/client"

export function SubscriptionContractsManager({
  initialTemplates,
  initialSignatures,
  canWrite,
}: {
  initialTemplates: SubscriptionContractTemplate[]
  initialSignatures: TenantContractSignatureRow[]
  canWrite: boolean
}) {
  const [templates, setTemplates] = useState(initialTemplates)
  const [editing, setEditing] = useState<{ id?: string; name: string; bodyText: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // ── the storage-path arm's control (LANE 1, m481, built 2026-09-07) ─────────
  // A minimal "Upload PDF" flow: mint a signed PUT (server action, superadmin
  // gated), PUT the bytes straight to Supabase Storage, then record the path on
  // the template row. See app/actions/superadmin/subscription-contracts.ts's
  // two new actions for the write half and app/actions/admin/subscription-agreement.ts
  // for the tenant-facing renderer this feeds.
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingUploadTemplateId, setPendingUploadTemplateId] = useState<string | null>(null)
  const [uploadingId, setUploadingId] = useState<string | null>(null)

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

      setTemplates((prev) => prev.map((t) => (t.id === templateId ? { ...t, body_storage_path: planRes.plan.path } : t)))
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
    setError(null)
    startTransition(async () => {
      const res = await upsertSubscriptionContractTemplateAction({
        id: editing.id,
        name: editing.name,
        bodyText: editing.bodyText,
      })
      if (!res.ok) { setError(res.error); return }
      setTemplates((prev) => {
        const next = prev.filter((t) => t.id !== res.id)
        const prior = prev.find((t) => t.id === res.id)
        return [
          {
            id: res.id,
            name: editing.name,
            contract_type: "subscription_agreement",
            body_text: editing.bodyText,
            body_storage_path: prior?.body_storage_path ?? null,
            version: res.version,
            is_active: prior?.is_active ?? true,
            created_at: prior?.created_at ?? new Date().toISOString(),
            updated_at: new Date().toISOString(),
            signature_count: prior?.signature_count ?? 0,
          },
          ...next,
        ]
      })
      setEditing(null)
    })
  }

  function setActive(id: string, active: boolean) {
    setError(null)
    startTransition(async () => {
      const res = await setSubscriptionContractTemplateActiveAction(id, active)
      if (!res.ok) { setError(res.error); return }
      setTemplates((prev) =>
        prev.map((t) => ({ ...t, is_active: t.id === id ? active : active ? false : t.is_active })),
      )
    })
  }

  return (
    <div className="space-y-8">
      {error && <div className="rounded border border-red-300 p-3 text-sm text-red-600">{error}</div>}

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
            <Button size="sm" onClick={() => setEditing({ name: "", bodyText: "" })} disabled={isPending}>
              New template
            </Button>
          )}
        </div>

        {templates.length === 0 && !editing && (
          <p className="text-sm text-muted-foreground border border-dashed rounded p-4">
            No subscription agreement authored yet — tenants have nothing to sign until one exists.
          </p>
        )}

        {templates.map((t) => (
          <div key={t.id} className="rounded border p-4 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{t.name}</span>
              <Badge variant="outline">v{t.version}</Badge>
              <Badge variant={t.is_active ? "default" : "secondary"}>{t.is_active ? "Active" : "Retired"}</Badge>
              <Badge variant="outline">{t.signature_count} signed</Badge>
              {t.body_storage_path && <Badge variant="outline">Document attached</Badge>}
              {canWrite && (
                <span className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing({ id: t.id, name: t.name, bodyText: t.body_text ?? "" })}
                    disabled={isPending}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => triggerUpload(t.id)}
                    disabled={isPending || uploadingId === t.id}
                  >
                    {uploadingId === t.id ? "Uploading…" : t.body_storage_path ? "Replace PDF" : "Upload PDF"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setActive(t.id, !t.is_active)} disabled={isPending}>
                    {t.is_active ? "Retire" : "Make active"}
                  </Button>
                </span>
              )}
            </div>
            {t.body_text && (
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto border rounded p-2">
                {t.body_text}
              </pre>
            )}
            {!t.body_text && t.body_storage_path && (
              <p className="text-xs text-muted-foreground">
                This agreement is an uploaded document (no inline text) — the tenant is shown a signed link to it.
              </p>
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
            <textarea
              className="w-full border rounded px-3 py-2 text-sm font-mono min-h-48"
              placeholder="The full text of the agreement the tenant will read and sign…"
              value={editing.bodyText}
              onChange={(e) => setEditing({ ...editing, bodyText: e.target.value })}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={isPending}>Save</Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(null)} disabled={isPending}>Cancel</Button>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Tenant signatures</h2>
        <p className="text-xs text-muted-foreground max-w-3xl">
          A typed name is not an attestation. &ldquo;Typed name&rdquo; is the string the signer keyed
          in; <span className="font-medium">Account</span> is the server-resolved session that
          executed the agreement (<code>signed_by</code>) and <span className="font-medium">Method</span>{" "}
          is what the stored <code>signature</code> record says about HOW it was executed. Anything the
          record does not carry reads as <span className="font-medium">not recorded</span> — never as
          verified.
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
                  <th className="py-2 pr-4">Template version</th>
                  <th className="py-2">Signed at</th>
                </tr>
              </thead>
              <tbody>
                {initialSignatures.map((s) => (
                  <tr key={s.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-4">{s.brokerage_name ?? s.brokerage_id}</td>
                    <td className="py-2 pr-4">{s.signed_name}</td>
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
                    <td className="py-2 pr-4">{s.template_version ?? "—"}</td>
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
