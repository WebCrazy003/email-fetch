import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Github, HardDrive, KeyRound, LockKeyhole, Mail, Send, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { ErrorBox, Loading, PageHeader, StatusBadge } from '../components.js';
import type { EmailTemplate, GmailStatus } from '../types.js';

interface SettingsData { localOnly: boolean; authentication: boolean; exports: boolean; automaticRetention: boolean; githubConfigured: boolean; limits: Record<string, number>; freshnessDays: Record<string, number> }

export function SettingsPage() {
  const client = useQueryClient(); const [params] = useSearchParams();
  const query = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsData>('/settings') });
  const gmail = useQuery({ queryKey: ['gmail-status'], queryFn: () => api<GmailStatus>('/email-providers/gmail/status') });
  const templates = useQuery({ queryKey: ['email-templates'], queryFn: () => api<EmailTemplate[]>('/email-templates') });
  const [templateId, setTemplateId] = useState('');
  useEffect(() => { if (!templateId && templates.data?.[0]) setTemplateId(templates.data[0].id); }, [templateId, templates.data]);
  const connect = useMutation({ mutationFn: () => api<{ authorizationUrl: string }>('/email-providers/gmail/connect', { method: 'POST' }), onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl) });
  const disconnect = useMutation({ mutationFn: () => api('/email-providers/gmail/disconnect', { method: 'POST' }), onSuccess: () => client.invalidateQueries({ queryKey: ['gmail-status'] }) });
  const test = useMutation({ mutationFn: () => api('/email-providers/gmail/test', { method: 'POST', body: JSON.stringify({ templateId, senderName: 'Richard Wang', replyTo: '' }) }) });
  if (query.isLoading || gmail.isLoading || templates.isLoading) return <Loading />;
  if (query.error || gmail.error || templates.error) return <ErrorBox error={query.error ?? gmail.error ?? templates.error} />;
  const data = query.data!;
  return <><PageHeader eyebrow="Local configuration" title="Settings" description="Runtime status and fixed MVP safety boundaries." />
    {params.get('gmail') === 'connected' && <div className="success-box"><CheckCircle2 size={18} />Gmail account connected successfully.</div>}
    {params.get('gmail') === 'error' && <ErrorBox error={new Error(params.get('message') ?? 'Gmail connection failed')} />}
    {(connect.error || disconnect.error || test.error) && <ErrorBox error={connect.error ?? disconnect.error ?? test.error} />}
    {test.isSuccess && <div className="success-box"><CheckCircle2 size={18} />Test email accepted by Gmail.</div>}
    <div className="settings-grid"><section className="panel settings-card"><div className="settings-icon"><Github /></div><div><h2>GitHub API</h2><p>Official API · Personal users only</p></div><StatusBadge status={data.githubConfigured ? 'active' : 'unsure'} /><div className="settings-detail"><KeyRound size={15} />{data.githubConfigured ? 'Token configured through environment' : 'No token — unauthenticated limits apply'}</div></section>
      <section className="panel settings-card"><div className="settings-icon"><HardDrive /></div><div><h2>Local deployment</h2><p>Loopback-only operator workspace</p></div><StatusBadge status="active" /><div className="settings-detail"><LockKeyhole size={15} />No application login · Do not expose publicly</div></section>
      <section className="panel settings-card gmail-card"><div className="settings-icon"><Mail /></div><div><h2>Gmail sender</h2><p>{gmail.data!.connection?.account_address ?? 'One OAuth sender account'}</p></div><StatusBadge status={gmail.data!.connected ? 'active' : gmail.data!.configured ? 'ready' : 'invalid'} />
        <div className="settings-detail"><KeyRound size={15} />{gmail.data!.connected ? `Connected ${new Date(gmail.data!.connection!.connected_at).toLocaleString()}` : gmail.data!.configured ? 'OAuth credentials configured' : 'OAuth environment variables are missing'}</div>
        <div className="gmail-actions">{gmail.data!.connected ? <><select value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Test email template"><option value="">Choose a test template</option>{templates.data!.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</select>
          <button className="button" disabled={!templateId || !gmail.data!.testRecipientConfigured || test.isPending} onClick={() => test.mutate()}><Send size={14} />Send test</button>
          <button className="button danger" disabled={disconnect.isPending} onClick={() => window.confirm('Disconnect Gmail? Pending sends will fail.') && disconnect.mutate()}><Unplug size={14} />Disconnect</button></> : <button className="button primary" disabled={!gmail.data!.configured || connect.isPending} onClick={() => connect.mutate()}><Mail size={14} />Connect Gmail</button>}</div>
      </section></div>
    <section className="panel"><div className="panel-head"><div><h2>Collection limits</h2><p>Fixed safeguards from the product specification</p></div></div><div className="limit-grid">{Object.entries(data.limits).map(([key, value]) => <div key={key}><CheckCircle2 size={15} /><span>{key.replace(/([A-Z])/g, ' $1')}</span><strong>{value.toLocaleString()}</strong></div>)}</div></section>
    <section className="panel callout"><LockKeyhole /><div><h2>Storage policy</h2><p>Records remain in PostgreSQL until you manually delete them. There is no export endpoint and no automatic retention expiry. Independently created backups are your responsibility.</p></div></section>
  </>;
}
