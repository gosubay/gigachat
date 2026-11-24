// The bot's brain. runOnce() is called every minute by the cron trigger
// (and by the dashboard's "Run now" button). A cron run does up to 3 checks (0s, 20s, 40s).
// Each check has three phases (A+B run alongside C):
//   A. find new keyword comments   B. send the first DM   C. read replies, check follow, send link
import { Instagram, IgError, BudgetExceeded } from './instagram.js';
import { setSetting, getSettings, log, logMany, pruneLogs, nowIso, countQueries } from './db.js';

const DAY = 24 * 60 * 60 * 1000;
const PRIVATE_REPLY_WINDOW = 7 * DAY;
const WAIT_FOR_TAP_MAX = 30 * DAY;
const TOKEN_REFRESH_EVERY = 7 * DAY;
const MAX_DM_ATTEMPTS = 3;
const MAX_COMMENT_PAGES = 3;
const PASS_DEFAULT = '0,20,40'; // checks per cron run, seconds after it fires (wrangler var PASS_SECONDS)
const LAST_PASS_START_S = 45; // never start a check later than this, so the next minute's run isn't held up
const LOCK_STALE_MS = 50_000; // a lock older than this belongs to a crashed run
const LOCK_WAIT_MS = 4000;
const LOCK_WAIT_TRIES = 4;
const DB_QUERY_LIMIT = 50; // Cloudflare free plan: database queries per run
const DB_RESERVE = 12; // queries kept back for end-of-run bookkeeping

