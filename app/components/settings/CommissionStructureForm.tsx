'use client';

import React, { useState } from 'react';
import { createCommissionStructure } from '@/app/actions/settings/create-commission-structure';
import { SettingsCard } from './SettingsCard';

interface CommissionStructureFormProps {
  onSuccess: () => void;
}

export function CommissionStructureForm({ onSuccess }: CommissionStructureFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    commission_type: 'percentage',
    base_percentage: 0,
    base_amount: 0,
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: name === 'base_percentage' || name === 'base_amount' ? parseFloat(value) || 0 : value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const result = await createCommissionStructure(formData);
      if (result.error) {
        setError(result.error);
      } else {
        onSuccess();
        setFormData({
          name: '',
          description: '',
          commission_type: 'percentage',
          base_percentage: 0,
          base_amount: 0,
        });
      }
    } catch (err) {
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SettingsCard title="Create Commission Structure">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Structure Name</label>
          <input
            type="text"
            name="name"
            value={formData.name}
            onChange={handleChange}
            placeholder="e.g., Standard Commission"
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
          <textarea
            name="description"
            value={formData.description}
            onChange={handleChange}
            placeholder="Optional description"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Commission Type</label>
          <select
            name="commission_type"
            value={formData.commission_type}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            <option value="percentage">Percentage</option>
            <option value="flat">Flat Fee</option>
            <option value="tiered">Tiered</option>
          </select>
        </div>

        {formData.commission_type === 'percentage' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Base Percentage (%)</label>
            <input
              type="number"
              name="base_percentage"
              value={formData.base_percentage}
              onChange={handleChange}
              step="0.01"
              min="0"
              max="100"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
        )}

        {formData.commission_type === 'flat' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Base Amount ($)</label>
            <input
              type="number"
              name="base_amount"
              value={formData.base_amount}
              onChange={handleChange}
              step="0.01"
              min="0"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-2 px-6 rounded-lg transition-colors"
        >
          {loading ? 'Creating...' : 'Create Structure'}
        </button>
      </form>
    </SettingsCard>
  );
}
