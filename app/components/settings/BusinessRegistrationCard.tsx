'use client';

// BUSINESS REGISTRATION — the branding setting carrier registration is pulled
// from (wave 84D; owner: "add the registration info needed for registration in
// as a branding setting so that info is pulled for registration.").
//
// Legal name / DBA / address / website / phone / e-mail are the brokerage's own
// record (saved through updateBrokerageIdentity — the same row the General
// settings "Brokerage Info" card edits); everything else is the registration
// record. The EIN is shown MASKED only — leave it blank to keep the one on file.
// Carrier registration (A2P 10DLC / toll-free) and the number-port form read
// these automatically; the hourly loop files the moment nothing is missing.

import React, { useEffect, useState } from 'react';
import { SettingsCard } from './SettingsCard';
import {
  getBusinessRegistrationAction,
  saveBusinessRegistrationAction,
  type BusinessRegistrationView,
} from '@/app/actions/settings/business-registration';
import {
  REGISTRATION_BUSINESS_TYPES,
  REGISTRATION_INDUSTRIES,
  REGISTRATION_REGIONS,
  REGISTRATION_COMPANY_TYPES,
  REGISTRATION_JOB_POSITIONS,
  REGISTRATION_DEFAULTS,
} from '@/lib/branding/business-registration';

type Field = { key: string; label: string; placeholder?: string; type?: string; options?: readonly string[]; hint?: string };