// Accepts Instagram times, ISO times and SQLite "YYYY-MM-DD HH:MM:SS" (UTC).
export const ms = (t) => {
  if (!t) return 0;
  let v = String(t);
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v)) v = v.replace(' ', 'T') + 'Z';
  return new Date(normTime(v)).getTime();
};
// Instagram returns "2026-11-24T08:00:00+0000"; make it ISO-parseable everywhere.
export function normTime(t) {
  if (!t) return t;
  return String(t).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

export function matchesKeyword(text, keywords) {
  if (!text) return null;
  const hay = text.toLowerCase();
  for (const raw of String(keywords).split(',')) {
    const kw = raw.trim().toLowerCase();
    if (!kw) continue;
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u');
    if (re.test(hay)) return kw;
  }
  return null;
}

function fill(template, lead, campaign) {
  return String(template || '')
    .replaceAll('{name}', lead.commenter_username ? '@' + lead.commenter_username : 'there')
    .replaceAll('{link}', campaign.link_url)
    .slice(0, 1000);
}

function linkMessage(lead, campaign) {
  let text = fill(campaign.link_text, lead, campaign);
  if (!String(campaign.link_text).includes('{link}')) text = `${text}\n\n${campaign.link_url}`.slice(0, 1000);
  return { text };
}

function buttonMessage(text, campaign, lead) {
  return {
    text,
    quick_replies: [{ content_type: 'text', title: (campaign.button_text || 'Send me the link').slice(0, 20), payload: `LINK_${lead.id}` }],
  };
}

const TEXT_FALLBACK_SUFFIX = '\n\nReply with any message to get the link.';

async function updateLead(env, id, fields) {
  const keys = Object.keys(fields);
  const sql = `UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`;
  await env.DB.prepare(sql).bind(...keys.map((k) => fields[k]), id).run();
}

async function acquireLock(env, wait) {
  await env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('run_lock', '0')`).run();
  for (let i = 0; ; i++) {
    const now = Date.now();
    const r = await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'run_lock' AND CAST(value AS INTEGER) < ?`)
      .bind(String(now), now - LOCK_STALE_MS).run();
    if (r.meta.changes === 1) return true;
    // The cron waits a little for the previous minute's last check to finish instead of skipping a whole minute.
    if (!wait || i >= LOCK_WAIT_TRIES) return false;
    await sleep(LOCK_WAIT_MS);
  }
}
async function touchLock(env) {
  await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'run_lock'`).bind(String(Date.now())).run();
}
async function releaseLock(env) {
  await env.DB.prepare(`UPDATE settings SET value = '0' WHERE key = 'run_lock'`).run();
}

const sleep = (t) => new Promise((r) => setTimeout(r, t));

// Runs fn over items, at most `limit` at the same time (Meta calls take seconds each, so doing a few
// side by side saves most of the wait). Stops starting new ones after an error, waits for the
// running ones, then rethrows the first error.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let firstErr = null;
  const worker = async () => {
    while (next < items.length && !firstErr) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { firstErr = firstErr || e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (firstErr) throw firstErr;
  return out;
}

// When each check starts, in seconds after the cron fires. Cron can't run more often than once a
// minute, so one cron run does several checks (default 0s, 20s, 40s): DMs go out ~10s after a
// comment on average instead of ~30s. All checks in a minute share the 45-call and 50-query limits.
export function passSchedule(raw) {
  const list = String(raw ?? PASS_DEFAULT).split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= LAST_PASS_START_S);
  return list.length ? [...new Set(list)].sort((a, b) => a - b) : [0];
}

export async function runOnce(rawEnv, trigger = 'cron') {
  const started = Date.now();
  // Count database queries: Cloudflare's free plan allows 50 per run.
  const { env, counter } = countQueries(rawEnv);
  const dbLimit = Number(rawEnv.DB_QUERY_BUDGET || DB_QUERY_LIMIT);
  const guard = () => { if (dbLimit - counter.n < DB_RESERVE) throw new BudgetExceeded(); };
  const summary = { trigger, at: nowIso(), newLeads: 0, dmsSent: 0, publicReplies: 0, taps: 0, delivered: 0, followFails: 0, calls: 0, passes: 0, stoppedBy: null };
  // Debug timing: ms spent in each step, so slow runs can be explained from the log.
  const steps = {};
  let tMark = started;
  const mark = (name) => { const n = Date.now(); steps[name] = n - tMark; tMark = n; };

  if (!(await acquireLock(env, trigger === 'cron'))) {
    summary.stoppedBy = 'another run in progress';
    return summary;
  }
  mark('lock');
  let ig;
  try {
    let s = await getSettings(env);
    if (!s.access_token) { summary.stoppedBy = 'not connected'; return summary; }
    if (s.token_status === 'invalid') { summary.stoppedBy = 'token invalid - paste a new one in Settings'; return summary; }
    if (s.paused === '1') { summary.stoppedBy = 'paused'; return summary; }

    ig = new Instagram(env, s.access_token, undefined, s.ig_user_id);
    const me = await ensureMe(env, ig, s);
    await maybeRefreshToken(env, ig, s);
    mark('setup');

    const passAt = trigger === 'cron' ? passSchedule(rawEnv.PASS_SECONDS) : [0];
    for (let i = 0; i < passAt.length; i++) {
      if (i > 0) {
        if (ig.remaining() < 8 || dbLimit - counter.n < DB_RESERVE + 10) { summary.extraChecks = 'skipped: limits nearly used'; break; }
        const wait = started + passAt[i] * 1000 - Date.now();
        if (wait > 0) await sleep(wait);
        else if (Date.now() - started > LAST_PASS_START_S * 1000) break;
        mark(`wait${i + 1}`);
        s = await getSettings(env); // stop if paused or disconnected meanwhile
        if (s.paused === '1' || s.token_status === 'invalid' || !s.access_token) break;
        await touchLock(env);
      }
      await onePass(env, ig, me, summary, guard, i === 0, steps, i + 1);
      summary.passes++;
      tMark = Date.now();
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      summary.stoppedBy = 'call budget used up - continues next minute';
      await log(env, 'info', 'budget_used', { calls: ig?.calls, dbQueries: counter.n });
    } else if (e instanceof IgError && e.tokenProblem) {
      summary.stoppedBy = 'Instagram token rejected';
      await setSetting(env, 'token_status', 'invalid');
      await log(env, 'error', 'token_rejected', e.summary());
    } else if (e instanceof IgError && e.rateLimited) {
      summary.stoppedBy = 'Instagram rate limit - waiting';
      await log(env, 'warn', 'rate_limited', e.summary());
    } else {
      summary.stoppedBy = 'error: ' + (e.message || String(e));
      await log(env, 'error', 'run_crashed', { message: e.message, stack: String(e.stack || '').slice(0, 1500), ...(e.summary ? e.summary() : {}) });
    }
  } finally {
    summary.calls = ig?.calls || 0;
    summary.ms = Date.now() - started;
    summary.steps = steps;
    summary.metaMs = ig?.ms || 0;
    summary.metaCalls = ig?.trace || [];
    summary.dbQueries = counter.n + 1; // + this last_run write
    await setSetting(env, 'last_run', JSON.stringify(summary));
    const busy = summary.newLeads || summary.dmsSent || summary.taps || summary.delivered;
    if (busy || trigger !== 'cron') await log(env, 'info', 'run', summary);
    if (Math.random() < 0.05 || trigger !== 'cron') await pruneLogs(env);
    await releaseLock(env);
  }
  return summary;
}

// One check: new comments -> first DMs, and (at the same time) replies -> follow check -> link.
async function onePass(env, ig, me, summary, guard, first, steps, n) {
  const t0 = Date.now();
  const { results: campaigns } = await env.DB.prepare('SELECT * FROM campaigns WHERE active = 1').all();
  const t = {};
  const comments = (async () => {
    if (campaigns.length) await phaseFindComments(env, ig, me, campaigns, summary, guard);
    await phaseSendFirstDms(env, ig, summary, guard);
  })().finally(() => { t.comments = Date.now() - t0; });
  const replies = phaseHandleReplies(env, ig, me, summary, guard, first).finally(() => { t.replies = Date.now() - t0; });
  const [a, b] = await Promise.allSettled([comments, replies]);
  steps[`check${n}`] = t;
  if (a.status === 'rejected') throw a.reason;
  if (b.status === 'rejected') throw b.reason;
}

async function ensureMe(env, ig, s) {
  if (s.ig_user_id && s.ig_username) return { user_id: s.ig_user_id, id: s.ig_app_scoped_id, username: s.ig_username };
  const me = await ig.me();
  await setSetting(env, 'ig_user_id', me.user_id || me.id);
  await setSetting(env, 'ig_app_scoped_id', me.id || '');
  await setSetting(env, 'ig_username', me.username || '');
  await log(env, 'info', 'connected_account', me);
  return { user_id: me.user_id || me.id, id: me.id, username: me.username };
}

function isMine(from, me) {
  if (!from) return false;
  return (from.id && (from.id === me.user_id || from.id === me.id)) || (from.username && me.username && from.username === me.username);
}

async function maybeRefreshToken(env, ig, s) {
  if (ig.fb) return; // EAA system-user tokens don't expire
  const last = Number(s.token_refreshed_at || s.token_saved_at || 0);
  if (!last || Date.now() - last < TOKEN_REFRESH_EVERY) return;
  try {
    const r = await ig.refreshToken();
    if (r && r.access_token) {
      ig.token = r.access_token;
      await setSetting(env, 'access_token', r.access_token);
      await setSetting(env, 'token_refreshed_at', Date.now());
      if (r.expires_in) await setSetting(env, 'token_expires_at', Date.now() + r.expires_in * 1000);
      await log(env, 'info', 'token_refreshed', { expires_in_days: Math.round((r.expires_in || 0) / 86400) });
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    await log(env, 'warn', 'token_refresh_failed', e.summary ? e.summary() : e.message);
    // Try again tomorrow, not every minute.
    await setSetting(env, 'token_refreshed_at', Date.now() - TOKEN_REFRESH_EVERY + DAY);
  }
}

// ---------- Phase A: find keyword comments ----------
async function phaseFindComments(env, ig, me, campaigns, summary, guard) {
  const anyPost = campaigns.filter((c) => !c.media_id);
  const byMedia = new Map();
  for (const c of campaigns) if (c.media_id) (byMedia.get(c.media_id) || byMedia.set(c.media_id, []).get(c.media_id)).push(c);

  // Only the fields needed to spot new comments: asking for image URLs made this call ~4s.
  const list = (await ig.recentMedia(25, 'id,comments_count,timestamp')).data || [];
  const media = new Map(list.map((m) => [m.id, m]));
  await mapLimit([...byMedia.keys()].filter((id) => !media.has(id)), 4, async (id) => {
    try { media.set(id, await ig.media(id)); }
    catch (e) { if (e instanceof IgError && !e.tokenProblem && !e.rateLimited) await log(env, 'warn', 'campaign_post_unreadable', { media_id: id, ...e.summary() }); else throw e; }
  });

  const relevantMedia = [...media.values()].filter((m) => (byMedia.get(m.id) || []).length || anyPost.length);
  if (!relevantMedia.length) return;
  // One query for all posts instead of one per post (that was ~4s and up to 25 of the 50 allowed queries).
  const ids = relevantMedia.map((m) => m.id);
  const { results: seenRows } = await env.DB.prepare(`SELECT * FROM media_seen WHERE media_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const seenMap = new Map(seenRows.map((r) => [r.media_id, r]));

  const quick = []; // small bookkeeping writes, sent as one batch (counts as one query)
  const todo = [];
  for (const m of relevantMedia) {
    const seen = seenMap.get(m.id);
    const count = Number(m.comments_count || 0);
    if (seen && count <= seen.comments_count) {
      if (count < seen.comments_count) quick.push(env.DB.prepare('UPDATE media_seen SET comments_count = ? WHERE media_id = ?').bind(count, m.id));
      continue;
    }
    if (!seen && count === 0) {
      quick.push(env.DB.prepare(`INSERT OR IGNORE INTO media_seen (media_id, comments_count, checked_at) VALUES (?, 0, datetime('now'))`).bind(m.id));
      continue;
    }
    const relevant = [...(byMedia.get(m.id) || []), ...anyPost];
    const sinceMs = seen?.newest_comment_at ? ms(seen.newest_comment_at) : 0;
    const oldestCampaignMs = Math.min(...relevant.map((c) => ms(c.created_at)));
    todo.push({ m, count, sinceMs, floorMs: Math.max(sinceMs, oldestCampaignMs, Date.now() - PRIVATE_REPLY_WINDOW) });
  }
  if (quick.length) await env.DB.batch(quick);

  // Read the comments of all changed posts side by side.
  await mapLimit(todo, 4, async (t) => {
    t.items = [];
    t.newest = t.sinceMs;
    let after;
    for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
      const r = await ig.comments(t.m.id, after);
      let reachedOld = false;
      for (const c of r.data || []) {
        const ct = ms(c.timestamp);
        t.newest = Math.max(t.newest, ct);
        if (ct < t.floorMs) { reachedOld = true; continue; }
        t.items.push(c);
      }
      after = r.paging?.cursors?.after;
      if (reachedOld || !r.paging?.next || !after) break;
    }
  });

  // Per post: save all matching comments + mark the post as read in ONE batch (one query), so a
  // flood of comments can't use up the 50 queries before any DM is sent.
  for (const { m, count, items, newest } of todo) {
    guard();
    const matched = [];
    for (const c of items) {
      if (c.parent_id) continue;
      if (isMine(c.from || { username: c.username }, me)) continue;
      const camp = pickCampaign(c, m.id, byMedia, anyPost);
      if (camp) matched.push({ c, camp });
    }
    const stmts = matched.map(({ c, camp }) => env.DB.prepare(
      `INSERT OR IGNORE INTO leads (campaign_id, comment_id, media_id, commenter_id, commenter_username, comment_text, commented_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`
    ).bind(camp.id, c.id, m.id, c.from?.id || null, c.from?.username || c.username || null, (c.text || '').slice(0, 500), new Date(ms(c.timestamp)).toISOString()));
    stmts.push(env.DB.prepare(
      `INSERT INTO media_seen (media_id, comments_count, newest_comment_at, checked_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(media_id) DO UPDATE SET comments_count = excluded.comments_count, newest_comment_at = excluded.newest_comment_at, checked_at = excluded.checked_at`
    ).bind(m.id, count, newest ? new Date(newest).toISOString() : null));
    const res = await env.DB.batch(stmts);
    const fresh = matched.filter((_, i) => res[i]?.meta?.changes);
    summary.newLeads += fresh.length;
    if (fresh.length) {
      await logMany(env, fresh.map(({ c, camp }) => ['info', 'comment_matched', { campaign: camp.name, user: c.from?.username || c.username, text: c.text, comment_id: c.id }]));
    }
  }
}

