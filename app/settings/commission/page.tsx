'use client';

import { useEffect, useState } from 'react';
import { listCommissionStructures } from '@/app/actions/settings/list-commission-structures';
import { CommissionStructureForm } from '@/app/components/settings/CommissionStructureForm';
import { CommissionStructureTable } from '@/app/components/settings/CommissionStructureTable';
import { RevenueShareToggle } from '@/app/components/settings/RevenueShareToggle';

export default function CommissionPage() {
  const [structures, setStructures] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadStructures = async () => {
    try {
      setLoading(true);
      const data = await listCommissionStructures();
      setStructures(data);
    } catch (err) {
      setError('Failed to load commission structures');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStructures();
  }, []);

  if (error) {
    return <div className="text-red-600">{error}</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Commission Structures</h1>
        <p className="text-gray-600 mt-2">Define how commissions are calculated</p>
      </div>

      <RevenueShareToggle />

      <CommissionStructureForm onSuccess={loadStructures} />

      {!loading && <CommissionStructureTable structures={structures} onRefresh={loadStructures} />}
    </div>
  );
}
