import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Mail, Pause, Play, Send, Square } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, campaignEventStreamUrl } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Pager, StatusBadge } from '../components.js';
import type { CampaignPreview, CampaignRecipient, EmailCampaign, EmailTemplate, GmailStatus, Page } from '../types.js';

function render(value: string, data: Record<string, string>) {
  return value.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, field: string) => data[field.trim()] ?? '');
}

export function NewCampaign() {
  const location = useLocation(); const navigate = useNavigate();
  const emailIds = ((location.state as { emailIds?: string[] } | null)?.emailIds ?? []);
  const templates = useQuery({ queryKey: ['email-templates'], queryFn: () => api<EmailTemplate[]>('/email-templates') });
  const gmail = useQuery({ queryKey: ['gmail-status'], queryFn: () => api<GmailStatus>('/email-providers/gmail/status') });
  const preview = useQuery({
    queryKey: ['campaign-preview', emailIds], queryFn: () => api<CampaignPreview>('/email-campaigns/selections', { method: 'POST', body: JSON.stringify({ emailIds }) }), enabled: emailIds.length > 0
  });
  const [templateId, setTemplateId] = useState(''); const [name, setName] = useState('');
  const [senderName, setSenderName] = useState('Richard Wang'); const [replyTo, setReplyTo] = useState(''); const [testRecipient, setTestRecipient] = useState('');
  useEffect(() => { if (!templateId && templates.data?.[0]) setTemplateId(templates.data[0].id); }, [templateId, templates.data]);
  useEffect(() => { const template = templates.data?.find((item) => item.id === templateId); if (template && !name) setName(`${template.name} · ${new Date().toLocaleDateString()}`); }, [name, templateId, templates.data]);
  useEffect(() => {
    const recipients = gmail.data?.testRecipients ?? [];
    if (!recipients.includes(testRecipient)) setTestRecipient(recipients[0] ?? '');
  }, [gmail.data?.testRecipients, testRecipient]);
  const create = useMutation({
    mutationFn: () => api<EmailCampaign>('/email-campaigns', { method: 'POST', body: JSON.stringify({ emailIds, templateId, name, senderName, replyTo, purpose: 'direct_outreach' }) }),
    onSuccess: (campaign) => navigate(`/campaigns/${campaign.id}`, { replace: true })
  });
  const test = useMutation({
    mutationFn: () => api<{ recipient: string }>('/email-providers/gmail/test', { method: 'POST', body: JSON.stringify({ templateId, senderName, replyTo, recipient: testRecipient }) })
  });
  if (!emailIds.length) return <><PageHeader eyebrow="Email campaign" title="No recipients selected" description="Select email addresses before creating a campaign." />
    <section className="panel empty"><Mail size={28} /><strong>Select emails first</strong><Link className="button primary" to="/emails">Open Emails</Link></section></>;
  if (templates.isLoading || gmail.isLoading || preview.isLoading) return <Loading />;
  if (templates.error || gmail.error || preview.error) return <ErrorBox error={templates.error ?? gmail.error ?? preview.error} />;
  const selectedTemplate = templates.data!.find((item) => item.id === templateId);
  const representative = preview.data!.recipients.find((item) => item.state === 'queued');
  const merge = { name: representative?.person_name || representative?.username || representative?.normalized_email.split('@')[0] || '', username: representative?.username || '', email: representative?.normalized_email || '' };
  const submit = (event: FormEvent) => { event.preventDefault(); create.mutate(); };
  return <><PageHeader eyebrow="Automatic Gmail sending" title="Review campaign" description="Choose a template and confirm the immutable message snapshot." />
    {!gmail.data!.connected && <ErrorBox error={new Error('Connect a Gmail sender account in Settings before sending.')} />}{(create.error || test.error) && <ErrorBox error={create.error ?? test.error} />}
    {test.isSuccess && <div className="success-box">Test email accepted by Gmail for {test.data.recipient}.</div>}
    <form className="campaign-layout" onSubmit={submit}><div className="form-main"><section className="panel form-section"><div className="section-title"><span>1</span><div><h2>Recipients</h2><p>Selected directly from the Emails page.</p></div></div>
      <div className="campaign-summary"><div><span>Selected</span><strong>{preview.data!.selected}</strong></div><div><span>Eligible</span><strong>{preview.data!.eligible}</strong></div><div><span>Excluded</span><strong>{preview.data!.excluded}</strong></div></div>
      {preview.data!.excluded > 0 && <div className="limit-note"><AlertTriangle size={14} />Suppressed, inactive, invalid, or previously contacted addresses will not be sent.</div>}</section>
      <section className="panel form-section"><div className="section-title"><span>2</span><div><h2>Template and sender</h2><p>Plain-text content is copied into the campaign.</p></div></div><div className="fields two">
        <label className="field full">Email template<select required value={templateId} onChange={(e) => setTemplateId(e.target.value)}><option value="">Choose template</option>{templates.data!.map((item) => <option key={item.id} value={item.id}>{item.name} · revision {item.revision}</option>)}</select></label>
        <label className="field full">Campaign name<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Sender display name<input required value={senderName} onChange={(e) => setSenderName(e.target.value)} /></label>
        <label className="field">Reply-to <small>optional</small><input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} /></label></div></section>
      <section className="panel form-section"><div className="section-title"><span>3</span><div><h2>Representative preview</h2><p>Merge fields are rendered separately for every recipient.</p></div></div>
        {selectedTemplate ? <div className="message-preview"><strong>{render(selectedTemplate.subject, merge)}</strong><pre>{`${render(selectedTemplate.body_text, merge)}\n\n--\n${senderName}\nTo opt out of future emails, reply with "unsubscribe".`}</pre></div> : <Empty title="Choose a template" />}</section></div>
      <aside className="form-side"><section className="panel sticky-card"><div className="summary-icon"><Send size={18} /></div><h2>Send automatically</h2><p>From {gmail.data!.connection?.account_address ?? 'no connected account'}. The browser may be closed after confirmation.</p>
        <div className="limit-note">100/day · 20/hour · at least 5 seconds apart · repeat contact blocked</div>
        <label className="field">Test recipient<select value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)}><option value="">Add a recipient in Settings</option>{gmail.data!.testRecipients.map((email) => <option value={email} key={email}>{email}</option>)}</select></label>
        <button type="button" className="button wide" disabled={!gmail.data!.connected || !selectedTemplate || !testRecipient || test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Sending test…' : 'Send test email'}</button>
        <button className="button primary wide" disabled={!gmail.data!.connected || !selectedTemplate || preview.data!.eligible === 0 || create.isPending}>{create.isPending ? 'Queueing…' : `Send to ${preview.data!.eligible}`}</button>
        <Link className="button wide" to="/emails">Cancel</Link></section></aside></form>
  </>;
}