function pickCampaign(comment, mediaId, byMedia, anyPost) {
  for (const c of byMedia.get(mediaId) || []) if (matchesKeyword(comment.text, c.keywords) && ms(comment.timestamp) > ms(c.created_at)) return c;
  for (const c of anyPost) if (matchesKeyword(comment.text, c.keywords) && ms(comment.timestamp) > ms(c.created_at)) return c;
  return null;
}

// ---------- Phase B: first DM (private reply) + public reply ----------
async function phaseSendFirstDms(env, ig, summary, guard) {
  const { results: leads } = await env.DB.prepare(
    `SELECT l.*, c.name AS c_name, c.comment_replies, c.dm_text, c.button_text, c.require_follow, c.link_text, c.link_url, c.not_following_text
     FROM leads l JOIN campaigns c ON c.id = l.campaign_id WHERE l.status = 'new' ORDER BY l.id LIMIT 20`
  ).all();
  if (!leads.length) return;
  // Each person needs up to 3 calls (DM with button, plain DM fallback, public reply). Start only as
  // many as the budget covers; the rest wait for the next check.
  const now = leads.slice(0, Math.floor(ig.remaining() / 3));
  await mapLimit(now, 5, (lead) => sendFirstDm(env, ig, lead, summary, guard));
  if (now.length < leads.length) throw new BudgetExceeded();
}

