"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { updateTaxCategory, createTaxCategory } from "@/app/actions/accounting-sync"
import { useToast } from "@/hooks/use-toast"
import { Plus, Loader2, Edit2, Check, X, Settings2 } from "lucide-react"

interface TaxCategory {
  id: string
  category_name: string
  tax_code: string | null
  provider_account_id: string | null
  applies_to: string[] | null
  is_active: boolean
}

interface TaxCategoryManagerProps {
  categories: TaxCategory[]
  brokerageId: string
}

export function TaxCategoryManager({ categories, brokerageId }: TaxCategoryManagerProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [newCategory, setNewCategory] = useState({ name: "", taxCode: "", accountId: "" })
  const [creating, setCreating] = useState(false)
  const { toast } = useToast()

  const startEditing = (category: TaxCategory) => {
    setEditingId(category.id)
    setEditValues({
      taxCode: category.tax_code || "",
      accountId: category.provider_account_id || "",
    })
  }

  const cancelEditing = () => {
    setEditingId(null)
    setEditValues({})
  }

  const handleSave = async (categoryId: string) => {
    setSaving(categoryId)
    try {
      await updateTaxCategory({
        categoryId,
        brokerageId,
        taxCode: editValues.taxCode || undefined,
        providerAccountId: editValues.accountId || undefined,
      })
      toast({ title: "Saved", description: "Tax category updated" })
      setEditingId(null)
    } catch (error) {
      toast({ title: "Error", description: "Failed to save", variant: "destructive" })
    } finally {
      setSaving(null)
    }
  }

  const handleToggleActive = async (category: TaxCategory) => {
    setSaving(category.id)
    try {
      await updateTaxCategory({
        categoryId: category.id,
        brokerageId,
        isActive: !category.is_active,
      })
      toast({
        title: category.is_active ? "Deactivated" : "Activated",
        description: `${category.category_name} is now ${category.is_active ? "inactive" : "active"}`,
      })
    } catch (error) {
      toast({ title: "Error", description: "Failed to update", variant: "destructive" })
    } finally {
      setSaving(null)
    }
  }

  const handleCreate = async () => {
    if (!newCategory.name.trim()) {
      toast({ title: "Error", description: "Category name is required", variant: "destructive" })
      return
    }

    setCreating(true)
    try {
      await createTaxCategory({
        brokerageId,
        categoryName: newCategory.name.trim(),
        taxCode: newCategory.taxCode || undefined,
        providerAccountId: newCategory.accountId || undefined,
      })
      toast({ title: "Created", description: "New tax category added" })
      setAddDialogOpen(false)
      setNewCategory({ name: "", taxCode: "", accountId: "" })
    } catch (error) {
      toast({ title: "Error", description: "Failed to create category", variant: "destructive" })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-2" />
              Add Category
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Tax Category</DialogTitle>
              <DialogDescription>
                Create a new tax category mapping for your accounting provider
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Category Name</Label>
                <Input
                  id="name"
                  value={newCategory.name}
                  onChange={(e) => setNewCategory({ ...newCategory, name: e.target.value })}
                  placeholder="e.g., Commission Income"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="taxCode">Tax Code</Label>
                <Input
                  id="taxCode"
                  value={newCategory.taxCode}
                  onChange={(e) => setNewCategory({ ...newCategory, taxCode: e.target.value })}
                  placeholder="e.g., TAX001"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="accountId">Provider Account ID</Label>
                <Input
                  id="accountId"
                  value={newCategory.accountId}
                  onChange={(e) => setNewCategory({ ...newCategory, accountId: e.target.value })}
                  placeholder="e.g., 4000-00"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {categories.length === 0 ? (
        <div className="text-center py-8">
          <Settings2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">No tax categories configured</p>
          <p className="text-sm text-muted-foreground mt-1">
            Add categories to map your transactions to accounting codes
          </p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Tax Code</TableHead>
              <TableHead>Account ID</TableHead>
              <TableHead>Applies To</TableHead>
              <TableHead className="text-center">Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map((category) => (
              <TableRow key={category.id}>
                <TableCell className="font-medium">{category.category_name}</TableCell>
                <TableCell>
                  {editingId === category.id ? (
                    <Input
                      value={editValues.taxCode}
                      onChange={(e) => setEditValues({ ...editValues, taxCode: e.target.value })}
                      className="h-8 w-24"
                    />
                  ) : (
                    category.tax_code || <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {editingId === category.id ? (
                    <Input
                      value={editValues.accountId}
                      onChange={(e) => setEditValues({ ...editValues, accountId: e.target.value })}
                      className="h-8 w-24"
                    />
                  ) : (
                    category.provider_account_id || <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {category.applies_to?.map((item) => (
                      <Badge key={item} variant="secondary" className="text-xs">
                        {item}
                      </Badge>
                    )) || <span className="text-muted-foreground text-sm">All</span>}
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  <Switch
                    checked={category.is_active}
                    onCheckedChange={() => handleToggleActive(category)}
                    disabled={saving === category.id}
                  />
                </TableCell>
                <TableCell className="text-right">
                  {editingId === category.id ? (
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSave(category.id)}
                        disabled={saving === category.id}
                      >
                        {saving === category.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={cancelEditing}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => startEditing(category)}>
                      <Edit2 className="h-4 w-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
