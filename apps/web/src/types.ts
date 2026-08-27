export interface Page<T> { items: T[]; page: number; pageSize: number; total: number }
export interface EmailRecord {
  normalized_email: string; original_email: string; status: string; highest_confidence: string;
  best_discovery_type: string; successful_send_count: number; last_sent_at?: string; last_seen_at: string;
  domain?: string; person_count?: number; people?: Array<{ id: string; name?: string; username?: string }>;
}
export interface UserRecord {
  person_id: string; source_account_id: string; username: string; display_name?: string; preferred_display_name?: string;
  profile_url: string; avatar_url?: string; bio?: string; company?: string; location?: string; followers?: number;
  public_repos?: number; last_checked_at: string; is_suppressed: boolean;
  emails: Array<{ email: string; originalEmail: string; status: string; confidence: string; discoveryType: string; successfulSendCount: number; lastSentAt?: string }>;
}
export interface Job {
  id: string; name?: string; saved_filter_id?: string; status: string; phase: string; source_key: string; filters_json: Record<string, unknown>;
  counters_json: Record<string, number>; checkpoint_json: Record<string, unknown>; created_at: string; started_at?: string;
  completed_at?: string; failure_message?: string; recent_events?: Array<{ id: number; level: string; event_type: string; message: string; created_at: string }>;
}
export interface SavedFilter {
  id: string; name: string; source_key: string; filters_json: Record<string, unknown>; run_count: number;
  created_at: string; updated_at: string; latest_job_id?: string; latest_job_status?: string; latest_job_phase?: string;
  latest_job_created_at?: string; latest_job_completed_at?: string; latest_failure_message?: string;
  latest_counters_json?: Record<string, number>;
}