async function sendFirstDm(env, ig, lead, summary, guard) {
  guard();
  const camp = campaignOf(lead);
  if (Date.now() - ms(lead.commented_at) > PRIVATE_REPLY_WINDOW - 60_000) {
    await updateLead(env, lead.id, { status: 'expired', last_error: 'comment older than 7 days' });
    return;
  }
  if (ig.remaining() < 2) throw new BudgetExceeded();

  let sent = null;
  let mode;
  const base = fill(camp.dm_text, lead, camp);
  if (!camp.require_follow) {
    // No follow gate: the first DM carries the link directly.
    mode = 'link';
    sent = await tryPrivateReply(env, ig, lead, linkMessage(lead, camp));
  } else {
    mode = 'button';
    sent = await tryPrivateReply(env, ig, lead, buttonMessage(base, camp, lead));
    if (!sent.ok && !sent.fatal) {
      mode = 'text';
      if (ig.remaining() < 2) throw new BudgetExceeded();
      sent = await tryPrivateReply(env, ig, lead, { text: (base + TEXT_FALLBACK_SUFFIX).slice(0, 1000) });
    }
  }

  if (sent.ok) {
    summary.dmsSent++;
    const fields = {
      status: mode === 'link' ? 'delivered' : 'waiting_tap',
      dm_mode: mode,
      dm_sent_at: nowIso(),
      commenter_id: sent.res.recipient_id || lead.commenter_id,
      last_error: null,
    };
    if (mode === 'link') { fields.delivered_at = nowIso(); summary.delivered++; }
    await updateLead(env, lead.id, fields);
    await log(env, 'info', 'dm_sent', { user: lead.commenter_username, campaign: camp.name, mode, message_id: sent.res.message_id });

    const replies = String(camp.comment_replies || '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (replies.length) {
      const text = fill(replies[Math.floor(Math.random() * replies.length)], lead, camp);
      try {
        await ig.replyToComment(lead.comment_id, text);
        await updateLead(env, lead.id, { public_reply: 'sent' });
        summary.publicReplies++;
      } catch (e) {
        if (e instanceof BudgetExceeded || (e instanceof IgError && (e.tokenProblem || e.rateLimited))) {
          await updateLead(env, lead.id, { public_reply: 'failed' });
          throw e;
        }
        await updateLead(env, lead.id, { public_reply: 'failed' });
        await log(env, 'warn', 'public_reply_failed', { user: lead.commenter_username, ...(e.summary ? e.summary() : { message: e.message }) });
      }
    } else {
      await updateLead(env, lead.id, { public_reply: 'off' });
    }
  } else {
    const attempts = lead.attempts + 1;
    await updateLead(env, lead.id, {
      attempts,
      last_error: sent.error,
      status: attempts >= MAX_DM_ATTEMPTS || sent.fatal ? 'dm_failed' : 'new',
    });
  }
}

