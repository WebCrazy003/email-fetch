import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ListFilter, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, StatusBadge } from '../components.js';
import type { Job, SavedFilter } from '../types.js';

const activeStatuses = ['queued', 'running', 'paused', 'rate_limited', 'cancelling'];

function filterCriteria(filters: Record<string, unknown>) {
  const value = (key: string) => {
    const item = filters[key];
    return item === undefined || item === null || item === '' ? undefined : String(item);
  };
  const number = (key: string) => {
    const item = value(key);
    return item === undefined ? undefined : Number(item).toLocaleString();
  };
  const range = (label: string, fromKey: string, toKey: string, format = (item: string) => item) => {
    const from = value(fromKey); const to = value(toKey);
    if (from && to) return `${label}: ${format(from)}–${format(to)}`;
    if (from) return `${label}: from ${format(from)}`;
    return to ? `${label}: up to ${format(to)}` : undefined;
  };
  const criteria = [
    value('location') && `Location: ${value('location')}`,
    value('language') && `Language: ${value('language')}`,
    range('Followers', 'followersMin', 'followersMax', (item) => Number(item).toLocaleString()),
    range('Repositories', 'repositoriesMin', 'repositoriesMax', (item) => Number(item).toLocaleString()),
    range('Created', 'createdFrom', 'createdTo'),
    range('Activity', 'activityFrom', 'activityTo'),
    Array.isArray(filters.keywords) && filters.keywords.length > 0 && `Keywords: ${filters.keywords.join(', ')}`,
    filters.requirePublicEmail === true && 'Public email required',
    filters.excludePreviouslyProcessed === true && 'Skip processed profiles',
    value('discoveryPolicy') && `Discovery: ${value('discoveryPolicy') === 'direct' ? 'profile only' : value('discoveryPolicy') === 'guesses' ? 'linked site + guesses' : 'linked site'}`,
    value('minimumConfidence') && `Confidence: ${value('minimumConfidence')}+`,
    number('maxUsers') && `Maximum profiles: ${number('maxUsers')}`
  ];
  return criteria.filter((item): item is string => Boolean(item));
}

export function FiltersPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [expandedCriteria, setExpandedCriteria] = useState<Set<string>>(new Set());
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
        const criteria = filterCriteria(filter.filters_json);
        const expanded = expandedCriteria.has(filter.id);
        const visibleCriteria = expanded ? criteria : criteria.slice(0, 2);
        const toggleCriteria = () => setExpandedCriteria((current) => {
          const next = new Set(current);
          if (next.has(filter.id)) next.delete(filter.id); else next.add(filter.id);
          return next;
        });
        const selectAction = (action: string) => {
          if (action === 'edit') navigate(`/filters/${filter.id}/edit`);
          if (action === 'duplicate') navigate(`/filters/${filter.id}/duplicate`);
          if (action === 'run') run.mutate(filter.id);
          if (action === 'job' && filter.latest_job_id) navigate(`/jobs/${filter.latest_job_id}`);
          if (action === 'results' && filter.latest_job_id) navigate(`/users?jobId=${filter.latest_job_id}`);
        };
        return <tr key={filter.id}><td><div className="filter-name"><span className="filter-icon"><ListFilter size={15} /></span><div><strong>{filter.name}</strong><span>GitHub</span></div></div></td>
          <td><div className="criteria-cell"><span className="filter-summary">{visibleCriteria.join(' · ') || 'All personal users'}</span>
            {criteria.length > 2 && <button className="button ghost criteria-toggle" type="button" aria-expanded={expanded} onClick={toggleCriteria}>{expanded ? 'Show less' : `+${criteria.length - 2} more`}</button>}</div></td>
          <td>{filter.latest_job_status ? <StatusBadge status={filter.latest_job_status} /> : <StatusBadge status="ready" />}</td>
          <td>{filter.run_count}</td><td>{users.toLocaleString()}</td><td>{emails.toLocaleString()}</td>
          <td>{filter.latest_job_created_at ? new Date(filter.latest_job_created_at).toLocaleString() : 'Never'}</td>
          <td><select className="action-select" value="" aria-label={`Actions for ${filter.name}`} onChange={(event) => selectAction(event.target.value)}>
            <option value="" disabled>Actions</option><option value="edit">Edit</option><option value="duplicate">Duplicate</option>
            <option value="run" disabled={isActive || (run.isPending && run.variables === filter.id)}>{isActive ? 'Running' : 'Run'}</option>
            <option value="job" disabled={!filter.latest_job_id}>Job</option><option value="results" disabled={!filter.latest_job_id || isActive}>Results</option>
          </select></td></tr>;
      })}</tbody></table></div>
      {!query.data!.length && <Empty title="No filters yet" detail="Create a filter, then run it from this page." />}
    </section>
  </>;
}
