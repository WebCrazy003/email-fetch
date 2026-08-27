import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Database, LoaderCircle, XCircle } from 'lucide-react';

export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-header">
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>
    {action && <div>{action}</div>}
  </div>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone = ['completed', 'sent', 'active', 'confirmed'].includes(status) ? 'good'
    : ['failed', 'cancelled', 'invalid', 'deleted'].includes(status) ? 'bad'
      : ['running', 'queued', 'likely'].includes(status) ? 'info'
        : ['paused', 'rate_limited', 'completed_with_errors', 'unsure'].includes(status) ? 'warn' : 'neutral';
  const Icon = tone === 'good' ? CheckCircle2 : tone === 'bad' ? XCircle : tone === 'warn' ? AlertTriangle : tone === 'info' ? LoaderCircle : Clock3;
  return <Badge tone={tone}><Icon size={12} />{status.replaceAll('_', ' ')}</Badge>;
}

export function Empty({ title = 'Nothing here yet', detail }: { title?: string; detail?: string }) {
  return <div className="empty"><Database size={28} /><strong>{title}</strong>{detail && <span>{detail}</span>}</div>;
}

export function Loading() { return <div className="loading"><LoaderCircle className="spin" /> Loading…</div>; }

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="error-box"><AlertTriangle size={18} />{error instanceof Error ? error.message : 'Something went wrong'}</div>;
}

export function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage(page: number): void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="pager"><span>{total.toLocaleString()} results · Page {page} of {pages}</span><div>
    <button className="button ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
    <button className="button ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
  </div></div>;
}