async function tryPrivateReply(env, ig, lead, message) {
  try {
    const res = await ig.privateReply(lead.comment_id, message);
    return { ok: true, res };
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    if (e instanceof IgError && (e.tokenProblem || e.rateLimited)) throw e;
    const kind = message.quick_replies ? 'with button' : 'plain';
    await log(env, 'warn', 'dm_failed', { user: lead.commenter_username, kind, ...(e.summary ? e.summary() : { message: e.message }) });
    // 551 / 10 / 100 with "already replied" style errors won't succeed on retry.
    const fatal = e instanceof IgError && /already|window|expired|not allowed/i.test(e.message || '') && !message.quick_replies;
    return { ok: false, fatal, error: e.message || String(e) };
  }
}

function campaignOf(lead) {
  return {
    id: lead.campaign_id, name: lead.c_name, comment_replies: lead.comment_replies, dm_text: lead.dm_text,
    button_text: lead.button_text, require_follow: lead.require_follow, link_text: lead.link_text,
    link_url: lead.link_url, not_following_text: lead.not_following_text,
  };
}

// ---------- Phase C: read replies, check follow, deliver link ----------
async function phaseHandleReplies(env, ig, me, summary, guard, first) {
  // Give up on people who never replied after 30 days (once a minute is plenty).
  if (first) {
    await env.DB.prepare(`UPDATE leads SET status = 'expired', updated_at = datetime('now') WHERE status = 'waiting_tap' AND dm_sent_at < ?`)
      .bind(new Date(Date.now() - WAIT_FOR_TAP_MAX).toISOString()).run();
  }

  const { results: waiting } = await env.DB.prepare(
    `SELECT l.*, c.name AS c_name, c.comment_replies, c.dm_text, c.button_text, c.require_follow, c.link_text, c.link_url, c.not_following_text
     FROM leads l JOIN campaigns c ON c.id = l.campaign_id WHERE l.status = 'waiting_tap' ORDER BY l.updated_at LIMIT 200`
  ).all();
  if (!waiting.length) return;

  const convs = (await ig.conversations(50)).data || [];
  const updated = new Map(convs.map((c) => [c.id, c.updated_time]));
  // Handle a few people side by side.
  await mapLimit(waiting, 4, (lead) => handleReply(env, ig, me, summary, guard, lead, updated));
}

