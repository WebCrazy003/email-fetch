import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Github, Info, Save, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { ErrorBox, PageHeader } from '../components.js';
import type { SavedFilter } from '../types.js';

type FormState = {
  name: string; location: string; language: string; followersMin: string; followersMax: string;
  repositoriesMin: string; repositoriesMax: string; createdFrom: string; createdTo: string;
  activityFrom: string; activityTo: string; keywords: string; requirePublicEmail: boolean;
  discoveryPolicy: 'direct' | 'linked_site' | 'guesses'; minimumConfidence: 'confirmed' | 'likely' | 'unsure';
  excludePreviouslyProcessed: boolean; maxUsers: string;
};

const initial: FormState = { name: '', location: '', language: '', followersMin: '', followersMax: '', repositoriesMin: '', repositoriesMax: '',
  createdFrom: '', createdTo: '', activityFrom: '', activityTo: '', keywords: '', requirePublicEmail: false,
  discoveryPolicy: 'linked_site', minimumConfidence: 'unsure', excludePreviouslyProcessed: false, maxUsers: '1000' };

function cleanNumber(value: string) { return value === '' ? undefined : Number(value); }

export function NewFilter() {
  const [form, setForm] = useState<FormState>(initial);
  const navigate = useNavigate();
  const mutation = useMutation({ mutationFn: (body: unknown) => api<SavedFilter>('/filters', { method: 'POST', body: JSON.stringify(body) }), onSuccess: () => navigate('/filters') });
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const preview = useMemo(() => {
    const parts = ['Personal GitHub users'];
    if (form.location) parts.push(`in ${form.location}`);
    if (form.language) parts.push(`using ${form.language}`);
    if (form.followersMin) parts.push(`with ${form.followersMin}+ followers`);
    parts.push(`inspect up to ${Number(form.maxUsers || 0).toLocaleString()}`);
    return parts.join(' · ');
  }, [form]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    mutation.mutate({ name: form.name, source: 'github', filters: {
      location: form.location || undefined, language: form.language || undefined,
      followersMin: cleanNumber(form.followersMin), followersMax: cleanNumber(form.followersMax),
      repositoriesMin: cleanNumber(form.repositoriesMin), repositoriesMax: cleanNumber(form.repositoriesMax),
      createdFrom: form.createdFrom || undefined, createdTo: form.createdTo || undefined,
      activityFrom: form.activityFrom || undefined, activityTo: form.activityTo || undefined,
      keywords: form.keywords.split(',').map((x) => x.trim()).filter(Boolean), requirePublicEmail: form.requirePublicEmail,
      discoveryPolicy: form.discoveryPolicy, minimumConfidence: form.minimumConfidence,
      excludePreviouslyProcessed: form.excludePreviouslyProcessed, maxUsers: Number(form.maxUsers)
    }});
  };
  return <>
    <PageHeader eyebrow="Saved GitHub search" title="New filter" description="Define and save who you want to find. You can run this filter from the filter list." />
    <form className="form-layout" onSubmit={submit}><div className="form-main">
      <section className="panel form-section"><div className="section-title"><span>01</span><div><h2>Filter</h2><p>Name and source</p></div></div>
        <label className="field full"><span>Filter name</span><input required maxLength={120} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Warsaw TypeScript developers" /></label>
        <div className="source-card"><div className="github-tile"><Github /></div><div><strong>GitHub</strong><span>Personal users only · Official API</span></div><span className="connected">Enabled</span></div>
      </section>
      <section className="panel form-section"><div className="section-title"><span>02</span><div><h2>Profile filters</h2><p>GitHub-native discovery filters</p></div></div>
        <div className="fields two"><label className="field"><span>Location</span><input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Poland or Warsaw" /></label>
          <label className="field"><span>Repository language</span><input value={form.language} onChange={(e) => set('language', e.target.value)} placeholder="TypeScript" /></label>
          <label className="field"><span>Followers · minimum</span><input type="number" min="0" value={form.followersMin} onChange={(e) => set('followersMin', e.target.value)} /></label>
          <label className="field"><span>Followers · maximum</span><input type="number" min="0" value={form.followersMax} onChange={(e) => set('followersMax', e.target.value)} /></label>
          <label className="field"><span>Repositories · minimum</span><input type="number" min="0" value={form.repositoriesMin} onChange={(e) => set('repositoriesMin', e.target.value)} /></label>
          <label className="field"><span>Repositories · maximum</span><input type="number" min="0" value={form.repositoriesMax} onChange={(e) => set('repositoriesMax', e.target.value)} /></label>
          <label className="field"><span>Created from</span><input type="date" value={form.createdFrom} onChange={(e) => set('createdFrom', e.target.value)} /></label>
          <label className="field"><span>Created to</span><input type="date" value={form.createdTo} onChange={(e) => set('createdTo', e.target.value)} /></label>
          <label className="field"><span>Last activity from</span><input type="date" value={form.activityFrom} onChange={(e) => set('activityFrom', e.target.value)} /></label>
          <label className="field"><span>Last activity to</span><input type="date" value={form.activityTo} onChange={(e) => set('activityTo', e.target.value)} /></label></div>
      </section>
      <section className="panel form-section"><div className="section-title"><span>03</span><div><h2>Enrichment</h2><p>Post-inspection and email discovery</p></div></div>
        <div className="fields two"><label className="field full"><span>Bio/company keywords <small>Comma separated</small></span><input value={form.keywords} onChange={(e) => set('keywords', e.target.value)} placeholder="founder, open source, AI" /></label>
          <label className="field"><span>Discovery depth</span><select value={form.discoveryPolicy} onChange={(e) => set('discoveryPolicy', e.target.value as FormState['discoveryPolicy'])}><option value="direct">GitHub profile only</option><option value="linked_site">Include linked website</option><option value="guesses">Linked website + guesses</option></select></label>
          <label className="field"><span>Minimum confidence</span><select value={form.minimumConfidence} onChange={(e) => set('minimumConfidence', e.target.value as FormState['minimumConfidence'])}><option value="unsure">Unsure or better</option><option value="likely">Likely or better</option><option value="confirmed">Confirmed only</option></select></label>
          <label className="check"><input type="checkbox" checked={form.requirePublicEmail} onChange={(e) => set('requirePublicEmail', e.target.checked)} /><div><strong>Require a publicly declared email</strong><span>Guesses will not satisfy this filter</span></div></label>
          <label className="check"><input type="checkbox" checked={form.excludePreviouslyProcessed} onChange={(e) => set('excludePreviouslyProcessed', e.target.checked)} /><div><strong>Exclude processed users</strong><span>Skip accounts already in the database</span></div></label></div>
      </section>
    </div><aside className="form-side"><section className="panel sticky-card"><div className="summary-icon"><Sparkles size={18} /></div><h2>Ready to save</h2><p>{preview}</p>
      <label className="field"><span>Maximum profiles</span><input type="number" required min="1" max="10000" value={form.maxUsers} onChange={(e) => set('maxUsers', e.target.value)} /></label>
      <div className="limit-note"><Info size={15} /> Maximum 10,000 profiles per run. Saving does not start a job.</div>
      {mutation.error && <ErrorBox error={mutation.error} />}<button className="button primary wide" disabled={mutation.isPending}><Save size={16} />{mutation.isPending ? 'Saving…' : 'Save filter'}</button>
    </section></aside></form>
  </>;
}
