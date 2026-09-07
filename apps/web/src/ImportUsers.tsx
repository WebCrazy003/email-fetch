import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { importUsersSchema, MAX_IMPORT_BYTES, MAX_IMPORT_USERS, type ImportUsersResult } from '@email-fetch/shared';
import { api } from './api.js';
import { ErrorBox } from './components.js';

const example = JSON.stringify([{
  name: 'Jane Doe', email: 'jane@example.com', country: 'Poland', extra_info: 'Frontend developer',
  fetch_source: 'github_hire_me', fetch_page_link: 'https://github.com/janedoe'
}], null, 2);

export function ImportUsers() {
  const [text, setText] = useState('');
  const [fileError, setFileError] = useState<Error | null>(null);
  const [reading, setReading] = useState(false);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      if (new Blob([text]).size > MAX_IMPORT_BYTES) throw new Error('JSON must be smaller than 1 MB. Split larger imports into multiple files.');
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new Error('Invalid JSON. Use double-quoted keys and colons between keys and values.'); }
      const parsed = importUsersSchema.safeParse(json);
      if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 10).map((issue) =>
        `Row ${Number(issue.path[0] ?? 0) + 1}, ${issue.path.slice(1).join('.') || 'record'}: ${issue.message}`).join('; '));
      return api<ImportUsersResult>('/users/import', { method: 'POST', body: text });
    },
    onSuccess: () => {
      for (const queryKey of [['users'], ['emails'], ['dashboard']]) void client.invalidateQueries({ queryKey });
    }
  });
  return <section className="panel form-section import-users">
    <h2>Import users from JSON</h2>
    <p className="muted">Upload a file or paste one object or an array of up to {MAX_IMPORT_USERS.toLocaleString()} users (1 MB). Include name, email, and country; name and country may be empty.</p>
    <p className="muted">Emails already in the database or repeated in this file are skipped, regardless of source. Matching ignores letter case and surrounding spaces. Suppressed or blocked contacts are also skipped. Imported emails start with unsure confidence.</p>
    <form onSubmit={(event) => { event.preventDefault(); setFileError(null); mutation.mutate(); }}>
      <label className="field">JSON file<input type="file" accept=".json,application/json" disabled={mutation.isPending || reading} onChange={async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setFileError(null); mutation.reset(); setReading(true);
        try {
          if (file.size > MAX_IMPORT_BYTES) throw new Error('File must be smaller than 1 MB.');
          setText(await file.text());
        } catch (error) { setFileError(error instanceof Error ? error : new Error('Unable to read file')); }
        finally { setReading(false); }
      }} /></label>
      <label className="field">JSON content<textarea rows={12} value={text} placeholder={example} disabled={mutation.isPending || reading} onChange={(event) => { setText(event.target.value); setFileError(null); mutation.reset(); }} /></label>
      <details><summary>Example JSON</summary><pre>{example}</pre></details>
      {(fileError || mutation.error) && <ErrorBox error={fileError || mutation.error} />}
      {mutation.data && <div className="success-box" role="status">Import complete: {mutation.data.created} created, {mutation.data.updated} updated, {mutation.data.skipped} skipped.</div>}
      <button className="button primary" disabled={!text.trim() || reading || mutation.isPending || !!fileError}>{mutation.isPending ? 'Importing…' : 'Import users'}</button>
    </form>
  </section>;
}
