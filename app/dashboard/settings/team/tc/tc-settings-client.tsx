"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "sonner"
import {
  Plus,
  UserCog,
  Trash2,
  Edit,
  AlertTriangle,
  ClipboardList,
  MapPin,
  Users,
} from "lucide-react"
import {
  createTransactionCoordinator,
  updateTransactionCoordinator,
  deleteTransactionCoordinator,
  assignTransactionToCoordinator,
  unassignTransactionFromCoordinator,
} from "./tc-actions"

interface Coordinator {
  id: string
  user_id: string | null
  brokerage_id: string
  display_name: string | null
  is_active: boolean
  max_active_deals: number
  created_at: string
}

interface User {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  role: string | null
}

interface Transaction {
  id: string
  property_address: string | null
  status: string | null
  stage: string | null
  close_date: string | null
  agent_id: string | null
}

interface Assignment {
  id: string
  transaction_id: string
  coordinator_id: string
  is_primary: boolean
  assigned_at: string
}

interface TCSettingsClientProps {
  coordinators: Coordinator[]
  users: User[]
  transactions: Transaction[]
  assignments: Assignment[]
  brokerageId: string
}

export function TCSettingsClient({
  coordinators: initialCoordinators,
  users,
  transactions,
  assignments: initialAssignments,
  brokerageId,
}: TCSettingsClientProps) {
  const [coordinators, setCoordinators] = useState(initialCoordinators)
  const [assignments, setAssignments] = useState(initialAssignments)
  const [isPending, startTransition] = useTransition()

  // Create/Edit Dialog State
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingCoordinator, setEditingCoordinator] = useState<Coordinator | null>(null)
  const [formData, setFormData] = useState({
    userId: "",
    displayName: "",
    maxActiveDeals: 25,
    isActive: true,
  })

  // Assignment Dialog State
  const [isAssignOpen, setIsAssignOpen] = useState(false)
  const [selectedCoordinator, setSelectedCoordinator] = useState<Coordinator | null>(null)
  const [selectedTransactionId, setSelectedTransactionId] = useState("")

  const resetForm = () => {
    setFormData({
      userId: "",
      displayName: "",
      maxActiveDeals: 25,
      isActive: true,
    })
    setEditingCoordinator(null)
  }

  const handleCreateOrUpdate = () => {
    startTransition(async () => {
      try {
        if (editingCoordinator) {
          const result = await updateTransactionCoordinator(editingCoordinator.id, {
            displayName: formData.displayName,
            maxActiveDeals: formData.maxActiveDeals,
            isActive: formData.isActive,
          })
          if (result.success) {
            setCoordinators((prev) =>
              prev.map((c) =>
                c.id === editingCoordinator.id
                  ? {
                      ...c,
                      display_name: formData.displayName,
                      max_active_deals: formData.maxActiveDeals,
                      is_active: formData.isActive,
                    }
                  : c
              )
            )
            toast.success("Coordinator updated successfully")
          } else {
            toast.error(result.error || "Failed to update coordinator")
          }
        } else {
          const result = await createTransactionCoordinator({
            userId: formData.userId || null,
            displayName: formData.displayName,
            maxActiveDeals: formData.maxActiveDeals,
            brokerageId,
          })
          if (result.success && result.coordinator) {
            setCoordinators((prev) => [...prev, result.coordinator!])
            toast.success("Coordinator created successfully")
          } else {
            toast.error(result.error || "Failed to create coordinator")
          }
        }
        setIsCreateOpen(false)
        resetForm()
      } catch (error) {
        toast.error("An unexpected error occurred")
      }
    })
  }

  const handleDelete = (coordinatorId: string) => {
    if (!confirm("Are you sure you want to delete this coordinator? All their assignments will also be removed.")) {
      return
    }
    startTransition(async () => {
      const result = await deleteTransactionCoordinator(coordinatorId)
      if (result.success) {
        setCoordinators((prev) => prev.filter((c) => c.id !== coordinatorId))
        setAssignments((prev) => prev.filter((a) => a.coordinator_id !== coordinatorId))
        toast.success("Coordinator deleted")
      } else {
        toast.error(result.error || "Failed to delete coordinator")
      }
    })
  }

  const handleAssign = () => {
    if (!selectedCoordinator || !selectedTransactionId) return

    startTransition(async () => {
      const result = await assignTransactionToCoordinator({
        transactionId: selectedTransactionId,
        coordinatorId: selectedCoordinator.id,
        brokerageId,
      })
      if (result.success && result.assignment) {
        setAssignments((prev) => [...prev, result.assignment!])
        toast.success("Transaction assigned successfully")
        setIsAssignOpen(false)
        setSelectedTransactionId("")
      } else {
        toast.error(result.error || "Failed to assign transaction")
      }
    })
  }

  const handleUnassign = (assignmentId: string) => {
    startTransition(async () => {
      const result = await unassignTransactionFromCoordinator(assignmentId)
      if (result.success) {
        setAssignments((prev) => prev.filter((a) => a.id !== assignmentId))
        toast.success("Assignment removed")
      } else {
        toast.error(result.error || "Failed to remove assignment")
      }
    })
  }

  const getCoordinatorAssignments = (coordinatorId: string) => {
    return assignments.filter((a) => a.coordinator_id === coordinatorId)
  }

  const getUnassignedTransactions = () => {
    const assignedIds = new Set(assignments.map((a) => a.transaction_id))
    return transactions.filter((t) => !assignedIds.has(t.id))
  }

  const getUserName = (userId: string | null) => {
    if (!userId) return null
    const user = users.find((u) => u.id === userId)
    return user ? `${user.first_name || ""} ${user.last_name || ""}`.trim() || user.email : null
  }

  const getTransactionById = (id: string) => transactions.find((t) => t.id === id)

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Transaction Coordinators</h1>
          <p className="text-muted-foreground">Manage TC profiles and transaction assignments</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={(open) => { setIsCreateOpen(open); if (!open) resetForm() }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add Coordinator
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingCoordinator ? "Edit Coordinator" : "Add Transaction Coordinator"}</DialogTitle>
              <DialogDescription>
                {editingCoordinator
                  ? "Update the coordinator profile settings."
                  : "Create a new TC profile. You can optionally link it to an existing user account."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              {!editingCoordinator && (
                <div className="space-y-2">
                  <Label htmlFor="userId">Link to User (Optional)</Label>
                  <Select
                    value={formData.userId}
                    onValueChange={(value) => {
                      setFormData((prev) => ({ ...prev, userId: value }))
                      if (value) {
                        const user = users.find((u) => u.id === value)
                        if (user && !formData.displayName) {
                          setFormData((prev) => ({
                            ...prev,
                            displayName: `${user.first_name || ""} ${user.last_name || ""}`.trim() || user.email || "",
                          }))
                        }
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a user or leave blank" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">No linked user</SelectItem>
                      {users.map((user) => (
                        <SelectItem key={user.id} value={user.id}>
                          {user.first_name || user.last_name
                            ? `${user.first_name || ""} ${user.last_name || ""}`.trim()
                            : user.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="displayName">Display Name</Label>
                <Input
                  id="displayName"
                  value={formData.displayName}
                  onChange={(e) => setFormData((prev) => ({ ...prev, displayName: e.target.value }))}
                  placeholder="e.g., Jane Smith"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxActiveDeals">Max Active Deals</Label>
                <Input
                  id="maxActiveDeals"
                  type="number"
                  min={1}
                  max={100}
                  value={formData.maxActiveDeals}
                  onChange={(e) => setFormData((prev) => ({ ...prev, maxActiveDeals: parseInt(e.target.value) || 25 }))}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum number of transactions this TC can handle at once
                </p>
              </div>
              {editingCoordinator && (
                <div className="flex items-center justify-between">
                  <Label htmlFor="isActive">Active</Label>
                  <Switch
                    id="isActive"
                    checked={formData.isActive}
                    onCheckedChange={(checked) => setFormData((prev) => ({ ...prev, isActive: checked }))}
                  />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setIsCreateOpen(false); resetForm() }}>
                Cancel
              </Button>
              <Button onClick={handleCreateOrUpdate} disabled={isPending || !formData.displayName}>
                {editingCoordinator ? "Save Changes" : "Create Coordinator"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Coordinators List */}
      <div className="grid gap-4">
        {coordinators.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center">
              <UserCog className="h-12 w-12 mx-auto mb-3 opacity-20" />
              <p className="text-muted-foreground">No transaction coordinators configured yet.</p>
              <p className="text-sm text-muted-foreground mt-1">
                Click "Add Coordinator" to create your first TC profile.
              </p>
            </CardContent>
          </Card>
        ) : (
          coordinators.map((coordinator) => {
            const tcAssignments = getCoordinatorAssignments(coordinator.id)
            const activeCount = tcAssignments.length
            const capacityUsed = (activeCount / coordinator.max_active_deals) * 100
            const isAtCapacity = activeCount >= coordinator.max_active_deals

            return (
              <Card key={coordinator.id} className={!coordinator.is_active ? "opacity-60" : ""}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                        <UserCog className="h-5 w-5 text-blue-600" />
                      </div>
                      <div>
                        <CardTitle className="text-lg flex items-center gap-2">
                          {coordinator.display_name || "Unnamed Coordinator"}
                          {!coordinator.is_active && (
                            <Badge variant="secondary">Inactive</Badge>
                          )}
                          {isAtCapacity && coordinator.is_active && (
                            <Badge variant="destructive" className="gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              At Capacity
                            </Badge>
                          )}
                        </CardTitle>
                        <CardDescription>
                          {getUserName(coordinator.user_id) || "No linked user"}
                          {" | "}
                          {activeCount} / {coordinator.max_active_deals} deals
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingCoordinator(coordinator)
                          setFormData({
                            userId: coordinator.user_id || "",
                            displayName: coordinator.display_name || "",
                            maxActiveDeals: coordinator.max_active_deals,
                            isActive: coordinator.is_active,
                          })
                          setIsCreateOpen(true)
                        }}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-red-600 hover:text-red-700"
                        onClick={() => handleDelete(coordinator.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {/* Capacity Warning */}
                  {capacityUsed > 80 && (
                    <div className="flex items-center gap-2 mb-4 p-2 bg-amber-50 border border-amber-200 rounded-md">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      <span className="text-sm text-amber-700">
                        This coordinator is at {capacityUsed.toFixed(0)}% capacity. Consider reassigning transactions.
                      </span>
                    </div>
                  )}

                  {/* Assignments */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-medium flex items-center gap-2">
                        <ClipboardList className="h-4 w-4" />
                        Assigned Transactions ({tcAssignments.length})
                      </h4>
                      <Dialog
                        open={isAssignOpen && selectedCoordinator?.id === coordinator.id}
                        onOpenChange={(open) => {
                          setIsAssignOpen(open)
                          if (open) setSelectedCoordinator(coordinator)
                          else setSelectedTransactionId("")
                        }}
                      >
                        <DialogTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isAtCapacity || !coordinator.is_active}
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            Assign
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Assign Transaction</DialogTitle>
                            <DialogDescription>
                              Select a transaction to assign to {coordinator.display_name}
                            </DialogDescription>
                          </DialogHeader>
                          <div className="py-4">
                            <Select
                              value={selectedTransactionId}
                              onValueChange={setSelectedTransactionId}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Select a transaction" />
                              </SelectTrigger>
                              <SelectContent>
                                {getUnassignedTransactions().length === 0 ? (
                                  <div className="p-2 text-center text-sm text-muted-foreground">
                                    All transactions are already assigned
                                  </div>
                                ) : (
                                  getUnassignedTransactions().map((txn) => (
                                    <SelectItem key={txn.id} value={txn.id}>
                                      {txn.property_address || "Unknown Address"}
                                    </SelectItem>
                                  ))
                                )}
                              </SelectContent>
                            </Select>
                          </div>
                          <DialogFooter>
                            <Button variant="outline" onClick={() => setIsAssignOpen(false)}>
                              Cancel
                            </Button>
                            <Button onClick={handleAssign} disabled={isPending || !selectedTransactionId}>
                              Assign Transaction
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </div>

                    {tcAssignments.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No transactions assigned yet</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Property</TableHead>
                            <TableHead>Stage</TableHead>
                            <TableHead>Close Date</TableHead>
                            <TableHead className="w-20"></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {tcAssignments.map((assignment) => {
                            const txn = getTransactionById(assignment.transaction_id)
                            if (!txn) return null
                            return (
                              <TableRow key={assignment.id}>
                                <TableCell className="flex items-center gap-2">
                                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                                  <span className="truncate max-w-48">{txn.property_address || "Unknown"}</span>
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline">{txn.stage || txn.status || "Unknown"}</Badge>
                                </TableCell>
                                <TableCell>
                                  {txn.close_date
                                    ? new Date(txn.close_date).toLocaleDateString()
                                    : "TBD"}
                                </TableCell>
                                <TableCell>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-red-600 hover:text-red-700"
                                    onClick={() => handleUnassign(assignment.id)}
                                    disabled={isPending}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>
    </div>
  )
}