export function CampaignsPage() {
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['email-campaigns', page], queryFn: () => api<Page<EmailCampaign>>(`/email-campaigns?page=${page}&pageSize=25`), refetchInterval: 2_000 });
  if (query.isLoading) return <Loading />; if (query.error) return <ErrorBox error={query.error} />;
  return <><PageHeader eyebrow="Automatic sending" title="Email campaigns" description="Gmail submission progress and recipient outcomes." />
    <section className="panel"><div className="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Template</th><th>Sent</th><th>Failed</th><th>Created</th></tr></thead><tbody>
      {query.data!.items.map((campaign) => <tr key={campaign.id}><td><Link className="strong-link" to={`/campaigns/${campaign.id}`}>{campaign.name}</Link></td><td><StatusBadge status={campaign.state} /></td><td>{campaign.template_name || 'Archived template'} · r{campaign.template_revision}</td>
        <td>{campaign.counters_json.sent ?? 0}</td><td>{campaign.counters_json.failed ?? 0}</td><td>{new Date(campaign.created_at).toLocaleString()}</td></tr>)}
    </tbody></table></div>{!query.data!.items.length && <Empty title="No campaigns yet" detail="Select recipients from the Emails page to begin." />}<Pager page={page} total={query.data!.total} pageSize={25} onPage={setPage} /></section>
  </>;
}

