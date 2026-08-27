import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, Pencil, Play, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '../components.js';

interface History { id: string; context: string; filters_json: Record<string, unknown>; sort_json: Record<string, unknown>; label?: string; execution_count: number; last_executed_at: string; last_result_count?: number; }

export function HistoryPage() {
  const queryClient = useQueryClient(); const navigate = useNavigate();
  const query = useQuery({ queryKey: ['history'], queryFn: () => api<History[]>('/search-history') });
  const remove = useMutation({ mutationFn: (id: string) => api(`/search-history/${id}`, { method: 'DELETE' }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['history'] }) });
  const clear = useMutation({ mutationFn: () => api('/search-history', { method: 'DELETE' }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['history'] }) });
  const rename = useMutation({ mutationFn: ({ id, label }: { id: string; label: string | null }) => api(`/search-history/${id}`, { method: 'PATCH', body: JSON.stringify({ label }) }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['history'] }) });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  const run = (item: History) => {
    if (item.context === 'new_collection') navigate('/collect', { state: { filters: item.filters_json } });
    else { const params = new URLSearchParams(Object.entries(item.filters_json).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])); navigate(`/${item.context === 'emails' ? 'emails' : 'users'}?${params}`); }
  };
  return <><PageHeader eyebrow="Reusable filters" title="Search history" description="Logical searches are deduplicated; every execution remains recorded."
    action={query.data!.length > 0 && <button className="button danger" onClick={() => { if (window.confirm('Clear all search history?')) clear.mutate(); }}><Trash2 size={14} />Clear history</button>} />
    <section className="panel history-list">{query.data!.map((item) => <article key={item.id}><div className="history-icon"><Clock3 size={18} /></div><div className="history-main"><div><strong>{item.label || item.context.replaceAll('_', ' ')}</strong><Badge>{item.execution_count} runs</Badge></div>
      <p>{Object.entries(item.filters_json).filter(([, value]) => value !== undefined && value !== '' && (!Array.isArray(value) || value.length)).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`).join(' · ') || 'No filters'}</p>
      <span>Last run {new Date(item.last_executed_at).toLocaleString()} {item.last_result_count !== null && item.last_result_count !== undefined ? `· ${item.last_result_count} results` : ''}</span></div>
      <div className="actions"><button className="button" onClick={() => run(item)}><Play size={14} />Run again</button><button className="icon-button" title="Rename" onClick={() => { const label = window.prompt('Search name', item.label ?? ''); if (label !== null) rename.mutate({ id: item.id, label: label.trim() || null }); }}><Pencil size={15} /></button><button className="icon-button danger" title="Delete" onClick={() => { if (window.confirm('Delete this saved search?')) remove.mutate(item.id); }}><Trash2 size={15} /></button></div></article>)}
      {!query.data!.length && <Empty title="No saved searches" detail="Executed collection and table searches appear here." />}</section>
  </>;
}