async function handleReply(env, ig, me, summary, guard, lead, updated) {
  if (ig.remaining() < 3) throw new BudgetExceeded();
  let convId = lead.conv_id;
  if (!convId) {
    if (!lead.commenter_id) return;
    guard();
    const r = await ig.conversationWith(lead.commenter_id);
    const c = (r.data || [])[0];
    if (!c) return; // conversation not visible yet; try next check
    convId = c.id;
    updated.set(c.id, c.updated_time);
    await updateLead(env, lead.id, { conv_id: convId });
  }
  const upd = updated.get(convId);
  if (!upd || upd === lead.conv_seen_at) return; // nothing new in this chat
  guard();

  // Instagram times have 1-second precision, so allow a 1-second margin around our DM.
  const after = Math.max(Math.floor(ms(lead.dm_sent_at) / 1000) * 1000 - 1000, ms(lead.last_handled_msg_at));
  const msgs = await readMessages(ig, convId, after);
  const fromThem = msgs.filter((m) => !isMine(m.from, me) && ms(m.created_time) > after)
    .sort((a, b) => ms(b.created_time) - ms(a.created_time));
  // updated_time has 1-second precision: only mark a chat as "seen" once that second is safely past,
  // otherwise a reply landing in the same second would be missed.
  const seenMark = Date.now() - ms(upd) > 5000 ? upd : lead.conv_seen_at;
  if (!fromThem.length) {
    if (seenMark !== lead.conv_seen_at) await updateLead(env, lead.id, { conv_seen_at: seenMark });
    return;
  }

  const camp = campaignOf(lead);
  const tap = fromThem[0];
  summary.taps++;
  const igsid = lead.commenter_id || tap.from?.id;
  let follows = true;
  if (camp.require_follow) {
    const p = await ig.userProfile(igsid);
    follows = p.is_user_follow_business === true;
  }
  if (follows) {
    await ig.sendMessage(igsid, linkMessage(lead, camp));
    await updateLead(env, lead.id, {
      status: 'delivered', delivered_at: nowIso(), taps: lead.taps + 1,
      last_handled_msg_at: normTime(tap.created_time), conv_seen_at: seenMark,
    });
    summary.delivered++;
    await log(env, 'info', 'link_delivered', { user: lead.commenter_username, campaign: camp.name, after_follow_fails: lead.follow_fails });
  } else {
    await ig.sendMessage(igsid, buttonMessage(fill(camp.not_following_text, lead, camp), camp, lead));
    await updateLead(env, lead.id, {
      follow_fails: lead.follow_fails + 1, taps: lead.taps + 1,
      last_handled_msg_at: normTime(tap.created_time), conv_seen_at: seenMark,
    });
    summary.followFails++;
    await log(env, 'info', 'not_following', { user: lead.commenter_username, campaign: camp.name });
  }
}

