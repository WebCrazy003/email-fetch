const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:3000';

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ORIGIN}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText })) as { message?: string };
    throw new Error(Array.isArray(error.message) ? error.message.join(', ') : error.message ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function eventStreamUrl(jobId: string) {
  return `${API_ORIGIN}/api/jobs/${jobId}/stream`;
}

export function queryString(values: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params.toString();
}
