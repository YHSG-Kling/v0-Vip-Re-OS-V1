'use client';

import React, { useState } from 'react';
import { updateGlobalSettings } from '@/app/actions/settings/update-global-settings';
import {
  updateBrokerageIdentity,
  type BrokerageIdentity,
} from '@/app/actions/settings/brokerage-identity';
import { US_STATES } from '@/lib/constants/us-states';
import { SettingsCard } from './SettingsCard';

interface GeneralSettingsFormProps {
  initialData: any;
  /**
   * The brokerage's own row (name, DBA, licence, address). Null when it could
   * not be read — the card then explains why instead of rendering blank inputs
   * that would fail to save.
   */
  initialIdentity: BrokerageIdentity | null;
  identityError?: string | null;
}

export function GeneralSettingsForm({
  initialData,
  initialIdentity,
  identityError,
}: GeneralSettingsFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // ── Brokerage identity — writes the `brokerages` row ───────────────────────
  // The name here is the LEGAL ENTITY name and it is written to
  // `brokerages.name`, the column the compliance/disclosure resolver reads.
  // `global_settings.app_name` is kept in step by the action; it is no longer a
  // second, independently editable "brokerage name". See the block comment in
  // app/actions/settings/brokerage-identity.ts for the reader counts behind that
  // direction.
  const canEdit = initialIdentity?.canEdit ?? false;
  const [identity, setIdentity] = useState({
    name: initialIdentity?.name ?? '',
    dba: initialIdentity?.dba ?? '',
    license_number: initialIdentity?.license_number ?? '',
    license_state: initialIdentity?.license_state ?? '',
    address: initialIdentity?.address ?? '',
    address_line2: initialIdentity?.address_line2 ?? '',
    city: initialIdentity?.city ?? '',
    state: initialIdentity?.state ?? '',
    zip: initialIdentity?.zip ?? '',
  });

  // ── Workspace formatting — writes the `global_settings` row ────────────────
  // app_name is deliberately absent: the brokerage name is now set once, above,
  // and mirrored into app_name by updateBrokerageIdentity. It was also removed
  // from the allow-list in app/actions/settings/update-global-settings.ts so this
  // surface cannot re-open the drift.
  const [formData, setFormData] = useState({
    timezone: initialData?.timezone || 'America/New_York',
    date_format: initialData?.date_format || 'MM/DD/YYYY',
    // Moved here from the orphaned /settings/global page, which was a superset
    // duplicating this form and the Branding form. Currency belongs with the other
    // workspace-formatting choices, not on a second page editing the same row.
    currency_symbol: initialData?.currency_symbol || '$',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleIdentityChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setIdentity((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess(false);

    try {
      // Identity first. If the database refuses it (RLS: only a broker/admin on
      // this brokerage may write the row), say so and do NOT go on to report a
      // successful save — the old card reported success on a resolved promise
      // without ever confirming a row had changed.
      const identityResult = await updateBrokerageIdentity({
        name: identity.name,
        dba: identity.dba,
        license_number: identity.license_number,
        license_state: identity.license_state,
        address: identity.address,
        address_line2: identity.address_line2,
        city: identity.city,
        state: identity.state,
        zip: identity.zip,
      });

      if (identityResult.error) {
        setError(identityResult.error);
        return;
      }

      const result = await updateGlobalSettings({
        id: initialData?.id,
        ...formData,
      });

      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      }
    } catch (err) {
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500';

  return (
    <SettingsCard
      title="Brokerage Info"
      description="Your brokerage's legal identity — the name, licence and address that appear on disclosures, marketing and client-facing documents."
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {identityError && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm">
            {identityError}
          </div>
        )}

        {initialIdentity && !canEdit && (
          <div className="bg-gray-50 border border-gray-200 text-gray-700 px-4 py-3 rounded-lg text-sm">
            You can see your brokerage&rsquo;s details but not change them. Only a broker or an
            admin on this brokerage can edit its name, licence and address.
          </div>
        )}

        <fieldset disabled={!canEdit} className="space-y-4">
          <legend className="sr-only">Brokerage identity</legend>

          <div>
            <label htmlFor="brokerage-name" className="block text-sm font-medium text-gray-700 mb-1">
              Brokerage Name <span className="text-red-600">*</span>
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Your legal entity name, exactly as it is licensed. This is the name used on
              disclosures and compliance checks, and the name your clients and agents see across
              the workspace, client portal, and outgoing emails and documents.
            </p>
            <input
              id="brokerage-name"
              type="text"
              name="name"
              value={identity.name}
              onChange={handleIdentityChange}
              placeholder="e.g., VIP Premier Realty LLC"
              required
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="brokerage-dba" className="block text-sm font-medium text-gray-700 mb-1">
              DBA / Trade Name <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Only if you advertise under a different name than the legal entity above. Leave
              blank if they are the same — this is not a second place to type your brokerage name.
            </p>
            <input
              id="brokerage-dba"
              type="text"
              name="dba"
              value={identity.dba}
              onChange={handleIdentityChange}
              placeholder="e.g., VIP Premier"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label
                htmlFor="brokerage-license-number"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Brokerage Licence Number
              </label>
              <input
                id="brokerage-license-number"
                type="text"
                name="license_number"
                value={identity.license_number}
                onChange={handleIdentityChange}
                placeholder="e.g., CQ1012345"
                className={inputClass}
              />
            </div>
            <div>
              <label
                htmlFor="brokerage-license-state"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Licence State
              </label>
              <select
                id="brokerage-license-state"
                name="license_state"
                value={identity.license_state}
                onChange={handleIdentityChange}
                className={inputClass}
              >
                <option value="">Select…</option>
                {US_STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-500 -mt-2">
            The licence the brokerage advertises under. It is required on disclosures in most
            states, and it appears in the attribution line on generated marketing.
          </p>

          <div className="pt-2">
            <h3 className="text-sm font-medium text-gray-900 mb-1">Brokerage Address</h3>
            <p className="text-xs text-gray-500 mb-3">
              The complete street address of your main office, as it should appear on documents
              and disclosures.
            </p>

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="brokerage-address"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Street Address
                </label>
                <input
                  id="brokerage-address"
                  type="text"
                  name="address"
                  value={identity.address}
                  onChange={handleIdentityChange}
                  placeholder="e.g., 1200 Palafox Street"
                  className={inputClass}
                />
              </div>

              <div>
                <label
                  htmlFor="brokerage-address-line2"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Suite / Unit <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  id="brokerage-address-line2"
                  type="text"
                  name="address_line2"
                  value={identity.address_line2}
                  onChange={handleIdentityChange}
                  placeholder="e.g., Suite 210"
                  className={inputClass}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label
                    htmlFor="brokerage-city"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    City
                  </label>
                  <input
                    id="brokerage-city"
                    type="text"
                    name="city"
                    value={identity.city}
                    onChange={handleIdentityChange}
                    placeholder="e.g., Pensacola"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label
                    htmlFor="brokerage-state"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    State
                  </label>
                  <select
                    id="brokerage-state"
                    name="state"
                    value={identity.state}
                    onChange={handleIdentityChange}
                    className={inputClass}
                  >
                    <option value="">Select…</option>
                    {US_STATES.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.code} — {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="brokerage-zip"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    ZIP
                  </label>
                  <input
                    id="brokerage-zip"
                    type="text"
                    name="zip"
                    value={identity.zip}
                    onChange={handleIdentityChange}
                    placeholder="e.g., 32502"
                    inputMode="numeric"
                    className={inputClass}
                  />
                </div>
              </div>
            </div>
          </div>
        </fieldset>

        <fieldset disabled={!canEdit} className="border-t border-gray-200 pt-6 space-y-4">
          <legend className="sr-only">Workspace formatting</legend>
          <div>
            <h3 className="text-sm font-medium text-gray-900">Workspace Formatting</h3>
            <p className="text-xs text-gray-500 mt-1">
              How dates, times and money are displayed across your workspace.
            </p>
          </div>

          <div>
            <label htmlFor="timezone" className="block text-sm font-medium text-gray-700 mb-2">
              Time Zone
            </label>
            <select
              id="timezone"
              name="timezone"
              value={formData.timezone}
              onChange={handleChange}
              className={inputClass}
            >
              <option value="America/New_York">Eastern Time</option>
              <option value="America/Chicago">Central Time</option>
              <option value="America/Denver">Mountain Time</option>
              <option value="America/Los_Angeles">Pacific Time</option>
            </select>
          </div>

          <div>
            <label htmlFor="date_format" className="block text-sm font-medium text-gray-700 mb-2">
              Date Format
            </label>
            <select
              id="date_format"
              name="date_format"
              value={formData.date_format}
              onChange={handleChange}
              className={inputClass}
            >
              <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              <option value="DD/MM/YYYY">DD/MM/YYYY</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="currency_symbol"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              Currency Symbol
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Shown on prices, commissions and financial reports across the workspace.
            </p>
            <input
              id="currency_symbol"
              type="text"
              name="currency_symbol"
              value={formData.currency_symbol}
              onChange={handleChange}
              maxLength={3}
              placeholder="$"
              className="w-24 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500"
            />
          </div>
        </fieldset>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
            Settings updated successfully!
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !canEdit}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-2 px-6 rounded-lg transition-colors"
        >
          {loading ? 'Saving...' : 'Save Settings'}
        </button>
      </form>
    </SettingsCard>
  );
}
