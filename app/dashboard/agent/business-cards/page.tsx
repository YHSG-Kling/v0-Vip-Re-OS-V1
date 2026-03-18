"use client"

import { useState, useRef, useCallback } from "react"
import { uploadBusinessCard, getRecentScans } from "@/app/actions/business-card/business-card-actions"
import { createClient } from "@/lib/supabase/client"
import { useEffect } from "react"

type ScanRow = {
  id: string
  created_at: string
  extracted_data: Record<string, string>
  confidence_score: number
  review_status: "approved" | "rejected"
  contact_id: string | null
  raw_image_url: string
}

type ScanResult = {
  scanId: string
  contactId: string | null
  viable: boolean
  extracted?: Record<string, string>
  confidence?: number
}

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const color =
    pct >= 80 ? "bg-green-100 text-green-800" :
    pct >= 50 ? "bg-yellow-100 text-yellow-800" :
                "bg-red-100 text-red-800"
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}>
      {pct}%
    </span>
  )
}

export default function BusinessCardsPage() {
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [scans, setScans] = useState<ScanRow[]>([])
  const [loadingScans, setLoadingScans] = useState(true)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [brokerageId, setBrokerageId] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("agent_id, brokerage_id")
        .eq("user_id", user.id)
        .single()
      if (!profile) return
      setAgentId(profile.agent_id)
      setBrokerageId(profile.brokerage_id)

      const history = await getRecentScans({
        agentId: profile.agent_id,
        brokerageId: profile.brokerage_id,
        limit: 20,
      })
      setScans(history)
      setLoadingScans(false)
    })()
  }, [])

  const processFile = useCallback(async (file: File) => {
    if (!agentId || !brokerageId) return
    setScanning(true)
    setResult(null)
    try {
      const arrayBuffer = await file.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString("base64")
      const mimeType = (
        file.type === "image/png" ? "image/png" :
        file.type === "image/webp" ? "image/webp" :
        "image/jpeg"
      ) as "image/jpeg" | "image/png" | "image/webp"

      const res = await uploadBusinessCard({ imageBase64: base64, mimeType, agentId, brokerageId })

      // Reload history
      const history = await getRecentScans({ agentId, brokerageId, limit: 20 })
      setScans(history)

      // Find extracted data from history
      const newScan = history.find((s) => s.id === res.scanId)
      setResult({
        ...res,
        extracted: newScan?.extracted_data,
        confidence: newScan?.confidence_score,
      })
    } finally {
      setScanning(false)
    }
  }, [agentId, brokerageId])

  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) return
    void processFile(file)
  }

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ""
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  const fields = ["first_name", "last_name", "email", "phone", "company", "title", "address", "website"]
  const fieldLabel: Record<string, string> = {
    first_name: "First Name", last_name: "Last Name", email: "Email",
    phone: "Phone", company: "Company", title: "Title",
    address: "Address", website: "Website",
  }

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-semibold text-foreground">Business Card Scanner</h1>

      {/* Upload zone */}
      <section
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${
          dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/60"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Upload business card image"
        onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={onInputChange}
          aria-hidden="true"
        />
        {scanning ? (
          <div className="space-y-2">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-muted-foreground">Scanning card...</p>
          </div>
        ) : (
          <div className="space-y-2">
            <svg className="w-10 h-10 mx-auto text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <p className="text-sm font-medium text-foreground">Drop a photo or click to upload</p>
            <p className="text-xs text-muted-foreground">Tap to use camera on mobile — JPG, PNG, WebP</p>
          </div>
        )}
      </section>

      {/* Result */}
      {result && (
        <section className="border border-border rounded-xl p-6 space-y-4">
          {result.viable ? (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">Extraction confidence</span>
                  {result.confidence !== undefined && <ConfidenceBadge score={result.confidence} />}
                </div>
                <span className="text-xs text-green-700 bg-green-100 px-2 py-1 rounded font-medium">Contact created</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {fields.map((k) => {
                  const val = result.extracted?.[k]?.trim()
                  if (!val) return null
                  return (
                    <div key={k}>
                      <p className="text-xs text-muted-foreground">{fieldLabel[k]}</p>
                      <p className="text-sm text-foreground font-medium">{val}</p>
                    </div>
                  )
                })}
              </div>

              {result.contactId && (
                <a
                  href={`/contacts/${result.contactId}`}
                  className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2"
                >
                  View contact record
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              )}

              <p className="text-xs text-muted-foreground">
                Note: Physical business cards do not constitute TCPA digital consent. The contact will require explicit opt-in before receiving automated outreach.
              </p>

              <button
                className="text-xs text-muted-foreground underline underline-offset-2"
                onClick={() => alert("Thank you for your feedback. The extraction data has been flagged for review.")}
              >
                Report extraction error
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <p className="text-sm font-medium text-foreground">Could not extract contact info — try a clearer photo</p>
              </div>
              {result.extracted && Object.values(result.extracted).some((v) => v?.trim()) && (
                <div className="grid grid-cols-2 gap-3 mt-2">
                  {fields.map((k) => {
                    const val = result.extracted?.[k]?.trim()
                    if (!val) return null
                    return (
                      <div key={k}>
                        <p className="text-xs text-muted-foreground">{fieldLabel[k]}</p>
                        <p className="text-sm text-foreground">{val}</p>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* History */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Recent Scans</h2>
        {loadingScans ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : scans.length === 0 ? (
          <p className="text-sm text-muted-foreground">No scans yet.</p>
        ) : (
          <div className="border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Date</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Name Extracted</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Confidence</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Contact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {scans.map((s) => {
                  const ext = s.extracted_data
                  const name = [ext.first_name, ext.last_name].filter(Boolean).join(" ") || "—"
                  return (
                    <tr key={s.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(s.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-foreground">{name}</td>
                      <td className="px-4 py-3">
                        <ConfidenceBadge score={s.confidence_score} />
                      </td>
                      <td className="px-4 py-3">
                        {s.review_status === "approved" ? (
                          <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded font-medium">Contact created</span>
                        ) : (
                          <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded font-medium">Viability failed</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {s.contact_id ? (
                          <a
                            href={`/contacts/${s.contact_id}`}
                            className="text-primary underline underline-offset-2"
                          >
                            View
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}
