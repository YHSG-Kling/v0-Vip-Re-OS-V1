"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"
import { addRecruitingCost } from "@/app/actions/recruiting-roi"
import { useTransition } from "react"
import { toast } from "sonner"

// `brokerageId` prop REMOVED (2026-09-03): the action derives the tenant from the
// session (app/actions/recruiting-roi.ts, §4), so the page no longer hands one down.
//
// `agents` prop ADDED (2026-09-03, lane H4). Until now this form sent the typed
// "Recruit Name" (free text) as `recruitedAgentId` — a uuid column, and the id
// addRecruitingCost verifies against the tenant's agents — so the insert could
// never succeed: every submission ended in "Recruit not found in your brokerage".
// The page now reads the tenant's agents (listRecruitableAgents, gated the same
// way as the write) and the form submits the chosen agents.id. An empty list is
// named as such; it never falls back to a text box.
export type RecruitableAgent = { id: string; name: string; isActive: boolean }

export function CostEntryPanel({ agents }: { agents: RecruitableAgent[] }) {
  const [isOpen, setIsOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [formData, setFormData] = useState({
    cost_type: "training",
    amount: "",
    recruited_agent_id: "",
    notes: "",
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.amount || !formData.recruited_agent_id) {
      toast.error("Choose a recruit and enter an amount")
      return
    }

    startTransition(async () => {
      try {
        await addRecruitingCost(
          formData.recruited_agent_id,
          formData.cost_type,
          Math.round(parseFloat(formData.amount) * 100),
          formData.notes || undefined,
        )

        setFormData({ cost_type: "training", amount: "", recruited_agent_id: "", notes: "" })
        setIsOpen(false)
        toast.success("Cost added")
      } catch (error) {
        console.error("Error adding cost:", error)
        // The action's refusal is specific ("Recruit not found in your brokerage",
        // "Forbidden: …"); surface it rather than a generic failure.
        toast.error(error instanceof Error && error.message ? error.message : "Failed to add cost")
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Add Cost</span>
          <Button
            size="sm"
            onClick={() => setIsOpen(!isOpen)}
            variant={isOpen ? "secondary" : "default"}
          >
            <Plus className="h-4 w-4 mr-1" />
            New Entry
          </Button>
        </CardTitle>
      </CardHeader>
      {isOpen && (
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="recruiting-cost-recruit">
                Recruit
              </label>
              {agents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No agents could be listed for your brokerage, so a cost cannot be attributed yet.
                </p>
              ) : (
                <select
                  id="recruiting-cost-recruit"
                  required
                  value={formData.recruited_agent_id}
                  onChange={(e) => setFormData({ ...formData, recruited_agent_id: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select a recruit…</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.isActive ? a.name : `${a.name} (inactive)`}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Cost Type</label>
              <select
                value={formData.cost_type}
                onChange={(e) => setFormData({ ...formData, cost_type: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="recruiting_fee">Recruiting Fee</option>
                <option value="signing_bonus">Signing Bonus</option>
                <option value="training">Training</option>
                <option value="onboarding">Onboarding</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Amount ($)</label>
              <input
                type="number"
                required
                step="0.01"
                value={formData.amount}
                onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="0.00"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Notes (Optional)</label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                placeholder="Additional details..."
                rows={2}
              />
            </div>

            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={isPending || agents.length === 0}
                className="flex-1"
              >
                {isPending ? "Saving..." : "Add Cost"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsOpen(false)}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      )}
    </Card>
  )
}
