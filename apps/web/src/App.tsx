import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Activity, Database, Github, LayoutDashboard, ListFilter, Mail, Settings, Users } from 'lucide-react';
import { Dashboard } from './pages/Dashboard.js';
import { NewFilter } from './pages/NewCollection.js';
import { FiltersPage } from './pages/Filters.js';
import { Jobs, JobDetail } from './pages/Jobs.js';
import { UsersPage } from './pages/Users.js';
import { EmailsPage } from './pages/Emails.js';
import { SettingsPage } from './pages/Settings.js';

const links = [
  ['/', LayoutDashboard, 'Dashboard'], ['/filters', ListFilter, 'Filters'], ['/jobs', Activity, 'Jobs'],
  ['/users', Users, 'Users'], ['/emails', Mail, 'Emails'], ['/settings', Settings, 'Settings']
] as const;

export function App() {
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Github size={20} /></div><div><strong>Email Fetch</strong><span>Local workspace</span></div></div>
      <nav>{links.map(([to, Icon, label]) => <NavLink key={to} to={to} end={to === '/'}><Icon size={18} />{label}</NavLink>)}</nav>
      <div className="local-note"><Database size={16} /><div><strong>Local-only MVP</strong><span>No login · no export</span></div></div>
    </aside>
    <main className="content">
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/filters" element={<FiltersPage />} />
        <Route path="/filters/new" element={<NewFilter />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/jobs/:id" element={<JobDetail />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/emails" element={<EmailsPage />} />
        <Route path="/collect" element={<Navigate to="/filters/new" replace />} />
        <Route path="/history" element={<Navigate to="/filters" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </main>
  </div>;
}
