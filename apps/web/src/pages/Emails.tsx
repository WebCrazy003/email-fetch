import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Ban, Copy, Search, Send } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, queryString } from '../api.js';
import { Badge, Empty, ErrorBox, Loading, PageHeader, Pager, StatusBadge } from '../components.js';
import { countries } from '../countries.js';
import type { EmailRecord, Page } from '../types.js';

export function EmailsPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1); const q = params.get('q') ?? ''; const domain = params.get('domain') ?? ''; const country = params.get('country') ?? '';
  const status = params.get('status') ?? ''; const confidence = params.get('confidence') ?? '';
  const discoveryType = params.get('discoveryType') ?? ''; const sendStatus = params.get('sendStatus') ?? '';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectAllRef = useRef<HTMLInputElement>(null);
  const url = useMemo(() => `/emails?${queryString({ q, domain, country, status, confidence, discoveryType, sendStatus, page, pageSize: 25 })}`,
    [q, domain, country, status, confidence, discoveryType, sendStatus, page]);
  const query = useQuery({ queryKey: ['emails', url], queryFn: () => api<Page<EmailRecord>>(url) });
  const suppress = useMutation({
    mutationFn: (email: string) => api('/email-suppressions', { method: 'POST', body: JSON.stringify({ email, reason: 'Manual opt-out' }) }),
    onSuccess: async (_data, email) => { setSelected((current) => { const next = new Set(current); next.delete(email); return next; }); await client.invalidateQueries({ queryKey: ['emails'] }); }
  });
  const patch = (key: string, value: string) => { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); if (key !== 'page') next.set('page', '1'); setParams(next); };
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  const items = query.data!.items;
  const selectable = items.filter((email) => email.status === 'active');
  const allPageSelected = selectable.length > 0 && selectable.every((email) => selected.has(email.normalized_email));
  const somePageSelected = selectable.some((email) => selected.has(email.normalized_email));
  if (selectAllRef.current) selectAllRef.current.indeterminate = somePageSelected && !allPageSelected;
  const toggle = (email: string) => setSelected((current) => { const next = new Set(current); next.has(email) ? next.delete(email) : next.add(email); return next; });
  const togglePage = () => setSelected((current) => {
    const next = new Set(current);
    for (const email of selectable) allPageSelected ? next.delete(email.normalized_email) : next.add(email.normalized_email);
    return next;
  });
  return <><PageHeader eyebrow="Canonical addresses" title="Emails" description="Select individual addresses or all active addresses on this page, then send a template automatically."
    action={<button className="button primary" disabled={!selected.size} onClick={() => navigate('/campaigns/new', { state: { emailIds: [...selected] } })}><Send size={16} />Send email ({selected.size})</button>} />
    {suppress.error && <ErrorBox error={suppress.error} />}
    <section className="panel"><div className="filters"><label className="search-input"><Search size={16} /><input value={q} onChange={(e) => patch('q', e.target.value)} placeholder="Search email or domain" /></label>
      <input value={domain} onChange={(e) => patch('domain', e.target.value)} placeholder="Domain" />
      <select value={country} onChange={(e) => patch('country', e.target.value)} aria-label="Country"><option value="">All</option><option value="not_specified">Not specified</option>{countries.map((name) => <option key={name} value={name}>{name}</option>)}</select>
      <select value={status} onChange={(e) => patch('status', e.target.value)}><option value="">Any status</option><option value="active">Active</option><option value="no_longer_public">No longer public</option><option value="invalid">Invalid</option><option value="suppressed">Suppressed</option></select>
      <select value={confidence} onChange={(e) => patch('confidence', e.target.value)}><option value="">All confidence</option><option value="confirmed">Confirmed</option><option value="likely">Likely</option><option value="unsure">Unsure</option></select>
      <select value={discoveryType} onChange={(e) => patch('discoveryType', e.target.value)}><option value="">Any discovery</option><option value="source_profile">GitHub profile</option><option value="linked_website">Linked website</option><option value="guessed">Guessed</option></select>
      <select value={sendStatus} onChange={(e) => patch('sendStatus', e.target.value)}><option value="">Any send status</option><option value="never_sent">Never sent</option><option value="sent">Sent</option><option value="failed_latest_attempt">Latest failed</option><option value="suppressed">Suppressed</option></select>
      <button type="button" className={`button ${sendStatus === 'never_sent' ? 'primary' : ''}`} onClick={() => patch('sendStatus', sendStatus === 'never_sent' ? '' : 'never_sent')}><Search size={14} />Never sent</button></div>
      <div className="table-wrap"><table><thead><tr><th className="checkbox"><input ref={selectAllRef} type="checkbox" checked={allPageSelected} disabled={!selectable.length} aria-label="Select all active emails on this page" onChange={togglePage} /></th><th>Email</th><th>Confidence</th><th>Discovery</th><th>People</th><th>Send status</th><th>Sends</th><th>Last sent</th><th>Last seen</th><th /></tr></thead><tbody>
        {items.map((email) => <tr key={email.normalized_email}><td><input type="checkbox" disabled={email.status !== 'active'} checked={selected.has(email.normalized_email)} aria-label={`Select ${email.normalized_email}`} onChange={() => toggle(email.normalized_email)} /></td><td><strong>{email.normalized_email}</strong><span className="muted">{email.domain}</span></td><td><StatusBadge status={email.highest_confidence} /></td>
          <td>{email.best_discovery_type.replaceAll('_', ' ')}</td><td>{email.person_count}</td><td>{email.status === 'suppressed' ? <StatusBadge status="suppressed" /> : email.last_send_attempt_status === 'failed' ? <StatusBadge status="failed" /> : email.successful_send_count > 0 ? <StatusBadge status="sent" /> : <StatusBadge status="never_sent" />}</td>
          <td>{email.successful_send_count}</td><td>{email.last_sent_at ? <>{new Date(email.last_sent_at).toLocaleDateString()}{email.last_sent_campaign_id && <Link className="muted strong-link" to={`/campaigns/${email.last_sent_campaign_id}`}>Campaign</Link>}</> : 'Never'}</td>
          <td>{new Date(email.last_seen_at).toLocaleDateString()}</td><td><div className="actions"><button className="icon-button" title="Copy" onClick={() => navigator.clipboard.writeText(email.normalized_email)}><Copy size={15} /></button>
            {email.status === 'active' && <button className="icon-button danger" title="Suppress / opt out" onClick={() => window.confirm(`Suppress ${email.normalized_email}? Future campaigns will skip it.`) && suppress.mutate(email.normalized_email)}><Ban size={15} /></button>}</div></td></tr>)}</tbody></table></div>
      {!query.data!.items.length && <Empty title="No emails match" />}<Pager page={page} total={query.data!.total} pageSize={25} onPage={(value) => patch('page', String(value))} /></section>
    {selected.size > 0 && <div className="selection-bar"><Badge tone="info">{selected.size} emails</Badge><span>Only explicitly selected addresses are included.</span><button className="button primary" onClick={() => navigate('/campaigns/new', { state: { emailIds: [...selected] } })}><Send size={14} />Choose template</button><button className="button" onClick={() => setSelected(new Set())}>Clear</button></div>}
  </>;
}
