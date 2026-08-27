import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Copy, Search } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api, queryString } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Pager, StatusBadge } from '../components.js';
import type { EmailRecord, Page } from '../types.js';

export function EmailsPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1); const q = params.get('q') ?? ''; const domain = params.get('domain') ?? '';
  const status = params.get('status') ?? ''; const confidence = params.get('confidence') ?? '';
  const discoveryType = params.get('discoveryType') ?? ''; const sendStatus = params.get('sendStatus') ?? '';
  const url = useMemo(() => `/emails?${queryString({ q, domain, status, confidence, discoveryType, sendStatus, page, pageSize: 25 })}`,
    [q, domain, status, confidence, discoveryType, sendStatus, page]);
  const query = useQuery({ queryKey: ['emails', url], queryFn: () => api<Page<EmailRecord>>(url) });
  const patch = (key: string, value: string) => { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); if (key !== 'page') next.set('page', '1'); setParams(next); };
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  return <><PageHeader eyebrow="Canonical addresses" title="Emails" description="Globally deduplicated addresses with evidence-derived confidence." />
    <section className="panel"><div className="filters"><label className="search-input"><Search size={16} /><input value={q} onChange={(e) => patch('q', e.target.value)} placeholder="Search email or domain" /></label>
      <input value={domain} onChange={(e) => patch('domain', e.target.value)} placeholder="Domain" />
      <select value={status} onChange={(e) => patch('status', e.target.value)}><option value="">Any status</option><option value="active">Active</option><option value="no_longer_public">No longer public</option><option value="invalid">Invalid</option><option value="suppressed">Suppressed</option></select>
      <select value={confidence} onChange={(e) => patch('confidence', e.target.value)}><option value="">All confidence</option><option value="confirmed">Confirmed</option><option value="likely">Likely</option><option value="unsure">Unsure</option></select>
      <select value={discoveryType} onChange={(e) => patch('discoveryType', e.target.value)}><option value="">Any discovery</option><option value="source_profile">GitHub profile</option><option value="linked_website">Linked website</option><option value="guessed">Guessed</option></select>
      <select value={sendStatus} onChange={(e) => patch('sendStatus', e.target.value)}><option value="">Any send status</option><option value="never_sent">Never sent</option><option value="sent">Sent</option><option value="failed_latest_attempt">Latest failed</option><option value="suppressed">Suppressed</option></select>
      <button type="button" className={`button ${sendStatus === 'never_sent' ? 'primary' : ''}`} onClick={() => patch('sendStatus', sendStatus === 'never_sent' ? '' : 'never_sent')}><Search size={14} />Never sent</button></div>
      <div className="table-wrap"><table><thead><tr><th>Email</th><th>Confidence</th><th>Discovery</th><th>People</th><th>Send status</th><th>Last seen</th><th /></tr></thead><tbody>
        {query.data!.items.map((email) => <tr key={email.normalized_email}><td><strong>{email.normalized_email}</strong><span className="muted">{email.domain}</span></td><td><StatusBadge status={email.highest_confidence} /></td>
          <td>{email.best_discovery_type.replaceAll('_', ' ')}</td><td>{email.person_count}</td><td>{email.status === 'suppressed' ? <StatusBadge status="suppressed" /> : email.successful_send_count > 0 ? <StatusBadge status="sent" /> : <StatusBadge status="never_sent" />}</td>
          <td>{new Date(email.last_seen_at).toLocaleDateString()}</td><td><button className="icon-button" title="Copy" onClick={() => navigator.clipboard.writeText(email.normalized_email)}><Copy size={15} /></button></td></tr>)}</tbody></table></div>
      {!query.data!.items.length && <Empty title="No emails match" />}<Pager page={page} total={query.data!.total} pageSize={25} onPage={(value) => patch('page', String(value))} /></section>
  </>;
}
