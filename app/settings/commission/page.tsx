'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { listCommissionStructures } from '@/app/actions/settings/list-commission-structures';
import { createCommissionStructure } from '@/app/actions/settings/create-commission-structure';
import { deleteCommissionStructure } from '@/app/actions/settings/delete-commission-structure';
import { COMMISSION_TYPES } from '@/app/lib/settings/default-settings';
import { Loader2, Plus, Trash2 } from 'lucide-react';

export default function CommissionPage() {
  const [loading, setLoading] = useState(true);
  const [structures, setStructures] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    commission_type: 'percentage',
    base_percentage: 0,
    base_amount: 0,
  });

  useEffect(() => {
    loadStructures();
  }, []);

  async function loadStructures() {
    try {
      const data = await listCommissionStructures();
      setStructures(data);
    } catch (err) {
      setError('Failed to load commission structures');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const result = await createCommissionStructure(formData);

    if (result.error) {
      setError(result.error);
    } else {
      setShowForm(false);
      setFormData({
        name: '',
        description: '',
        commission_type: 'percentage',
        base_percentage: 0,
        base_amount: 0,
      });
      await loadStructures();
    }

    setSaving(false);
  }

  async function handleDelete(id: string) {
    if (!confirm('Are you sure you want to delete this commission structure?')) {
      return;
    }

    const result = await deleteCommissionStructure(id);
    if (result.error) {
      setError(result.error);
    } else {
      await loadStructures();
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Commission Structures</h1>
          <p className="text-gray-600 mt-2">Manage commission rates and structures</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Structure
        </Button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-600">
          {error}
        </div>
      )}

      {showForm && (
        <Card className="p-6 mb-6">
          <form onSubmit={handleSubmit}>
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </div>

              <div>
                <Label htmlFor="commission_type">Type</Label>
                <Select
                  value={formData.commission_type}
                  onValueChange={(value) => setFormData({ ...formData, commission_type: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COMMISSION_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type.charAt(0).toUpperCase() + type.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {formData.commission_type === 'percentage' && (
                <div>
                  <Label htmlFor="base_percentage">Base Percentage</Label>
                  <Input
                    id="base_percentage"
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={formData.base_percentage}
                    onChange={(e) => setFormData({ ...formData, base_percentage: parseFloat(e.target.value) })}
                  />
                </div>
              )}

              {formData.commission_type === 'flat' && (
                <div>
                  <Label htmlFor="base_amount">Base Amount</Label>
                  <Input
                    id="base_amount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.base_amount}
                    onChange={(e) => setFormData({ ...formData, base_amount: parseFloat(e.target.value) })}
                  />
                </div>
              )}

              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create Structure
                </Button>
              </div>
            </div>
          </form>
        </Card>
      )}

      <div className="grid gap-4">
        {structures.map((structure) => (
          <Card key={structure.id} className="p-6">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900">{structure.name}</h3>
                <p className="text-sm text-gray-600 mt-1">{structure.description}</p>
                <div className="mt-3 flex gap-4 text-sm">
                  <span className="text-gray-700">
                    Type: <span className="font-medium">{structure.commission_type}</span>
                  </span>
                  {structure.commission_type === 'percentage' && (
                    <span className="text-gray-700">
                      Rate: <span className="font-medium">{structure.base_percentage}%</span>
                    </span>
                  )}
                  {structure.commission_type === 'flat' && (
                    <span className="text-gray-700">
                      Amount: <span className="font-medium">${structure.base_amount}</span>
                    </span>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(structure.id)}
              >
                <Trash2 className="h-4 w-4 text-red-600" />
              </Button>
            </div>
          </Card>
        ))}

        {structures.length === 0 && !showForm && (
          <div className="text-center py-12">
            <p className="text-gray-600">No commission structures yet. Create one to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}
