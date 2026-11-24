// Small database helpers + the debug log.

export async function getSetting(env, key, fallback = null) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : fallback;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value == null ? null : String(value)).run();
}

export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value, updated_at FROM settings').all();
  const out = {};
  for (const r of results) out[r.key] = r.value;
  return out;
}

export async function log(env, level, event, detail) {
  let text = null;
  if (detail !== undefined && detail !== null) {
    text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    if (text.length > 4000) text = text.slice(0, 4000) + '…';
  }
  try {
    await env.DB.prepare('INSERT INTO logs (level, event, detail) VALUES (?, ?, ?)').bind(level, event, text).run();
  } catch (e) {
    console.error('log write failed', e);
  }
  console.log(`[${level}] ${event}`, text || '');
}

// Several log lines in one database query: entries are [level, event, detail].
export async function logMany(env, entries) {
  const text = (d) => {
    if (d === undefined || d === null) return null;
    const t = typeof d === 'string' ? d : JSON.stringify(d);
    return t.length > 4000 ? t.slice(0, 4000) + '…' : t;
  };
  try {
    await env.DB.batch(entries.map(([level, event, detail]) => env.DB.prepare('INSERT INTO logs (level, event, detail) VALUES (?, ?, ?)').bind(level, event, text(detail))));
  } catch (e) {
    console.error('log write failed', e);
  }
  for (const [level, event, detail] of entries) console.log(`[${level}] ${event}`, text(detail) || '');
}

export async function pruneLogs(env, keep = 5000) {
  await env.DB.prepare(
    'DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?)'
  ).bind(keep).run();
}

// Wraps env.DB so every query is counted. Cloudflare's free plan allows 50 database queries per
// run (a batch counts as one); the bot stops early and carries on next check before hitting that.
export function countQueries(env) {
  const counter = { n: 0 };
  const wrap = (st) => ({
    _st: st,
    bind: (...a) => wrap(st.bind(...a)),
    first: (...a) => { counter.n++; return st.first(...a); },
    all: (...a) => { counter.n++; return st.all(...a); },
    run: (...a) => { counter.n++; return st.run(...a); },
    raw: (...a) => { counter.n++; return st.raw(...a); },
  });
  const DB = {
    prepare: (sql) => wrap(env.DB.prepare(sql)),
    batch: (list) => { counter.n++; return env.DB.batch(list.map((x) => x._st || x)); },
  };
  return { env: Object.assign(Object.create(env), { DB }), counter };
}

export function nowIso() {
  return new Date().toISOString();
}
