import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Github, HardDrive, KeyRound, LockKeyhole } from 'lucide-react';
import { api } from '../api.js';
import { ErrorBox, Loading, PageHeader, StatusBadge } from '../components.js';

interface SettingsData { localOnly: boolean; authentication: boolean; exports: boolean; automaticRetention: boolean; githubConfigured: boolean; limits: Record<string, number>; freshnessDays: Record<string, number> }

export function SettingsPage() {
  const query = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsData>('/settings') });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  const data = query.data!;
  return <><PageHeader eyebrow="Local configuration" title="Settings" description="Runtime status and fixed MVP safety boundaries." />
    <div className="settings-grid"><section className="panel settings-card"><div className="settings-icon"><Github /></div><div><h2>GitHub API</h2><p>Official API · Personal users only</p></div><StatusBadge status={data.githubConfigured ? 'active' : 'unsure'} /><div className="settings-detail"><KeyRound size={15} />{data.githubConfigured ? 'Token configured through environment' : 'No token — unauthenticated limits apply'}</div></section>
      <section className="panel settings-card"><div className="settings-icon"><HardDrive /></div><div><h2>Local deployment</h2><p>Loopback-only operator workspace</p></div><StatusBadge status="active" /><div className="settings-detail"><LockKeyhole size={15} />No application login · Do not expose publicly</div></section></div>
    <section className="panel"><div className="panel-head"><div><h2>Collection limits</h2><p>Fixed safeguards from the product specification</p></div></div><div className="limit-grid">{Object.entries(data.limits).map(([key, value]) => <div key={key}><CheckCircle2 size={15} /><span>{key.replace(/([A-Z])/g, ' $1')}</span><strong>{value.toLocaleString()}</strong></div>)}</div></section>
    <section className="panel callout"><LockKeyhole /><div><h2>Storage policy</h2><p>Records remain in PostgreSQL until you manually delete them. There is no export endpoint and no automatic retention expiry. Independently created backups are your responsibility.</p></div></section>
  </>;
}