const IDENTITY_FIELDS: Field[] = [
  { key: 'name', label: 'Legal business name (exactly as on your IRS letter)' },
  { key: 'dba', label: 'DBA / brand name (optional)' },
  { key: 'address', label: 'Street address' },
  { key: 'address_line2', label: 'Suite / unit (optional)' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State (2 letters)', placeholder: 'TX' },
  { key: 'zip', label: 'ZIP' },
  { key: 'website', label: 'Website', placeholder: 'https://', type: 'url' },
  { key: 'email', label: 'Support e-mail', type: 'email' },
  { key: 'phone', label: 'Support phone', type: 'tel' },
];

const REGISTRATION_FIELDS: Field[] = [
  { key: 'ein', label: 'EIN (federal tax ID)', placeholder: 'XX-XXXXXXX', hint: 'Leave blank to keep the EIN on file.' },
  { key: 'businessType', label: 'Business type', options: REGISTRATION_BUSINESS_TYPES },
  { key: 'industry', label: 'Industry', options: REGISTRATION_INDUSTRIES },
  { key: 'regionsOfOperation', label: 'Regions of operation', options: REGISTRATION_REGIONS },
  { key: 'companyType', label: 'Company type', options: REGISTRATION_COMPANY_TYPES },
  { key: 'stockExchange', label: 'Stock exchange (public only)', placeholder: 'NASDAQ' },
  { key: 'stockTicker', label: 'Stock ticker (public only)' },
  { key: 'privacyPolicyUrl', label: 'Privacy policy URL (must mention SMS)', placeholder: 'https://…/privacy', type: 'url' },
  { key: 'termsUrl', label: 'Terms & conditions URL', placeholder: 'https://…/terms', type: 'url' },
  { key: 'socialMediaUrl', label: 'Social media profile URL (optional)', placeholder: 'https://', type: 'url' },
  { key: 'repFirstName', label: 'Authorized representative — first name' },
  { key: 'repLastName', label: 'Authorized representative — last name' },
  { key: 'repTitle', label: 'Representative title', placeholder: 'Broker / Owner' },
  { key: 'repJobPosition', label: 'Representative job position', options: REGISTRATION_JOB_POSITIONS },
  { key: 'repEmail', label: 'Representative e-mail', type: 'email' },
  { key: 'repPhone', label: 'Representative phone', type: 'tel' },
];

const SOURCE_LABEL: Record<string, string> = {
  owner_seat: 'from the owner seat',
  default: 'default',
  storefront: 'your storefront',
};

export function BusinessRegistrationCard() {
  const [view, setView] = useState<BusinessRegistrationView | null>(null);
  const [identity, setIdentity] = useState<Record<string, string>>({});
  const [reg, setReg] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hydrate = (v: BusinessRegistrationView) => {
    setView(v);
    setIdentity({ ...v.identity });
    const r: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.registration)) if (typeof val === 'string') r[k] = val;
    r.ein = '';
    for (const [k, d] of [['industry', REGISTRATION_DEFAULTS.industry], ['regionsOfOperation', REGISTRATION_DEFAULTS.regionsOfOperation], ['companyType', REGISTRATION_DEFAULTS.companyType], ['repJobPosition', REGISTRATION_DEFAULTS.repJobPosition]] as const) {
      if (!r[k]) r[k] = d;
    }
    setReg(r);
  };

  useEffect(() => {
    getBusinessRegistrationAction()
      .then((r) => (r.ok ? hydrate(r.view) : setLoadError(r.error)))
      .catch(() => setLoadError('Could not load business registration'));
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErrors([]); setNote(null);
    try {
      const r = await saveBusinessRegistrationAction({ identity, registration: reg });
      if (!r.ok) { setNote(r.error); setErrors(r.errors ?? []); }
      else { hydrate(r.view); setNote(r.view.missing.length ? 'Saved. Registration still needs the items listed above.' : 'Saved. Carrier registration will file within the hour.'); }
    } catch {
      setNote('Could not reach the server — nothing was saved.');
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <SettingsCard title="Business registration">
        <p className="text-sm text-gray-600">{loadError}</p>
      </SettingsCard>
    );
  }
  if (!view) return <SettingsCard title="Business registration"><p className="text-sm text-gray-500">Loading…</p></SettingsCard>;

  const canEdit = view.canEdit;
  const input = (f: Field, value: string, onChange: (v: string) => void, source?: string) => (
    <div key={f.key}>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {f.label}
        {source && SOURCE_LABEL[source] ? <span className="ml-1 text-xs font-normal text-gray-500">({SOURCE_LABEL[source]})</span> : null}
      </label>
      {f.options ? (
        <select disabled={!canEdit} value={value} onChange={(e) => onChange(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg">
          <option value="">— choose —</option>
          {f.options.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
        </select>
      ) : (
        <input disabled={!canEdit} type={f.type ?? 'text'} value={value} placeholder={f.key === 'ein' && view.einOnFile ? `${view.einMasked} on file` : f.placeholder}
          onChange={(e) => onChange(e.target.value)} autoComplete="off" className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
      )}
      {f.hint && f.key === 'ein' && view.einOnFile ? <p className="text-xs text-gray-500 mt-1">{f.hint}</p> : null}
    </div>
  );

  const isPublic = reg.companyType === 'public';

  return (
    <SettingsCard
      title="Business registration"
      description="Carriers require every business that texts to register its identity. We file your A2P 10DLC / toll-free registration from these details automatically — nothing to retype on the phone settings."
    >
      <form id="business-registration" onSubmit={save} className="space-y-6">
        {view.missing.length > 0 ? (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm">
            <p className="font-medium">Still needed before registration can file:</p>
            <ul className="list-disc ml-5">{view.missing.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        ) : (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">Everything carrier registration needs is on file.</div>
        )}

        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Business identity</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {IDENTITY_FIELDS.map((f) => input(f, identity[f.key] ?? '', (v) => setIdentity((p) => ({ ...p, [f.key]: v }))))}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Registration details</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {REGISTRATION_FIELDS.filter((f) => isPublic || (f.key !== 'stockExchange' && f.key !== 'stockTicker')).map((f) => {
              const profileKey = f.key.startsWith('rep') ? `contact${f.key.slice(3)}` : f.key;
              return input(f, reg[f.key] ?? '', (v) => setReg((p) => ({ ...p, [f.key]: v })), reg[f.key] ? undefined : view.sources[profileKey]);
            })}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            A blank representative uses the brokerage owner seat. {view.lastSavedAt ? `Last saved ${new Date(view.lastSavedAt).toLocaleString()}.` : 'Not saved yet.'}
          </p>
        </div>

        {errors.length > 0 && (
          <ul className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm list-disc ml-0 pl-8">
            {errors.map((m) => <li key={m}>{m}</li>)}
          </ul>
        )}
        {note && <p className="text-sm text-gray-700">{note}</p>}

        {canEdit && (
          <button type="submit" disabled={busy} className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-2 px-6 rounded-lg">
            {busy ? 'Saving…' : 'Save business registration'}
          </button>
        )}
      </form>
    </SettingsCard>
  );
}
