// Client-side display config for the Explorer.

export interface SourceDef {
  name: string;
  label: string;
}

// Known sources for the picker. Tables are writable; v_* are read-only views.
// (The API also returns `writable` per source, which is what actually gates CRUD.)
export const SOURCES: SourceDef[] = [
  { name: 'webinar_registrants', label: 'Registrants — table' },
  { name: 'webinar_events', label: 'Events — table' },
  { name: 'v_all_registrants', label: 'All registrants — view' },
  { name: 'v_current_webinar', label: 'Current webinar — view' },
  { name: 'v_previous_webinar_registrants', label: 'Previous webinar — view' },
  { name: 'v_previous_webinar_no_shows', label: 'Previous webinar · no-shows — view' },
  { name: 'v_registered', label: 'Registered — view' },
  { name: 'v_unregistered', label: 'Unregistered — view' },
  { name: 'v_no_show', label: 'No-shows — view' },
  { name: 'v_test', label: 'Test — view' },
];

// Free-text search runs ILIKE across whichever of these columns exist in the source.
export const SEARCH_COLUMNS = ['email', 'first_name', 'last_name', 'name', 'phone'];

// Dropdown filters — shown only when the column exists in the current source.
export const ENUM_FILTERS: { key: string; label: string; options: string[] }[] = [
  { key: 'registration_status', label: 'Reg Status', options: ['Registered', 'Not Registered'] },
  { key: 'traffic_first_source', label: 'First Source', options: ['Organic', 'Paid', 'Email', 'Unknown'] },
  { key: 'traffic_last_source', label: 'Last Source', options: ['Organic', 'Paid', 'Email'] },
  { key: 'webinar_status', label: 'Webinar Status', options: ['Scheduled', 'Webinar Live', 'Ended'] },
];

export const BOOL_FILTERS: { key: string; label: string }[] = [
  { key: 'is_registrant', label: 'Registrant' },
  { key: 'is_attendee', label: 'Attendee' },
  { key: 'is_no_show', label: 'No Show' },
];

// Columns hidden from the create form (DB-managed).
export const AUTO_COLUMNS = ['id', 'created_at', 'updated_at'];

// Per-column input types for the create/edit form. Anything not listed (and not a
// boolean) renders as a text box. Enum values are the EXACT strings stored in the DB.
export interface FieldType {
  type: 'enum' | 'date' | 'datetime';
  options?: string[];
}
export const FIELD_TYPES: Record<string, FieldType> = {
  // events
  webinar_status: { type: 'enum', options: ['Scheduled', 'Webinar Live', 'Ended'] },
  webinar_date: { type: 'date' },
  webinar_date_time: { type: 'datetime' },
  end_date: { type: 'datetime' },
  // registrants
  registration_status: { type: 'enum', options: ['Registered', 'Not Registered'] },
  traffic_first_source: { type: 'enum', options: ['Organic', 'Paid', 'Email', 'Unknown'] },
  traffic_last_source: { type: 'enum', options: ['Organic', 'Paid', 'Email'] },
  registration_date: { type: 'datetime' },
  cf_registration_date_time: { type: 'datetime' },
  created_airtable: { type: 'datetime' },
  last_modified_airtable: { type: 'datetime' },
};

// Boolean columns (rendered as true/false/null selects in the edit form).
export const BOOL_COLUMNS = [
  'is_registrant',
  'is_attendee',
  'is_no_show',
  'two_hours_passed',
  'linked',
  'conversion_record_needed',
  'this_week',
];

export const PAGE_SIZES = [25, 50, 100, 200];
