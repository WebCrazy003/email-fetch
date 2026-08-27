import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, ListFilter, Pencil, Play, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, StatusBadge } from '../components.js';
import type { Job, SavedFilter } from '../types.js';

const activeStatuses = ['queued', 'running', 'paused', 'rate_limited', 'cancelling'];

function filterSummary(filters: Record<string, unknown>) {
  const labels: Record<string, string> = {
    location: 'Location', language: 'Language', followersMin: 'Followers from', followersMax: 'Followers to',
    repositoriesMin: 'Repos from', repositoriesMax: 'Repos to', createdFrom: 'Created from', createdTo: 'Created to',
    activityFrom: 'Active from', activityTo: 'Active to', keywords: 'Keywords', maxUsers: 'Max profiles'
  };
  return Object.entries(filters)
    .filter(([key, value]) => labels[key] && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0))
    .map(([key, value]) => `${labels[key]}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    .join(' · ');
}

export function FiltersPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['filters'], queryFn: () => api<SavedFilter[]>('/filters'), refetchInterval: 2_000 });
  const run = useMutation({
    mutationFn: (id: string) => api<Job>(`/filters/${id}/run`, { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['filters'] });
      void client.invalidateQueries({ queryKey: ['jobs'] });
    }
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  return <>
    <PageHeader eyebrow="Reusable searches" title="Filters" description="Save a filter once, then run it whenever you need fresh results. Every run appears as a job."
      action={<Link className="button primary" to="/filters/new"><Plus size={16} />New filter</Link>} />
    {run.error && <ErrorBox error={run.error} />}
    <section className="panel"><div className="table-wrap"><table><thead><tr><th>Filter</th><th>Criteria</th><th>Status</th><th>Runs</th><th>Users</th><th>Emails</th><th>Last run</th><th /></tr></thead>
      <tbody>{query.data!.map((filter) => {
        const counters = filter.latest_counters_json ?? {};
        const isActive = filter.latest_job_status ? activeStatuses.includes(filter.latest_job_status) : false;
        const users = (counters.newUsers ?? 0) + (counters.updatedUsers ?? 0);
        const emails = (counters.confirmedEmails ?? 0) + (counters.likelyEmails ?? 0) + (counters.unsureEmails ?? 0);
        return <tr key={filter.id}><td><div className="filter-name"><span className="filter-icon"><ListFilter size={15} /></span><div><strong>{filter.name}</strong><span>GitHub</span></div></div></td>
          <td className="filter-summary">{filterSummary(filter.filters_json) || 'All personal users'}</td>
          <td>{filter.latest_job_status ? <StatusBadge status={filter.latest_job_status} /> : <StatusBadge status="ready" />}</td>
          <td>{filter.run_count}</td><td>{users.toLocaleString()}</td><td>{emails.toLocaleString()}</td>
          <td>{filter.latest_job_created_at ? new Date(filter.latest_job_created_at).toLocaleString() : 'Never'}</td>
          <td><div className="actions"><Link className="button" to={`/filters/${filter.id}/edit`}><Pencil size={14} />Edit</Link>
            <Link className="button" to={`/filters/${filter.id}/duplicate`}><Copy size={14} />Duplicate</Link>
            <button className="button primary" disabled={isActive || (run.isPending && run.variables === filter.id)} onClick={() => run.mutate(filter.id)}><Play size={14} />{isActive ? 'Running' : run.isPending && run.variables === filter.id ? 'Starting…' : 'Run'}</button>
            {filter.latest_job_id && <Link className="button" to={`/jobs/${filter.latest_job_id}`}><Eye size={14} />Job</Link>}
            {filter.latest_job_id && !isActive && <Link className="button" to={`/users?jobId=${filter.latest_job_id}`}>Results</Link>}</div></td></tr>;
      })}</tbody></table></div>
      {!query.data!.length && <Empty title="No filters yet" detail="Create a filter, then run it from this page." />}
    </section>
  </>;
}
