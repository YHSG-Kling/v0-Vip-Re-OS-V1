'use client';

import { useEffect, useState } from 'react';
import { listCommissionStructures } from '@/app/actions/settings/list-commission-structures';
import { CommissionStructureForm } from '@/app/components/settings/CommissionStructureForm';
import { CommissionStructureTable } from '@/app/components/settings/CommissionStructureTable';
import { BenefitOfferingsCard } from '@/app/components/settings/BenefitOfferingsCard';

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
        <h1 className="text-3xl font-bold text-gray-900">Commission &amp; Offerings</h1>
        <p className="text-gray-600 mt-2">Define how commissions are calculated and mark what your brokerage offers agents</p>
      </div>

      {/* The ONE brokerage-offerings home (§6): residual income (revenue share),
          medical, retirement, and tax assistance — RevenueShareToggle merged into
          this card (see its tombstone header). */}
      <BenefitOfferingsCard />

      <CommissionStructureForm onSuccess={loadStructures} />

      {!loading && <CommissionStructureTable structures={structures} onRefresh={loadStructures} />}
    </div>
  );
}
