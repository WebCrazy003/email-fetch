import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Activity, Clock3, Database, Github, LayoutDashboard, Mail, Search, Settings, Users } from 'lucide-react';
import { Dashboard } from './pages/Dashboard.js';
import { NewCollection } from './pages/NewCollection.js';
import { Jobs, JobDetail } from './pages/Jobs.js';
import { UsersPage } from './pages/Users.js';
import { EmailsPage } from './pages/Emails.js';
import { HistoryPage } from './pages/History.js';
import { SettingsPage } from './pages/Settings.js';

const links = [
  ['/', LayoutDashboard, 'Dashboard'], ['/collect', Search, 'New collection'], ['/jobs', Activity, 'Jobs'],
  ['/users', Users, 'Collected users'], ['/emails', Mail, 'Emails'], ['/history', Clock3, 'Search history'], ['/settings', Settings, 'Settings']
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
        <Route path="/collect" element={<NewCollection />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/jobs/:id" element={<JobDetail />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/emails" element={<EmailsPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </main>
  </div>;
}
