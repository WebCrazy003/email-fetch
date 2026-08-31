import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, StatusBadge } from '../components.js';
import type { EmailTemplate } from '../types.js';

export function TemplatesPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['email-templates'], queryFn: () => api<EmailTemplate[]>('/email-templates') });
  const duplicate = useMutation({
    mutationFn: (id: string) => api<EmailTemplate>(`/email-templates/${id}/duplicate`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['email-templates'] })
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/email-templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['email-templates'] })
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  return <><PageHeader eyebrow="Reusable messages" title="Email templates" description="Plain-text templates are snapshotted when a campaign starts."
    action={<Link className="button primary" to="/templates/new"><Plus size={16} />New template</Link>} />
    {(duplicate.error || remove.error) && <ErrorBox error={duplicate.error ?? remove.error} />}
    <section className="panel"><div className="table-wrap"><table><thead><tr><th>Template</th><th>Subject</th><th>Revision</th><th>Updated</th><th /></tr></thead><tbody>
      {query.data!.map((template) => <tr key={template.id}><td><div className="filter-name"><span className="filter-icon"><FileText size={15} /></span><div><strong>{template.name}</strong><span>{template.description || 'No description'}</span></div></div></td>
        <td>{template.subject}</td><td><StatusBadge status={`revision_${template.revision}`} /></td><td>{new Date(template.updated_at).toLocaleString()}</td>
        <td><div className="actions"><Link className="icon-button" title="Edit" to={`/templates/${template.id}/edit`}><Pencil size={14} /></Link>
          <button className="icon-button" title="Duplicate" onClick={() => duplicate.mutate(template.id)}><Copy size={14} /></button>
          <button className="icon-button danger" title="Delete" onClick={() => window.confirm(`Archive ${template.name}?`) && remove.mutate(template.id)}><Trash2 size={14} /></button></div></td></tr>)}
    </tbody></table></div>{!query.data!.length && <Empty title="No templates yet" detail="Create a template before sending an email campaign." />}</section>
  </>;
}

export function TemplateForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const existing = useQuery({ queryKey: ['email-template', id], queryFn: () => api<EmailTemplate>(`/email-templates/${id}`), enabled: Boolean(id) });
  const [name, setName] = useState(''); const [description, setDescription] = useState('');
  const [subject, setSubject] = useState(''); const [bodyText, setBodyText] = useState('');
  useEffect(() => {
    if (!existing.data) return;
    setName(existing.data.name); setDescription(existing.data.description); setSubject(existing.data.subject); setBodyText(existing.data.body_text);
  }, [existing.data]);
  const save = useMutation({
    mutationFn: () => api<EmailTemplate>(id ? `/email-templates/${id}` : '/email-templates', {
      method: id ? 'PATCH' : 'POST', body: JSON.stringify({ name, description, subject, bodyText })
    }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['email-templates'] }); navigate('/templates'); }
  });
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };
  if (id && existing.isLoading) return <Loading />;
  if (existing.error) return <ErrorBox error={existing.error} />;
  return <><PageHeader eyebrow="Email template" title={id ? 'Edit template' : 'New template'} description="Available merge fields: {{name}}, {{username}}, and {{email}}." />
    {save.error && <ErrorBox error={save.error} />}
    <form className="form-layout" onSubmit={submit}><div className="form-main"><section className="panel form-section"><div className="section-title"><span>1</span><div><h2>Template details</h2><p>Name and describe this reusable message.</p></div></div>
      <div className="fields two"><label className="field">Name<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Description<input maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="field full">Subject<input required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Hello {{name}}" /></label>
        <label className="field full">Plain-text message<textarea required maxLength={50000} rows={14} value={bodyText} onChange={(e) => setBodyText(e.target.value)} placeholder={'Hi {{name}},\n\nYour message…'} /></label></div></section></div>
      <aside className="form-side"><section className="panel sticky-card"><div className="summary-icon"><FileText size={18} /></div><h2>Plain text only</h2><p>Campaigns receive an immutable copy of this revision. Later edits do not alter queued or historical messages.</p>
        <button className="button primary wide" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save template'}</button><Link className="button wide" to="/templates">Cancel</Link></section></aside></form>
  </>;
}
