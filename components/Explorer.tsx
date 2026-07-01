'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import {
  SOURCES,
  SEARCH_COLUMNS,
  ENUM_FILTERS,
  BOOL_FILTERS,
  BOOL_COLUMNS,
  AUTO_COLUMNS,
  PAGE_SIZES,
  FIELD_TYPES,
} from '@/lib/schema';

interface ApiResp {
  rows: any[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  writable: boolean;
  error?: string;
}
type Toast = { id: number; msg: string; kind: 'ok' | 'err' };
type DrawerMode = 'view' | 'edit' | 'create' | null;
type FieldKind = 'text' | 'number' | 'date' | 'datetime' | 'select' | 'check';

// ---- display helpers (Airtable-style) -------------------------------------

const ACRONYMS: Record<string, string> = { id: 'ID', url: 'URL', cf: 'CF', utm: 'UTM' };
function humanize(col: string) {
  return col
    .split('_')
    .map((w) => ACRONYMS[w] ?? (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function fieldKind(col: string): FieldKind {
  if (BOOL_COLUMNS.includes(col)) return 'check';
  const ft = FIELD_TYPES[col];
  if (ft?.type === 'enum') return 'select';
  if (ft?.type === 'date') return 'date';
  if (ft?.type === 'datetime') return 'datetime';
  if (ENUM_FILTERS.some((f) => f.key === col)) return 'select';
  if (col === 'id' || col.endsWith('_id') || col.endsWith('_count')) return 'number';
  return 'text';
}

// Airtable-like single-select coloring: known values get semantic colors,
// anything else gets a stable pastel from the palette (so the same string is
// always the same color).
const SELECT_PALETTE = [
  { bg: '#fde7e9', fg: '#b4262e' },
  { bg: '#fff0d6', fg: '#a8650b' },
  { bg: '#fcf3c7', fg: '#856100' },
  { bg: '#e3f5e1', fg: '#1d7a3a' },
  { bg: '#d6f0f4', fg: '#11697e' },
  { bg: '#e0ecff', fg: '#1c5fd0' },
  { bg: '#eae3ff', fg: '#6938c2' },
  { bg: '#ffe3f1', fg: '#b32b73' },
  { bg: '#e9ecf2', fg: '#4a5568' },
];
const SELECT_OVERRIDES: Record<string, { bg: string; fg: string }> = {
  Registered: { bg: '#e3f5e1', fg: '#1d7a3a' },
  'Not Registered': { bg: '#e9ecf2', fg: '#4a5568' },
  Scheduled: { bg: '#e0ecff', fg: '#1c5fd0' },
  'Webinar Live': { bg: '#e3f5e1', fg: '#1d7a3a' },
  Ended: { bg: '#e9ecf2', fg: '#4a5568' },
  Organic: { bg: '#e3f5e1', fg: '#1d7a3a' },
  Paid: { bg: '#eae3ff', fg: '#6938c2' },
  Email: { bg: '#e0ecff', fg: '#1c5fd0' },
  Send: { bg: '#e0ecff', fg: '#1c5fd0' },
  Unknown: { bg: '#e9ecf2', fg: '#4a5568' },
};
function selectColor(v: string) {
  if (SELECT_OVERRIDES[v]) return SELECT_OVERRIDES[v];
  let h = 0;
  for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) >>> 0;
  return SELECT_PALETTE[h % SELECT_PALETTE.length];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDateOnly(v: any) {
  const [y, m, d] = String(v).slice(0, 10).split('-');
  if (!y || !m || !d) return String(v);
  return `${MONTHS[+m - 1] ?? m} ${+d}, ${y}`;
}
// Timestamps are stored as UTC (timestamptz). Render them in US Eastern
// (EST/EDT, auto-adjusting for daylight saving) so the displayed day/time
// matches the business timezone instead of the viewer's browser timezone.
const DISPLAY_TZ = 'America/New_York';
function fmtDateTime(v: any) {
  const dt = new Date(v);
  if (isNaN(+dt)) return String(v);
  const date = dt.toLocaleDateString('en-US', {
    timeZone: DISPLAY_TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const time = dt.toLocaleTimeString('en-US', {
    timeZone: DISPLAY_TZ,
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${date} · ${time}`;
}

// ---- Eastern-aware datetime editing ----------------------------------------
// Stored timestamps are UTC, but the business works in US Eastern. The
// datetime-local <input> shows/accepts Eastern wall-clock; these helpers
// convert between that and the UTC ISO string we store.

function easternParts(date: Date) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: DISPLAY_TZ,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
}

// UTC instant -> "YYYY-MM-DDTHH:mm" in Eastern, for a datetime-local input.
function utcToEasternInput(v: any): string {
  const dt = new Date(v);
  if (isNaN(+dt)) return '';
  const p = easternParts(dt);
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
}

// ms that Eastern wall-clock is ahead of UTC at the given instant (negative).
function easternOffsetMs(date: Date): number {
  const p = easternParts(date);
  const hour = p.hour === '24' ? 0 : +p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// "YYYY-MM-DDTHH:mm" interpreted as Eastern wall-clock -> UTC ISO string.
function easternInputToUtcIso(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return local;
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle DST boundaries.
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, mo - 1, d, h, mi) - easternOffsetMs(new Date(guess));
  return new Date(guess).toISOString();
}

// UTC ISO for a given Eastern calendar date (YYYY-MM-DD) at hh:mm Eastern.
function easternDateAtToUtcIso(dateStr: string, hh: number, mi: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return easternInputToUtcIso(`${dateStr.slice(0, 10)}T${pad(hh)}:${pad(mi)}`);
}

// Add days to a "YYYY-MM-DD" calendar date (timezone-free).
function addDaysDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function todayEasternDateStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// ---- tiny inline field-type icons (monochrome, currentColor) ---------------
function FieldIcon({ kind }: { kind: FieldKind }) {
  const p = { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'number':
      return (<svg {...p}><path d="M6 3 4.5 13M11.5 3 10 13M3 6h10M2.5 10h10" /></svg>);
    case 'select':
      return (<svg {...p}><path d="M4 6.5 8 10.5 12 6.5" /></svg>);
    case 'date':
    case 'datetime':
      return (<svg {...p}><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></svg>);
    case 'check':
      return (<svg {...p}><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" /><path d="M5 8l2.2 2.2L11 6.5" /></svg>);
    default:
      return (<svg {...p}><path d="M3.5 4.5h9M3.5 8h9M3.5 11.5h6" /></svg>);
  }
}

const CheckMark = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 5" /></svg>
);
const ExpandGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></svg>
);

function sameKeys(a: string[], b: string[]) {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

function renderCell(col: string, v: any) {
  if (v === null || v === undefined || v === '') return <span className="cell-null">—</span>;
  const kind = fieldKind(col);
  if (kind === 'check' || typeof v === 'boolean') {
    const on = v === true || v === 'true';
    return (
      <span className={`cell-check ${on ? 'on' : 'off'}`} aria-label={on ? 'true' : 'false'}>
        {on && <CheckMark />}
      </span>
    );
  }
  if (kind === 'select') {
    const c = selectColor(String(v));
    return <span className="select-pill" style={{ background: c.bg, color: c.fg }}>{String(v)}</span>;
  }
  if (kind === 'date') return fmtDateOnly(v);
  if (kind === 'datetime') return fmtDateTime(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function Explorer({ userEmail }: { userEmail: string }) {
  const router = useRouter();

  const [source, setSource] = useState('webinar_registrants');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [bools, setBools] = useState<Record<string, string>>({});
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState('id');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [data, setData] = useState<ApiResp | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [drawer, setDrawer] = useState<DrawerMode>(null);
  const [drawerRow, setDrawerRow] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  // ---- shared hidden-columns config (saved for EVERYONE via /api/settings) ----
  const [hiddenMap, setHiddenMap] = useState<Record<string, string[]>>({});
  const [colPanelOpen, setColPanelOpen] = useState(false);
  const [savingCols, setSavingCols] = useState(false);

  // ---- "Trigger no-shows" webhook (only on the no-shows view) ----
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [triggering, setTriggering] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  // ---- persist the current view across refreshes (localStorage) ----
  const STORAGE_KEY = 'webinar-admin:view';
  const [hydrated, setHydrated] = useState(false);

  // restore once on mount, before the first fetch fires
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        // ignore a persisted source that's no longer a known source
        if (typeof s.source === 'string' && SOURCES.some((src) => src.name === s.source)) setSource(s.source);
        if (s.filters && typeof s.filters === 'object') setFilters(s.filters);
        if (s.bools && typeof s.bools === 'object') setBools(s.bools);
        if (typeof s.dateFrom === 'string') setDateFrom(s.dateFrom);
        if (typeof s.dateTo === 'string') setDateTo(s.dateTo);
        if (typeof s.sort === 'string') setSort(s.sort);
        if (s.order === 'asc' || s.order === 'desc') setOrder(s.order);
        if (typeof s.pageSize === 'number') setPageSize(s.pageSize);
        if (typeof s.searchInput === 'string') {
          setSearchInput(s.searchInput);
          setQ(s.searchInput.trim());
        }
        if (typeof s.page === 'number') setPage(s.page);
      }
    } catch {
      /* ignore malformed storage */
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // save whenever the view changes (after hydration so we don't clobber it)
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ source, filters, bools, dateFrom, dateTo, sort, order, page, pageSize, searchInput }),
      );
    } catch {
      /* storage unavailable (private mode / quota) — non-fatal */
    }
  }, [hydrated, source, filters, bools, dateFrom, dateTo, sort, order, page, pageSize, searchInput]);

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const presentSearchCols = useMemo(
    () => SEARCH_COLUMNS.filter((c) => columns.includes(c)),
    [columns],
  );

  const buildParams = useCallback(
    (forExport = false) => {
      const sp = new URLSearchParams();
      sp.set('source', source);
      if (q && presentSearchCols.length) {
        sp.set('q', q);
        sp.set('searchCols', presentSearchCols.join(','));
      }
      const clauses: { col: string; op: string; val: string }[] = [];
      for (const [k, v] of Object.entries(filters)) if (v) clauses.push({ col: k, op: 'eq', val: v });
      for (const [k, v] of Object.entries(bools)) if (v) clauses.push({ col: k, op: 'eq', val: v });
      if (dateFrom && columns.includes('registration_date'))
        clauses.push({ col: 'registration_date', op: 'gte', val: dateFrom });
      if (dateTo && columns.includes('registration_date'))
        clauses.push({ col: 'registration_date', op: 'lte', val: dateTo });
      if (clauses.length) sp.set('filters', JSON.stringify(clauses));
      sp.set('sort', sort);
      sp.set('order', order);
      if (!forExport) {
        sp.set('page', String(page));
        sp.set('pageSize', String(pageSize));
      }
      return sp;
    },
    [source, q, presentSearchCols, filters, bools, dateFrom, dateTo, sort, order, page, pageSize, columns],
  );

  const reqId = useRef(0);
  useEffect(() => {
    if (!hydrated) return; // wait for the saved view to be restored first
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    fetch('/api/data?' + buildParams().toString())
      .then((r) => r.json())
      .then((d: ApiResp) => {
        if (id !== reqId.current) return;
        if (d.error) {
          setError(d.error);
          setData(null);
        } else {
          setData(d);
          if (d.rows.length) {
            const keys = Object.keys(d.rows[0]);
            setColumns((prev) => (sameKeys(prev, keys) ? prev : keys));
          }
        }
      })
      .catch((e) => id === reqId.current && setError(String(e)))
      .finally(() => id === reqId.current && setLoading(false));
  }, [buildParams, hydrated]);

  function changeSource(next: string) {
    setSource(next);
    setColumns([]);
    setFilters({});
    setBools({});
    setDateFrom('');
    setDateTo('');
    setSearchInput('');
    setQ('');
    setSort('id');
    setOrder('desc');
    setPage(1);
  }

  function toggleSort(col: string) {
    if (sort === col) setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(col);
      setOrder('asc');
    }
    setPage(1);
  }

  const writable = data?.writable ?? false;
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 0;
  const fromRow = total ? (page - 1) * pageSize + 1 : 0;
  const toRow = Math.min(page * pageSize, total);

  const activeFilters = useMemo(() => {
    let n = 0;
    if (q) n++;
    n += Object.values(filters).filter(Boolean).length;
    n += Object.values(bools).filter(Boolean).length;
    if (dateFrom) n++;
    if (dateTo) n++;
    return n;
  }, [q, filters, bools, dateFrom, dateTo]);

  function clearFilters() {
    setFilters({});
    setBools({});
    setDateFrom('');
    setDateTo('');
    setSearchInput('');
    setQ('');
    setPage(1);
  }

  async function logout() {
    await createSupabaseBrowser().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  // ---- CRUD ----
  async function openCreate() {
    const blank: any = {};
    columns.forEach((c) => (blank[c] = ''));

    // New webinar: default the dates to (previous webinar date + 7 days), with
    // the webinar at 8:30 PM ET and the end at 9:30 PM ET. Still fully editable.
    if (source === 'webinar_events') {
      try {
        const res = await fetch('/api/data?source=webinar_events&sort=webinar_date&order=desc&page=1&pageSize=1');
        const j = await res.json();
        const prev = j?.rows?.[0]?.webinar_date ?? j?.rows?.[0]?.webinar_date_time;
        const prevDate = prev ? String(prev).slice(0, 10) : todayEasternDateStr();
        const nextDate = addDaysDateStr(prevDate, 7);
        if (columns.includes('webinar_date')) blank.webinar_date = nextDate;
        if (columns.includes('webinar_date_time')) blank.webinar_date_time = easternDateAtToUtcIso(nextDate, 20, 30);
        if (columns.includes('end_date')) blank.end_date = easternDateAtToUtcIso(nextDate, 21, 30);
      } catch {
        /* non-fatal — open with empty dates if the lookup fails */
      }
    }

    setDrawerRow(blank);
    setDrawer('create');
  }
  function openRow(row: any) {
    setDrawerRow(row);
    setDrawer(writable ? 'edit' : 'view');
  }
  function closeDrawer() {
    setDrawer(null);
    setDrawerRow(null);
  }

  async function saveDrawer() {
    const form = document.getElementById('drawerForm') as HTMLFormElement | null;
    if (!form) return;
    const values: Record<string, any> = {};
    form.querySelectorAll<HTMLElement>('[data-col]').forEach((el) => {
      const col = el.getAttribute('data-col')!;
      let v = (el as HTMLInputElement).value;
      // datetime-local fields are entered in Eastern wall-clock → store as UTC.
      if (v !== '' && FIELD_TYPES[col]?.type === 'datetime') v = easternInputToUtcIso(v);
      values[col] = v === '' ? null : v === 'true' ? true : v === 'false' ? false : v;
    });
    setSaving(true);
    try {
      let res: Response;
      if (drawer === 'create') {
        res = await fetch('/api/data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, values }),
        });
      } else {
        res = await fetch('/api/data', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, id: drawerRow.id, values }),
        });
      }
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Save failed');
      toast(drawer === 'create' ? 'Row created' : 'Row updated', 'ok');
      closeDrawer();
      refetch();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setSaving(false);
    }
  }

  async function deleteRow(row: any) {
    if (!confirm(`Delete row id ${row.id}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/data?source=${encodeURIComponent(source)}&id=${encodeURIComponent(row.id)}`, {
        method: 'DELETE',
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Delete failed');
      toast('Row deleted', 'ok');
      refetch();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  }

  // manual refetch (after writes)
  const refetch = useCallback(() => {
    const id = ++reqId.current;
    setLoading(true);
    fetch('/api/data?' + buildParams().toString())
      .then((r) => r.json())
      .then((d: ApiResp) => {
        if (id !== reqId.current) return;
        if (d.error) setError(d.error);
        else {
          setData(d);
          if (d.rows.length) {
            const keys = Object.keys(d.rows[0]);
            setColumns((prev) => (sameKeys(prev, keys) ? prev : keys));
          }
        }
      })
      .finally(() => id === reqId.current && setLoading(false));
  }, [buildParams]);

  // ---- hidden columns: load once (shared), derive visible/hidden, save on change ----
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        if (d && d.hiddenColumns && typeof d.hiddenColumns === 'object') setHiddenMap(d.hiddenColumns);
      })
      .catch(() => {
        /* non-fatal — fall back to showing all columns */
      });
  }, []);

  const hiddenForSource = useMemo(() => hiddenMap[source] ?? [], [hiddenMap, source]);
  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenForSource.includes(c)),
    [columns, hiddenForSource],
  );
  const hiddenColsPresent = useMemo(
    () => columns.filter((c) => hiddenForSource.includes(c)),
    [columns, hiddenForSource],
  );

  const saveHidden = useCallback(
    async (nextMap: Record<string, string[]>) => {
      setHiddenMap(nextMap); // optimistic
      setSavingCols(true);
      try {
        const res = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hiddenColumns: nextMap }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'Save failed');
        if (j.hiddenColumns) setHiddenMap(j.hiddenColumns); // adopt server-sanitized map
        toast('Column settings saved for everyone', 'ok');
      } catch (e: any) {
        toast(e.message || 'Could not save column settings', 'err');
      } finally {
        setSavingCols(false);
      }
    },
    [toast],
  );

  function hideColumn(col: string) {
    const cur = hiddenMap[source] ?? [];
    if (cur.includes(col)) return;
    saveHidden({ ...hiddenMap, [source]: [...cur, col] });
  }
  function showColumn(col: string) {
    const cur = hiddenMap[source] ?? [];
    saveHidden({ ...hiddenMap, [source]: cur.filter((c) => c !== col) });
  }
  function showAllColumns() {
    saveHidden({ ...hiddenMap, [source]: [] });
  }

  // ---- trigger no-shows webhook ----
  async function runTrigger(mode: 'all' | 'one') {
    if (
      mode === 'all' &&
      !confirm(
        'Send ALL no-shows with an empty no_show_status to the webhook, one by one?\n\nThis may fire many requests.',
      )
    ) {
      return;
    }
    setTriggerOpen(false);
    setTriggering(true);
    try {
      const res = await fetch('/api/trigger-noshows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Trigger failed');
      if (j.total === 0) {
        toast(j.message || 'No matching rows to send', 'ok');
      } else if (j.failed > 0) {
        toast(`Sent ${j.sent}/${j.total} — ${j.failed} failed`, 'err');
      } else {
        toast(
          `Sent ${j.sent} no-show${j.sent === 1 ? '' : 's'} to the webhook` +
            (j.capped ? ` (capped — run again to send more)` : ''),
          'ok',
        );
      }
    } catch (e: any) {
      toast(e.message || 'Trigger failed', 'err');
    } finally {
      setTriggering(false);
    }
  }

  const activeSource = SOURCES.find((s) => s.name === source);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="logo">▦</span>
          <h1>Webinar Admin</h1>
        </div>
        <span className="spacer" />

        <div className="col-menu">
          <button
            className={hiddenForSource.length ? 'on' : ''}
            onClick={() => setColPanelOpen((o) => !o)}
            title="Show / hide columns — saved for everyone"
          >
            ▦ Columns{hiddenForSource.length ? ` · ${hiddenForSource.length} hidden` : ''}
          </button>
          {colPanelOpen && (
            <>
              <div className="col-panel-backdrop" onClick={() => setColPanelOpen(false)} />
              <div className="col-panel" onClick={(e) => e.stopPropagation()}>
                <div className="cp-head">
                  <h4>Columns</h4>
                  {savingCols && <span className="spin" />}
                  <button className="cp-close" onClick={() => setColPanelOpen(false)}>✕</button>
                </div>
                <p className="cp-hint">🌐 Changes are saved for everyone.</p>

                {columns.length === 0 ? (
                  <div className="cp-empty">Load some records first to manage columns.</div>
                ) : (
                  <>
                    <div className="cp-section-label">
                      Shown <span>({visibleColumns.length})</span>
                    </div>
                    {visibleColumns.map((c) => (
                      <div className="col-item" key={c}>
                        <span className="ci-ic"><FieldIcon kind={fieldKind(c)} /></span>
                        <span className="ci-name" title={c}>{humanize(c)}</span>
                        <button
                          onClick={() => hideColumn(c)}
                          disabled={visibleColumns.length <= 1}
                          title={visibleColumns.length <= 1 ? 'Keep at least one column visible' : 'Hide this column'}
                        >
                          Hide
                        </button>
                      </div>
                    ))}

                    <div className="cp-section-label" style={{ marginTop: 14 }}>
                      Hidden <span>({hiddenColsPresent.length})</span>
                      {hiddenColsPresent.length > 0 && (
                        <button className="cp-showall" onClick={showAllColumns}>Show all</button>
                      )}
                    </div>
                    {hiddenColsPresent.length === 0 ? (
                      <div className="cp-empty">No hidden columns.</div>
                    ) : (
                      hiddenColsPresent.map((c) => (
                        <div className="col-item is-hidden" key={c}>
                          <span className="ci-ic"><FieldIcon kind={fieldKind(c)} /></span>
                          <span className="ci-name" title={c}>{humanize(c)}</span>
                          <button className="primary" onClick={() => showColumn(c)} title="Show this column">
                            Show
                          </button>
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <span className="userbar">
          <span className="who">{userEmail}</span>
          <button onClick={logout}>Log out</button>
        </span>
      </div>

      <div className="tabstrip">
        {SOURCES.map((s) => {
          const view = s.name.startsWith('v_');
          return (
            <button
              key={s.name}
              className={`tab ${source === s.name ? 'active' : ''}`}
              onClick={() => source !== s.name && changeSource(s.name)}
              title={s.name}
            >
              <span className="tab-ic">{view ? '◉' : '▦'}</span>
              {s.label.replace(/ — (table|view)$/, '')}
            </button>
          );
        })}
      </div>

      <div className="toolbar">
        <div className="searchbox">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
          <input
            placeholder="Search email, name, phone…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button className="search-clear" onClick={() => setSearchInput('')} title="Clear search">✕</button>
          )}
        </div>

        <span className="tool-divider" />

        <div className="filters">
          {ENUM_FILTERS.filter((f) => columns.includes(f.key)).map((f) => (
            <label className={`chip ${filters[f.key] ? 'on' : ''}`} key={f.key}>
              <span className="chip-lbl">{f.label}</span>
              <select
                value={filters[f.key] ?? ''}
                onChange={(e) => {
                  setFilters((p) => ({ ...p, [f.key]: e.target.value }));
                  setPage(1);
                }}
              >
                <option value="">All</option>
                {f.options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </label>
          ))}
          {BOOL_FILTERS.filter((b) => columns.includes(b.key)).map((b) => (
            <label className={`chip ${bools[b.key] ? 'on' : ''}`} key={b.key}>
              <span className="chip-lbl">{b.label}</span>
              <select
                value={bools[b.key] ?? ''}
                onChange={(e) => {
                  setBools((p) => ({ ...p, [b.key]: e.target.value }));
                  setPage(1);
                }}
              >
                <option value="">All</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </label>
          ))}
          {columns.includes('registration_date') && (
            <>
              <label className={`chip ${dateFrom ? 'on' : ''}`}>
                <span className="chip-lbl">From</span>
                <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
              </label>
              <label className={`chip ${dateTo ? 'on' : ''}`}>
                <span className="chip-lbl">To</span>
                <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
              </label>
            </>
          )}
          {activeFilters > 0 && (
            <button className="btn-clear" onClick={clearFilters}>✕ Clear ({activeFilters})</button>
          )}
        </div>

        <span className="spacer" />

        {loading && <span className="spin" />}
        <span className="badge">{total.toLocaleString()} {total === 1 ? 'record' : 'records'}</span>
        <span className={`badge ${writable ? 'rw' : 'ro'}`}>{writable ? 'editable' : 'read-only'}</span>
        <a href={'/api/export?' + buildParams(true).toString()}>
          <button>⬇ Export CSV</button>
        </a>

        {source === 'v_previous_webinar_no_shows' && (
          <div className="trigger-menu">
            <button
              className="btn-trigger"
              onClick={() => setTriggerOpen((o) => !o)}
              disabled={triggering}
              title="Send no-shows (empty no_show_status) to the webhook"
            >
              {triggering ? (
                <><span className="spin" /> Sending…</>
              ) : (
                <>⚡ Trigger no-shows ▾</>
              )}
            </button>
            {triggerOpen && (
              <>
                <div className="col-panel-backdrop" onClick={() => setTriggerOpen(false)} />
                <div className="trigger-panel" onClick={(e) => e.stopPropagation()}>
                  <button className="tg-item" disabled={triggering} onClick={() => runTrigger('all')}>
                    <span className="tg-title">Send all</span>
                    <span className="tg-sub">Every no-show with an empty status, one by one</span>
                  </button>
                  <button className="tg-item" disabled={triggering} onClick={() => runTrigger('one')}>
                    <span className="tg-title">Send 1 (test)</span>
                    <span className="tg-sub">Send a single row to verify the webhook</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {writable && (
          <button className="primary" onClick={openCreate}>
            + {source === 'webinar_events' ? 'New webinar' : 'New record'}
          </button>
        )}
      </div>

      <div className="table-wrap">
        {error ? (
          <div className="state error">Error: {error}</div>
        ) : !data ? (
          <div className="state"><span className="spin big" /><div>Loading…</div></div>
        ) : data.rows.length === 0 ? (
          <div className="state">
            <div className="empty-ic">🔍</div>
            <div>No records match.</div>
            {activeFilters > 0 && <button className="btn-clear" onClick={clearFilters} style={{ marginTop: 12 }}>Clear filters</button>}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="gutter-h" />
                {visibleColumns.map((c) => (
                  <th key={c} onClick={() => toggleSort(c)} title={c} className={sort === c ? 'sorted' : ''}>
                    <span className="col-head">
                      <span className="col-ic"><FieldIcon kind={fieldKind(c)} /></span>
                      <span className="col-name">{humanize(c)}</span>
                      {sort === c && <span className="sort-ind">{order === 'asc' ? '↑' : '↓'}</span>}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={row.id ?? i} onClick={() => openRow(row)}>
                  <td className="gutter">
                    <span className="rownum">{fromRow + i}</span>
                    <span className="expand" title={writable ? 'Open record' : 'View record'}><ExpandGlyph /></span>
                  </td>
                  {visibleColumns.map((c) => (
                    <td key={c} title={row[c] == null ? '' : String(row[c])}>
                      {renderCell(c, row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="footer">
        <div className="pager">
          <button disabled={page <= 1} onClick={() => setPage(1)}>« First</button>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
          <span className="info">
            {fromRow.toLocaleString()}–{toRow.toLocaleString()} of {total.toLocaleString()}
          </span>
          <button disabled={totalPages > 0 && page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
          <button disabled={totalPages > 0 && page >= totalPages} onClick={() => setPage(totalPages)}>Last »</button>
        </div>
        <span className="spacer" />
        <div className="rows-per">
          <label>Rows per page</label>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      {drawer && drawerRow && (
        <DrawerForm
          mode={drawer}
          row={drawerRow}
          columns={columns}
          source={source}
          sourceLabel={activeSource?.label ?? source}
          saving={saving}
          onClose={closeDrawer}
          onSave={saveDrawer}
          onDelete={() => { closeDrawer(); deleteRow(drawerRow); }}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>
        ))}
      </div>
    </div>
  );
}

function DrawerForm({
  mode, row, columns, source, sourceLabel, saving, onClose, onSave, onDelete,
}: {
  mode: DrawerMode; row: any; columns: string[]; source: string; sourceLabel: string; saving: boolean;
  onClose: () => void; onSave: () => void; onDelete: () => void;
}) {
  // Esc to close
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const ro = mode === 'view';
  const cols = mode === 'create' ? columns.filter((c) => !AUTO_COLUMNS.includes(c)) : columns;

  function input(col: string) {
    const val = row[col];
    const disabled = ro || (mode === 'edit' && col === 'id');

    // New webinars are always "Scheduled" — fixed, not a dropdown.
    if (col === 'webinar_status' && mode === 'create') {
      return <input className="field-in" data-col={col} defaultValue="Scheduled" disabled />;
    }

    if (BOOL_COLUMNS.includes(col)) {
      return (
        <select className="field-in" data-col={col} defaultValue={val === true ? 'true' : val === false ? 'false' : ''} disabled={disabled}>
          <option value="">(empty)</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    }

    const ft = FIELD_TYPES[col];
    if (ft?.type === 'enum') {
      const opts = [...(ft.options ?? [])];
      if (val && !opts.includes(val)) opts.push(val); // keep any legacy value selectable
      return (
        <select className="field-in" data-col={col} defaultValue={val ?? ''} disabled={disabled}>
          <option value="">(empty)</option>
          {opts.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );
    }
    if (ft?.type === 'date') {
      const d = val ? String(val).slice(0, 10) : '';
      return <input type="date" className="field-in" data-col={col} defaultValue={d} disabled={disabled} />;
    }
    if (ft?.type === 'datetime') {
      const dt = val ? utcToEasternInput(val) : ''; // Eastern wall-clock for the input
      return <input type="datetime-local" className="field-in" data-col={col} defaultValue={dt} disabled={disabled} />;
    }

    const str = val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (str.length > 60) {
      return <textarea className="field-in" data-col={col} defaultValue={str} disabled={disabled} />;
    }
    return <input className="field-in" data-col={col} defaultValue={str} disabled={disabled} />;
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <h2>
              {mode === 'create' ? 'New record' : mode === 'edit' ? 'Edit record' : 'Record'}
              {ro && <span className="readonly-tag"> · read-only</span>}
            </h2>
            <div className="sub">{sourceLabel}{row.id ? ` · #${row.id}` : ''}</div>
          </div>
          <button className="close" onClick={onClose}>✕</button>
        </div>
        <form id="drawerForm" onSubmit={(e) => e.preventDefault()}>
          {cols.map((c) => (
            <div className="frow" key={c}>
              <span className="k">
                <span className="k-ic"><FieldIcon kind={fieldKind(c)} /></span>
                {humanize(c)}
              </span>
              {input(c)}
            </div>
          ))}
        </form>
        {!ro && (
          <div className="actions">
            <button className="primary" onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={onClose}>Cancel</button>
            {mode === 'edit' && (
              <button className="danger" style={{ marginLeft: 'auto' }} onClick={onDelete}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
