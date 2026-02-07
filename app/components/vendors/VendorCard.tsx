'use client';

import React from 'react';

interface VendorCardProps {
  vendor: {
    id: string;
    company_name: string;
    description: string;
    logo_url?: string;
    category: string;
    status: string;
  };
  onSelect?: (vendorId: string) => void;
  showSubscribeButton?: boolean;
}

export function VendorCard({ vendor, onSelect, showSubscribeButton }: VendorCardProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">{vendor.company_name}</h3>
          <p className="text-sm text-gray-600 mt-1">{vendor.category}</p>
        </div>
        <span className={`text-xs px-2 py-1 rounded font-medium ${
          vendor.status === 'approved'
            ? 'bg-green-100 text-green-800'
            : vendor.status === 'pending'
            ? 'bg-yellow-100 text-yellow-800'
            : 'bg-gray-100 text-gray-800'
        }`}>
          {vendor.status.charAt(0).toUpperCase() + vendor.status.slice(1)}
        </span>
      </div>

      {vendor.description && (
        <p className="text-sm text-gray-700 mb-4">{vendor.description}</p>
      )}

      {showSubscribeButton && (
        <button
          onClick={() => onSelect?.(vendor.id)}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
        >
          View Plans
        </button>
      )}
    </div>
  );
}
