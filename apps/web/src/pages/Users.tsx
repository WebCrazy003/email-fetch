import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ExternalLink, Mail, Search, Send } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api, queryString } from '../api.js';
import { Badge, Empty, ErrorBox, Loading, PageHeader, Pager, StatusBadge } from '../components.js';
import type { Page, UserRecord } from '../types.js';

export function UsersPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1);
  const q = params.get('q') ?? ''; const location = params.get('location') ?? ''; const company = params.get('company') ?? '';
  const confidence = params.get('confidence') ?? ''; const discoveryType = params.get('discoveryType') ?? '';
  const emailStatus = params.get('emailStatus') ?? ''; const sendStatus = params.get('sendStatus') ?? '';
  const suppressed = params.get('suppressed') ?? '';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const url = useMemo(() => `/users?${queryString({ q, location, company, confidence, discoveryType, emailStatus, sendStatus, suppressed, page, pageSize: 25, recordHistory: page === 1 })}`,
    [q, location, company, confidence, discoveryType, emailStatus, sendStatus, suppressed, page]);
  const query = useQuery({ queryKey: ['users', url], queryFn: () => api<Page<UserRecord>>(url) });
  const patch = (key: string, value: string) => { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); if (key !== 'page') next.set('page', '1'); setParams(next); };
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  const items = query.data!.items;
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.person_id));
  return <><PageHeader eyebrow="Contact database" title="Collected users" description="Search profiles, inspect provenance, and find people who have never been emailed."
    action={selected.size > 0 && <button className="button primary" title="Campaign implementation is specified separately" disabled><Send size={16} />Send to {selected.size} selected</button>} />
    <section className="panel"><div className="filters"><label className="search-input"><Search size={16} /><input value={q} onChange={(e) => patch('q', e.target.value)} placeholder="Search login, name, company, location, or email" /></label>
      <input value={location} onChange={(e) => patch('location', e.target.value)} placeholder="Location" />
      <input value={company} onChange={(e) => patch('company', e.target.value)} placeholder="Company" />
      <select value={confidence} onChange={(e) => patch('confidence', e.target.value)}><option value="">All confidence</option><option value="confirmed">Confirmed</option><option value="likely">Likely</option><option value="unsure">Unsure</option></select>
      <select value={discoveryType} onChange={(e) => patch('discoveryType', e.target.value)}><option value="">Any discovery</option><option value="source_profile">GitHub profile</option><option value="linked_website">Linked website</option><option value="guessed">Guessed</option></select>
      <select value={emailStatus} onChange={(e) => patch('emailStatus', e.target.value)}><option value="">Any email state</option><option value="active">Active</option><option value="no_longer_public">No longer public</option><option value="invalid">Invalid</option><option value="suppressed">Suppressed</option></select>
      <select value={sendStatus} onChange={(e) => patch('sendStatus', e.target.value)}><option value="">Any send status</option><option value="never_sent">Never sent</option><option value="sent">Sent</option><option value="failed_latest_attempt">Latest failed</option><option value="suppressed">Suppressed</option></select>
      <select value={suppressed} onChange={(e) => patch('suppressed', e.target.value)}><option value="">Any user state</option><option value="false">Not suppressed</option><option value="true">Suppressed users</option></select>
      <button type="button" className={`button ${sendStatus === 'never_sent' ? 'primary' : ''}`} onClick={() => patch('sendStatus', sendStatus === 'never_sent' ? '' : 'never_sent')}><Mail size={14} />Never sent</button>
    </div><div className="table-wrap"><table><thead><tr><th className="checkbox"><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.person_id)))} /></th><th>User</th><th>Company / location</th><th>Emails</th><th>Reach</th><th>Checked</th></tr></thead>
      <tbody>{items.map((user) => <tr key={user.person_id}><td><input type="checkbox" checked={selected.has(user.person_id)} onChange={() => toggle(user.person_id)} /></td>
        <td><div className="user-cell">{user.avatar_url ? <img src={user.avatar_url} alt="" /> : <div className="avatar-fallback">{user.username[0]?.toUpperCase()}</div>}<div><strong>{user.display_name || user.username}</strong><a href={user.profile_url} target="_blank" rel="noreferrer">@{user.username}<ExternalLink size={11} /></a></div></div></td>
        <td><strong className="subtle-strong">{user.company || '—'}</strong><span className="muted">{user.location || 'Unknown location'}</span></td>
        <td><div className="email-stack">{user.emails.length ? user.emails.map((email) => <div key={email.email}><Mail size={13} /><span>{email.email}</span><StatusBadge status={email.confidence} /></div>) : <span className="muted">No email found</span>}</div></td>
        <td><span>{(user.followers ?? 0).toLocaleString()} followers</span><span className="muted">{user.public_repos ?? 0} repos</span></td>
        <td>{new Date(user.last_checked_at).toLocaleDateString()}</td></tr>)}</tbody></table></div>
      {!items.length && <Empty title="No users match" detail="Change the filters or run a collection." />}<Pager page={page} total={query.data!.total} pageSize={25} onPage={(value) => patch('page', String(value))} /></section>
    {selected.size > 0 && <div className="selection-bar"><Badge tone="info">{selected.size} users</Badge><span>All active emails will be included regardless of confidence.</span><button className="button" onClick={() => setSelected(new Set())}>Clear</button></div>}
  </>;
}
