import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Pause, Play, Plus, Square } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api, eventStreamUrl } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Pager, StatusBadge } from '../components.js';
import type { Job, Page } from '../types.js';

export function Jobs() {
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['jobs', page], queryFn: () => api<Page<Job>>(`/jobs?page=${page}&pageSize=25`) });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  return <><PageHeader eyebrow="Background work" title="Collection jobs" description="Resumable GitHub discovery and enrichment jobs."
    action={<Link className="button primary" to="/collect"><Plus size={16} />New collection</Link>} />
    <section className="panel"><div className="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th>Phase</th><th>Discovered</th><th>Inspected</th><th>Errors</th><th>Created</th></tr></thead>
      <tbody>{query.data!.items.map((job) => <tr key={job.id}><td><Link className="strong-link" to={`/jobs/${job.id}`}>{job.name || `GitHub · ${job.id.slice(0, 8)}`}</Link></td><td><StatusBadge status={job.status} /></td>
        <td>{job.phase.replaceAll('_', ' ')}</td><td>{job.counters_json.candidatesDiscovered ?? 0}</td><td>{job.counters_json.usersInspected ?? 0}</td><td>{job.counters_json.errors ?? 0}</td><td>{new Date(job.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>
      {!query.data!.items.length && <Empty detail="Start your first GitHub collection." />}<Pager page={page} total={query.data!.total} pageSize={25} onPage={setPage} /></section>
  </>;
}

export function JobDetail() {
  const { id = '' } = useParams();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['job', id], queryFn: () => api<Job>(`/jobs/${id}`) });
  useEffect(() => {
    const stream = new EventSource(eventStreamUrl(id));
    stream.addEventListener('job', (event) => client.setQueryData(['job', id], JSON.parse((event as MessageEvent).data)));
    return () => stream.close();
  }, [client, id]);
  const action = useMutation({ mutationFn: (name: string) => api<Job>(`/jobs/${id}/${name}`, { method: 'POST' }), onSuccess: (job) => client.setQueryData(['job', id], job) });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  const job = query.data!; const c = job.counters_json;
  const controls = <div className="actions">{job.status === 'paused' ? <button className="button" onClick={() => action.mutate('resume')}><Play size={15} />Resume</button>
    : ['running','queued','rate_limited'].includes(job.status) && <button className="button" onClick={() => action.mutate('pause')}><Pause size={15} />Pause</button>}
    {['running','queued','paused','rate_limited'].includes(job.status) && <button className="button danger" onClick={() => action.mutate('cancel')}><Square size={14} />Cancel</button>}</div>;
  const metrics = [
    ['Discovered', c.candidatesDiscovered], ['Inspected', c.usersInspected], ['Public email', c.usersWithPublicEmail],
    ['Confirmed', c.confirmedEmails], ['Likely', c.likelyEmails], ['Unsure', c.unsureEmails], ['Guessed', c.guessedEmails],
    ['New users', c.newUsers], ['Updated', c.updatedUsers], ['Duplicates', c.duplicateEmails], ['Suppressed', c.suppressed],
    ['Skipped', c.skipped], ['Requests', c.requests], ['Retries', c.retries], ['Errors', c.errors]
  ];
  return <><PageHeader eyebrow="Collection job" title={job.name || `GitHub · ${job.id.slice(0, 8)}`} description={`Created ${new Date(job.created_at).toLocaleString()}`} action={controls} />
    <div className="job-hero panel"><div><StatusBadge status={job.status} /><h2>{job.phase.replaceAll('_', ' ')}</h2><p>{job.failure_message || `Checkpoint: ${String(job.checkpoint_json.lastLogin ?? 'waiting')}`}</p></div>
      <div className="pulse-dot" /></div>
    <section className="metric-grid">{metrics.map(([name, value]) => <div className="metric" key={name}><span>{name}</span><strong>{Number(value ?? 0).toLocaleString()}</strong></div>)}</section>
    <div className="detail-grid"><section className="panel"><div className="panel-head"><div><h2>Filters</h2><p>Immutable job definition</p></div></div><pre className="json">{JSON.stringify(job.filters_json, null, 2)}</pre></section>
      <section className="panel"><div className="panel-head"><div><h2>Recent events</h2><p>Live persisted activity</p></div></div><div className="events">{job.recent_events?.map((event) => <div className="event" key={event.id}><span className={`event-dot ${event.level}`} /><div><strong>{event.message}</strong><span>{new Date(event.created_at).toLocaleTimeString()}</span></div></div>)}</div></section></div>
  </>;
}