async function readMessages(ig, convId, afterMs) {
  const r = await ig.conversationMessages(convId);
  let list = r.messages?.data || [];
  // If Meta only returned ids (no sender/text), fetch the newest few one by one.
  if (list.length && !list[0].from) {
    const fresh = list.filter((m) => !m.created_time || ms(m.created_time) > afterMs).slice(0, 3);
    const full = [];
    for (const m of fresh) full.push(await ig.message(m.id));
    list = full;
  }
  return list;
}

// ---------- Dashboard helpers ----------
export async function connectionTest(env, token) {
  const ig = new Instagram(env, token, 10);
  const steps = [];
  const step = async (name, fn) => {
    try { const detail = await fn(); steps.push({ name, ok: true, detail }); return true; }
    catch (e) { steps.push({ name, ok: false, detail: e.summary ? `${e.message} (code ${e.code ?? e.status})` : e.message }); return false; }
  };
  let me, media;
  await step('Token works and account found', async () => { me = await ig.me(); return `@${me.username} (${me.account_type || 'professional'})`; });
  if (!me) return { me: null, steps };
  await step('Can list your posts', async () => { media = (await ig.recentMedia(10)).data || []; return `${media.length} recent posts`; });
  const withComments = (media || []).find((m) => m.comments_count > 0);
  if (withComments) {
    await step('Can read comments (incl. strangers)', async () => {
      const c = (await ig.comments(withComments.id)).data || [];
      const strangers = c.filter((x) => !isMine(x.from || { username: x.username }, { user_id: me.user_id, id: me.id, username: me.username })).length;
      return `${c.length} comments on newest commented post, ${strangers} from other accounts`;
    });
  } else steps.push({ name: 'Can read comments', ok: null, detail: 'No post with comments yet, skipped' });
  await step('Can read DM inbox', async () => { const c = (await ig.conversations(5)).data || []; return `${c.length} recent conversations`; });
  return { me, steps };
}
