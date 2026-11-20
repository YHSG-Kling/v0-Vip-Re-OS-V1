"use client"

import { useState } from "react"
import {
  getErrorGroups,
  dismissErrorGroup,
  resolveErrorGroup,
} from "@/app/actions/error-handler"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ErrorGroupRow } from "@/app/components/admin/errors/ErrorGroupRow"
import { ErrorDetailsPanel } from "@/app/components/admin/errors/ErrorDetailsPanel"
import { AlertTriangle } from "lucide-react"

export default function ErrorHandlerClient() {
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
  const [filters, setFilters] = useState({
    severity: "",
    status: "active",
  })
  const [isLoading, setIsLoading] = useState(false)
  const [errorGroups, setErrorGroups] = useState<any[]>([])

  const loadErrors = async () => {
    setIsLoading(true)
    try {
      const data = await getErrorGroups({
        severity: filters.severity || undefined,
        status: filters.status || undefined,
        limit: 50,
      })
      setErrorGroups(data || [])
    } catch (error) {
      console.error("Error loading groups:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleDismiss = async (groupId: string) => {
    try {
      await dismissErrorGroup(groupId, "Dismissed by admin")
      await loadErrors()
      setSelectedGroup(null)
    } catch (error) {
      console.error("Error dismissing:", error)
    }
  }

  const handleResolve = async (groupId: string) => {
    try {
      await resolveErrorGroup(groupId, "Resolved by admin")
      await loadErrors()
      setSelectedGroup(null)
    } catch (error) {
      console.error("Error resolving:", error)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Error Groups List */}
      <div className="lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Error Groups</CardTitle>
            <CardDescription>Grouped and prioritized system errors</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Filters */}
            <div className="flex gap-2 mb-4">
              <select
                className="px-3 py-2 border border-input rounded-md text-sm"
                value={filters.severity}
                onChange={e => setFilters({ ...filters, severity: e.target.value })}
              >
                <option value="">All Severities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>

              <select
                className="px-3 py-2 border border-input rounded-md text-sm"
                value={filters.status}
                onChange={e => setFilters({ ...filters, status: e.target.value })}
              >
                <option value="active">Active</option>
                <option value="resolved">Resolved</option>
                <option value="dismissed">Dismissed</option>
              </select>

              <Button onClick={loadErrors} disabled={isLoading} size="sm">
                {isLoading ? "Loading..." : "Apply Filters"}
              </Button>
            </div>

            {/* Error Groups */}
            <div className="space-y-2 max-h-[600px] overflow-y-auto">
              {errorGroups.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No error groups found</p>
              ) : (
                errorGroups.map(group => (
                  <button
                    key={group.id}
                    onClick={() => setSelectedGroup(group.id)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedGroup === group.id
                        ? "bg-primary/10 border-primary"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    <ErrorGroupRow
                      group={group}
                      isSelected={selectedGroup === group.id}
                    />
                  </button>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Details Panel */}
      <div className="lg:col-span-1">
        {selectedGroup ? (
          <ErrorDetailsPanel
            groupId={selectedGroup}
            onDismiss={handleDismiss}
            onResolve={handleResolve}
          />
        ) : (
          <Card className="h-full flex items-center justify-center">
            <CardContent className="text-center py-8">
              <AlertTriangle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Select an error group to view details
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
