import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, assertConfigured } from '@/lib/supabase';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
// Allow time for many sequential webhook posts (Vercel caps this at 60s on Hobby).
export const maxDuration = 60;

const SOURCE = 'v_previous_webinar_no_shows';
const STATUS_COL = 'no_show_status';
// Server-only. Override via env if it ever changes; falls back to the provided hook.
const WEBHOOK_URL =
  process.env.NOSHOW_WEBHOOK_URL ||
  'https://hook.us1.make.celonis.com/hsxoiz0a4qe3t6oa28p2zca93u6frl53';
// Max rows to send in a single "all" run (keeps us within the function time limit).
const SEND_CAP = 2000;
const SCAN_BATCH = 1000;

function isEmpty(v: unknown) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

// POST { mode: 'all' | 'one' } → sends matching no-show rows to the webhook one by one.
export async function POST(req: NextRequest) {
  const { deny } = await requireUser();
  if (deny) return deny;
  try {
    assertConfigured();
    const body = await req.json().catch(() => ({}));
    const mode: 'all' | 'one' = body?.mode === 'one' ? 'one' : 'all';

    // ---- collect rows whose no_show_status is empty, scanning in stable id order ----
    const targets: any[] = [];
    let from = 0;
    let scanned = 0;
    let columnChecked = false;
    while (targets.length < SEND_CAP) {
      const to = from + SCAN_BATCH - 1;
      const { data, error } = await supabaseAdmin
        .from(SOURCE)
        .select('*')
        .order('id', { ascending: true })
        .range(from, to);
      if (error) throw error;
      if (!data || data.length === 0) break;

      // Safety: never send everything just because the column is missing/misnamed.
      if (!columnChecked) {
        if (!(STATUS_COL in data[0])) {
          return NextResponse.json(
            { error: `Column "${STATUS_COL}" not found in ${SOURCE}. Nothing sent.` },
            { status: 400 },
          );
        }
        columnChecked = true;
      }

      for (const row of data) {
        scanned++;
        if (isEmpty(row[STATUS_COL])) {
          targets.push(row);
          if (mode === 'one') break;
          if (targets.length >= SEND_CAP) break;
        }
      }
      if (mode === 'one' && targets.length >= 1) break;
      if (data.length < SCAN_BATCH) break; // reached the end
      from += SCAN_BATCH;
    }

    if (targets.length === 0) {
      return NextResponse.json({
        ok: true,
        mode,
        total: 0,
        sent: 0,
        failed: 0,
        message: `No rows with an empty ${STATUS_COL} to send.`,
      });
    }

    const toSend = mode === 'one' ? targets.slice(0, 1) : targets;

    // ---- send to the webhook, one by one ----
    let sent = 0;
    const failures: { id: any; error: string }[] = [];
    for (const row of toSend) {
      try {
        const r = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(row),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sent++;
      } catch (e: any) {
        failures.push({ id: row?.id ?? null, error: e?.message ?? String(e) });
      }
    }

    return NextResponse.json({
      ok: failures.length === 0,
      mode,
      total: toSend.length,
      sent,
      failed: failures.length,
      capped: mode === 'all' && targets.length >= SEND_CAP,
      failures: failures.slice(0, 20),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? String(err) }, { status: 500 });
  }
}
