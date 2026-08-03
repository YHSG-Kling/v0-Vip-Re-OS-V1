"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  FileText,
  FolderOpen,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Search,
  ExternalLink,
  Clock,
} from "lucide-react"
import type { DocumentCenterFolder, DocumentCenterRow } from "@/app/actions/document-center"
import { ShareDocumentDialog } from "./share-document-dialog"

interface Props {
  folders: DocumentCenterFolder[]
  totalCount: number
  pendingReviewCount: number
  blockingIssuesCount: number
}

export function DocumentCenterClient({
  folders,
  totalCount,
  pendingReviewCount,
  blockingIssuesCount,
}: Props) {
  const [search, setSearch] = useState("")
  const [activeFolder, setActiveFolder] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<"all" | "pass" | "warnings" | "blocking_issues" | "pending">("all")

  // Flatten + filter all docs
  const filteredDocs = useMemo(() => {
    const all = activeFolder
      ? folders.find((f) => f.category === activeFolder)?.documents ?? []
      : folders.flatMap((f) => f.documents)

    return all.filter((d) => {
      if (statusFilter !== "all") {
        if (statusFilter === "pending" && d.scanStatus != null) return false
        if (statusFilter !== "pending" && d.scanStatus !== statusFilter) return false
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        return (
          d.documentName.toLowerCase().includes(q) ||
          d.contactName?.toLowerCase().includes(q) ||
          d.transactionAddress?.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [folders, activeFolder, search, statusFilter])

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FolderOpen className="h-6 w-6 text-blue-600" />
            Document Center
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every document across your contacts, transactions, and listings — organized and scanned for compliance.
          </p>
        </div>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Documents" value={totalCount} />
        <StatCard label="Awaiting Review" value={pendingReviewCount} variant="warning" />
        <StatCard label="Blocking Issues" value={blockingIssuesCount} variant="danger" />
        <StatCard label="Categories" value={folders.length} />
      </div>

      {/* Search + Status filter */}
      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="flex-1 min-w-[200px] relative">
            <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by file name, contact, or property…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9 text-sm"
            />
          </div>
          <div className="flex gap-1">
            {(["all", "pass", "warnings", "blocking_issues", "pending"] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={statusFilter === s ? "default" : "outline"}
                className="h-8 text-xs capitalize"
                onClick={() => setStatusFilter(s)}
              >
                {s === "blocking_issues" ? "Issues" : s}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6">
        {/* Folder sidebar */}
        <div className="space-y-1">
          <button
            onClick={() => setActiveFolder(null)}
            className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
              activeFolder === null
                ? "bg-blue-50 text-blue-900 font-medium"
                : "hover:bg-gray-50"
            }`}
          >
            <span className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4" />
              All Documents
            </span>
            <span className="text-xs text-muted-foreground">{totalCount}</span>
          </button>
          {folders.map((f) => (
            <button
              key={f.category}
              onClick={() => setActiveFolder(f.category)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
                activeFolder === f.category
                  ? "bg-blue-50 text-blue-900 font-medium"
                  : "hover:bg-gray-50"
              }`}
            >
              <span className="capitalize truncate">{f.label}</span>
              <span className="text-xs text-muted-foreground ml-2">{f.count}</span>
            </button>
          ))}
        </div>

        {/* Document list */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {activeFolder
                ? folders.find((f) => f.category === activeFolder)?.label
                : "All Documents"}{" "}
              <span className="text-muted-foreground font-normal">({filteredDocs.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {filteredDocs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No documents match your filters.
              </p>
            ) : (
              <div className="divide-y">
                {filteredDocs.map((doc) => (
                  <DocRow key={doc.id} doc={doc} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  variant,
}: {
  label: string
  value: number
  variant?: "warning" | "danger"
}) {
  const colorClass =
    variant === "danger"
      ? "text-red-600"
      : variant === "warning"
      ? "text-amber-600"
      : "text-gray-900"

  return (
    <Card>
      <CardContent className="p-3 text-center">
        <p className={`text-2xl font-bold ${colorClass}`}>{value}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
      </CardContent>
    </Card>
  )
}

function DocRow({ doc }: { doc: DocumentCenterRow }) {
  return (
    <div className="px-4 py-3 flex items-start justify-between gap-3 hover:bg-gray-50 transition-colors">
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm truncate">{doc.documentName}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
            {doc.contactName && (
              <Link href={`/crm?contact=${doc.contactId}`} className="hover:underline">
                {doc.contactName}
              </Link>
            )}
            {doc.transactionAddress && (
              <>
                <span>·</span>
                <Link href={`/dashboard/transactions/${doc.transactionId}`} className="hover:underline">
                  {doc.transactionAddress}
                </Link>
              </>
            )}
            <span>·</span>
            <span>{new Date(doc.uploadedAt).toLocaleDateString()}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <ScanBadge doc={doc} />
        {/* Share with the brokerage team — mints a token for /documents/shared/[token],
            which requires a session and refuses anyone outside this brokerage. */}
        <ShareDocumentDialog documentId={doc.id} documentName={doc.documentName} />
        <a
          href={doc.documentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline flex items-center gap-1"
        >
          <ExternalLink className="h-3 w-3" />
          Open
        </a>
      </div>
    </div>
  )
}

function ScanBadge({ doc }: { doc: DocumentCenterRow }) {
  if (doc.scanStatus === "pass") {
    return (
      <span className="text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded-full flex items-center gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Passed
      </span>
    )
  }
  if (doc.scanStatus === "warnings") {
    return (
      <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" />
        {doc.signatureCompleteness?.missingCount
          ? `${doc.signatureCompleteness.missingCount} issue${doc.signatureCompleteness.missingCount > 1 ? "s" : ""}`
          : "Review"}
      </span>
    )
  }
  if (doc.scanStatus === "blocking_issues") {
    return (
      <span className="text-xs bg-red-50 text-red-700 px-2 py-0.5 rounded-full flex items-center gap-1">
        <XCircle className="h-3 w-3" />
        Blocked
      </span>
    )
  }
  return (
    <span className="text-xs text-muted-foreground flex items-center gap-1">
      <Clock className="h-3 w-3" />
      Pending
    </span>
  )
}
