import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, Mail, Plus, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { ErrorBox, Loading, PageHeader, StatusBadge } from '../components.js';
import type { Job, Page } from '../types.js';

export function Dashboard() {
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Record<string, number>>('/dashboard') });
  const jobs = useQuery({ queryKey: ['jobs', 1], queryFn: () => api<Page<Job>>('/jobs?page=1&pageSize=6') });
  if (dashboard.isLoading || jobs.isLoading) return <Loading />;
  if (dashboard.error || jobs.error) return <ErrorBox error={dashboard.error ?? jobs.error} />;
  const data = dashboard.data!;
  const cards = [
    ['Active jobs', data.active_jobs, Activity, 'blue'], ['Completed', data.completed_jobs, CheckCircle2, 'green'],
    ['People', data.users, Users, 'purple'], ['Active emails', data.active_emails, Mail, 'amber'],
    ['Errors · 24h', data.recent_errors, AlertTriangle, 'red']
  ] as const;
  return <>
    <PageHeader eyebrow="Workspace overview" title="Good morning." description="Your local GitHub collection pipeline at a glance."
      action={<Link className="button primary" to="/collect"><Plus size={16} />New collection</Link>} />
    <section className="stat-grid">{cards.map(([label, value, Icon, color]) => <div className="stat" key={label}>
      <div className={`stat-icon ${color}`}><Icon size={20} /></div><span>{label}</span><strong>{value?.toLocaleString() ?? 0}</strong>
    </div>)}</section>
    <section className="panel"><div className="panel-head"><div><h2>Recent jobs</h2><p>Latest collection activity</p></div><Link to="/jobs">View all</Link></div>
      <div className="table-wrap"><table><thead><tr><th>Job</th><th>Status</th><th>Phase</th><th>Inspected</th><th>Emails</th><th>Created</th></tr></thead>
      <tbody>{jobs.data!.items.map((job) => <tr key={job.id}><td><Link className="strong-link" to={`/jobs/${job.id}`}>{job.name || `GitHub · ${job.id.slice(0, 8)}`}</Link></td>
        <td><StatusBadge status={job.status} /></td><td>{job.phase.replaceAll('_', ' ')}</td><td>{job.counters_json.usersInspected ?? 0}</td>
        <td>{(job.counters_json.confirmedEmails ?? 0) + (job.counters_json.likelyEmails ?? 0) + (job.counters_json.unsureEmails ?? 0)}</td>
        <td>{new Date(job.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>
    </section>
  </>;
}