export function CampaignDetail() {
  const { id = '' } = useParams(); const client = useQueryClient(); const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['email-campaign', id], queryFn: () => api<EmailCampaign>(`/email-campaigns/${id}`) });
  const recipients = useQuery({ queryKey: ['campaign-recipients', id, page], queryFn: () => api<Page<CampaignRecipient>>(`/email-campaigns/${id}/recipients?page=${page}&pageSize=25`) });
  useEffect(() => { const stream = new EventSource(campaignEventStreamUrl(id)); stream.addEventListener('campaign', (event) => { client.setQueryData(['email-campaign', id], JSON.parse((event as MessageEvent).data)); void client.invalidateQueries({ queryKey: ['campaign-recipients', id] }); }); return () => stream.close(); }, [client, id]);
  const action = useMutation({ mutationFn: (name: string) => api<EmailCampaign>(`/email-campaigns/${id}/${name}`, { method: 'POST' }), onSuccess: (campaign) => client.setQueryData(['email-campaign', id], campaign) });
  if (query.isLoading || recipients.isLoading) return <Loading />; if (query.error || recipients.error) return <ErrorBox error={query.error ?? recipients.error} />;
  const campaign = query.data!; const counters = campaign.counters_json;
  const controls = <div className="actions">{campaign.state === 'paused' ? <button className="button" onClick={() => action.mutate('resume')}><Play size={14} />Resume</button> : ['queued','sending','provider_limited'].includes(campaign.state) && <button className="button" onClick={() => action.mutate('pause')}><Pause size={14} />Pause</button>}
    {['queued','sending','paused','provider_limited'].includes(campaign.state) && <button className="button danger" onClick={() => action.mutate('cancel')}><Square size={14} />Cancel</button>}</div>;
  return <><PageHeader eyebrow="Email campaign" title={campaign.name} description={`Created ${new Date(campaign.created_at).toLocaleString()} · ${campaign.account_address}`} action={controls} />
    {action.error && <ErrorBox error={action.error} />}<div className="job-hero panel"><div><StatusBadge status={campaign.state} /><h2>{campaign.template_name || 'Archived template'} · revision {campaign.template_revision}</h2><p>{campaign.failure_message || campaign.subject}</p></div><div className="pulse-dot" /></div>
    <section className="metric-grid">{[['Selected', counters.selected],['Queued', counters.queued],['Sending', counters.sending],['Sent', counters.sent],['Failed', counters.failed],['Skipped', counters.skipped]].map(([label,value]) => <div className="metric" key={label}><span>{label}</span><strong>{Number(value ?? 0).toLocaleString()}</strong></div>)}</section>
    <section className="panel"><div className="panel-head"><div><h2>Recipients</h2><p>Independent submission outcomes</p></div></div><div className="table-wrap"><table><thead><tr><th>Email</th><th>Status</th><th>Attempts</th><th>Result</th><th>Sent</th></tr></thead><tbody>
      {recipients.data!.items.map((recipient) => <tr key={recipient.id}><td>{recipient.normalized_email}</td><td><StatusBadge status={recipient.state} /></td><td>{recipient.attempt_count}</td><td>{recipient.skip_failure_reason || recipient.provider_message_id || '—'}</td><td>{recipient.sent_at ? new Date(recipient.sent_at).toLocaleString() : '—'}</td></tr>)}
    </tbody></table></div><Pager page={page} total={recipients.data!.total} pageSize={25} onPage={setPage} /></section>
    <section className="panel campaign-events"><div className="panel-head"><div><h2>Recent events</h2><p>Persisted activity and failures</p></div></div><div className="events">{campaign.recent_events?.map((event) => <div className="event" key={event.id}><span className={`event-dot ${event.level}`} /><div><strong>{event.message}</strong><span>{new Date(event.created_at).toLocaleString()}</span></div></div>)}</div></section>
  </>;
}
