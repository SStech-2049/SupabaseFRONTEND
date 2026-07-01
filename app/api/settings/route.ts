import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, assertConfigured } from '@/lib/supabase';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Single shared row holding the per-source hidden-column config:
//   value = { "<source>": ["col_a", "col_b", ...], ... }
// Stored in app_ui_settings (server-only, service role). Because every user hits
// the same row through the server, hiding a column applies to everyone.
const KEY = 'hidden_columns';

function bad(msg: string, code = 400) {
  return NextResponse.json({ error: msg }, { status: code });
}

// READ the shared hidden-columns map.
export async function GET() {
  const { deny } = await requireUser();
  if (deny) return deny;
  try {
    assertConfigured();
    const { data, error } = await supabaseAdmin
      .from('app_ui_settings')
      .select('value')
      .eq('key', KEY)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({ hiddenColumns: (data?.value as Record<string, string[]>) ?? {} });
  } catch (err: any) {
    return bad(err.message ?? String(err), 500);
  }
}

// WRITE the shared hidden-columns map (replaces it wholesale).
export async function PUT(req: NextRequest) {
  const { deny } = await requireUser();
  if (deny) return deny;
  try {
    assertConfigured();
    const body = await req.json();
    const incoming = body?.hiddenColumns;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return bad('Invalid hiddenColumns: expected an object of { source: string[] }');
    }
    // Sanitize: keep only string[] values keyed by source; drop empties.
    const clean: Record<string, string[]> = {};
    for (const [src, cols] of Object.entries(incoming)) {
      if (!Array.isArray(cols)) continue;
      const list = cols.filter((c): c is string => typeof c === 'string');
      if (list.length) clean[src] = Array.from(new Set(list));
    }

    const { error } = await supabaseAdmin
      .from('app_ui_settings')
      .upsert({ key: KEY, value: clean, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;

    return NextResponse.json({ ok: true, hiddenColumns: clean });
  } catch (err: any) {
    return bad(err.message ?? String(err), 500);
  }
}
