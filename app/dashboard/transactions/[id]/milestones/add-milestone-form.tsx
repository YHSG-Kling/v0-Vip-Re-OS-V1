"use client"

/**
 * The one hand-added milestone. → app/actions/copilot.ts:createTransactionMilestone
 *
 * DELIBERATELY FREE-TEXT on the type. lib/transactions/milestone-catalog.ts is the
 * canonical set and it is SEEDED, not typed in — the catalog's whole purpose is that
 * the templated milestones cannot drift between the two creation routes. This lane
 * exists for the milestone that is NOT in the catalog (a lender's one-off condition, a
 * municipality's inspection window), so offering the catalog here would either
 * duplicate a seeded row or imply the catalog is editable by hand. Neither is true.
 *
 * The action THROWS on an unauthenticated caller, a missing brokerage, and a refused
 * insert, and RETURNS `{success:false}` on a bad listing id or a listing with no deal.
 * Both shapes are handled: a rejected promise here would otherwise surface as an
 * unhandled error boundary rather than a sentence the agent can act on.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, Plus } from "lucide-react"
import { createTransactionMilestone } from "@/app/actions/copilot"

export function AddMilestoneForm({ listingId }: { listingId: string }) {
  const router = useRouter()
  const [title, setTitle] = useState("")
  const [milestoneType, setMilestoneType] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [description, setDescription] = useState("")
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () => {
    setMessage(null)
    if (!title.trim()) {
      setMessage({ kind: "error", text: "Give the milestone a title." })
      return
    }
    if (!dueDate) {
      setMessage({ kind: "error", text: "A milestone needs a target date." })
      return
    }
    startTransition(async () => {
      try {
        const res = await createTransactionMilestone({
          listing_id: listingId,
          // `milestone_type` also fills the NOT NULL `milestone_name` column in the
          // action, so an empty one would write a nameless row. Fall back to the title.
          milestone_type: milestoneType.trim() || title.trim(),
          title: title.trim(),
          due_date: dueDate,
          description: description.trim() || undefined,
        })
        if (!res?.success) {
          setMessage({ kind: "error", text: (res as { error?: string })?.error ?? "Milestone not added." })
          return
        }
        setMessage({ kind: "ok", text: "Milestone added to this deal." })
        setTitle("")
        setMilestoneType("")
        setDueDate("")
        setDescription("")
        router.refresh()
      } catch (e) {
        setMessage({
          kind: "error",
          text: e instanceof Error ? e.message : "Milestone not added.",
        })
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a milestone</CardTitle>
        <CardDescription>
          For the one-off a template does not cover. The seeded milestone set comes from the
          catalog and is not edited here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ms-title">Title</Label>
            <Input
              id="ms-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="HOA estoppel letter received"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ms-date">Target date</Label>
            <Input
              id="ms-date"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ms-type">Type</Label>
          <Input
            id="ms-type"
            value={milestoneType}
            onChange={(e) => setMilestoneType(e.target.value)}
            placeholder="hoa_estoppel — defaults to the title"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ms-desc">Notes</Label>
          <Textarea
            id="ms-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="What has to be true for this to be done?"
          />
        </div>

        <Button onClick={submit} disabled={pending}>
          {pending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          Add milestone
        </Button>

        {message && (
          <p className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-emerald-600"}>
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
