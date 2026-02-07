'use client';

import React, { useState } from 'react';
import { deleteCommissionStructure } from '@/app/actions/settings/delete-commission-structure';
import { SettingsCard } from './SettingsCard';

interface CommissionStructureTableProps {
  structures: any[];
  onRefresh: () => void;
}

export function CommissionStructureTable({ structures, onRefresh }: CommissionStructureTableProps) {
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this commission structure?')) {
      return;
    }

    setDeleting(id);
    try {
      await deleteCommissionStructure(id);
      onRefresh();
    } catch (err) {
      console.error('[v0] Error deleting commission structure:', err);
    } finally {
      setDeleting(null);
    }
  };

  if (!structures || structures.length === 0) {
    return (
      <SettingsCard title="Commission Structures">
        <p className="text-gray-600">No commission structures created yet.</p>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard title="Existing Commission Structures">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-900">Name</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-900">Type</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-900">Value</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-900">Status</th>
              <th className="text-right py-3 px-4 text-sm font-medium text-gray-900">Actions</th>
            </tr>
          </thead>
          <tbody>
            {structures.map((structure) => (
              <tr key={structure.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900">{structure.name}</p>
                  {structure.description && (
                    <p className="text-sm text-gray-600">{structure.description}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600 capitalize">
                  {structure.commission_type}
                </td>
                <td className="px-4 py-3 text-sm text-gray-900">
                  {structure.commission_type === 'percentage'
                    ? `${structure.base_percentage}%`
                    : structure.commission_type === 'flat'
                    ? `$${structure.base_amount}`
                    : 'Tiered'}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block text-xs px-2 py-1 rounded ${
                    structure.is_active
                      ? 'bg-green-100 text-green-800'
                      : 'bg-gray-100 text-gray-800'
                  }`}>
                    {structure.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button
                    onClick={() => handleDelete(structure.id)}
                    disabled={deleting === structure.id}
                    className="text-red-600 hover:text-red-700 disabled:text-gray-400 text-sm font-medium"
                  >
                    {deleting === structure.id ? 'Deleting...' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SettingsCard>
  );
}
