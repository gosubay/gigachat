// Entry point: web dashboard (fetch) + the once-a-minute check (scheduled).
import { runOnce, connectionTest } from './engine.js';
import { getSettings, setSetting, log } from './db.js';
import { isLoggedIn, checkPassword, sessionCookie, clearCookie } from './auth.js';
import { Instagram } from './instagram.js';
import * as ui from './dashboard.js';

const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { Location: to, ...headers } });
const withFlash = (to, msg) => `${to}${to.includes('?') ? '&' : '?'}flash=${encodeURIComponent(msg)}`;

const STATS_SQL = `SELECT campaign_id, COUNT(*) AS comments,
  SUM(dm_sent_at IS NOT NULL) AS dms, SUM(taps > 0) AS tapped, SUM(follow_fails > 0) AS gate_fails,
  SUM(follow_fails > 0 AND status = 'delivered') AS new_followers, SUM(status = 'delivered') AS delivered,
  SUM(status = 'dm_failed') AS failed FROM leads`;

export default {
  async fetch(request, env, ctx) {
    ui.setTimeZone(env.TIMEZONE);
    try {
      return await route(request, env, ctx);
    } catch (e) {
      await log(env, 'error', 'dashboard_crashed', { url: new URL(request.url).pathname, message: e.message, stack: String(e.stack || '').slice(0, 1500) });
      return html(ui.layout('Error', `<div class="card"><h1>Something broke</h1><p class="bad">${ui.esc(e.message)}</p><p>It's recorded in the <a href="/log">debug log</a>.</p></div>`), 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOnce(env, 'cron'));
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  const flash = url.searchParams.get('flash') || '';

  if (path === '/health') return new Response('ok');

  if (path === '/login') {
    if (method === 'POST') {
      const form = await request.formData();
      if (await checkPassword(env, form.get('password'))) {
        return redirect('/', { 'Set-Cookie': await sessionCookie(env, url.protocol === 'https:') });
      }
      await log(env, 'warn', 'login_failed', { ip: request.headers.get('CF-Connecting-IP') });
      return html(ui.loginPage('Wrong password', !env.ADMIN_PASSWORD), 401);
    }
    return html(ui.loginPage('', !env.ADMIN_PASSWORD));
  }

  if (!(await isLoggedIn(request, env))) return redirect('/login');

  if (path === '/logout' && method === 'POST') return redirect('/login', { 'Set-Cookie': clearCookie() });

  if (path === '/' && method === 'GET') {
    const s = await getSettings(env);
    const { results: campaigns } = await env.DB.prepare('SELECT * FROM campaigns ORDER BY active DESC, id DESC').all();
    const { results: stats } = await env.DB.prepare(`${STATS_SQL} GROUP BY campaign_id`).all();
    return html(ui.homePage(s, campaigns, stats, flash));
  }

  if (path === '/run-now' && method === 'POST') {
    const r = await runOnce(env, 'manual');
    const msg = r.stoppedBy
      ? `Check finished: ${r.stoppedBy}.`
      : `Check finished: ${r.newLeads} new comments, ${r.dmsSent} DMs sent, ${r.delivered} links delivered (${r.calls} Instagram calls).`;
    return redirect(withFlash('/', msg));
  }

  // ----- campaigns -----
  if (path === '/campaigns/new' && method === 'GET') {
    return html(ui.campaignForm(null, await recentMediaSafe(env)));
  }
  if (path === '/campaigns' && method === 'POST') {
    const f = await readCampaignForm(request, env);
    if (f.error) return html(ui.campaignForm(f.values, await recentMediaSafe(env), f.error), 400);
    const v = f.values;
    const r = await env.DB.prepare(
      `INSERT INTO campaigns (name, keywords, media_id, media_label, comment_replies, dm_text, button_text, require_follow, not_following_text, link_text, link_url, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(v.name, v.keywords, v.media_id, v.media_label, v.comment_replies, v.dm_text, v.button_text, v.require_follow, v.not_following_text, v.link_text, v.link_url, v.active).run();
    await log(env, 'info', 'campaign_created', { id: r.meta.last_row_id, name: v.name, keywords: v.keywords });
    return redirect(withFlash(`/campaigns/${r.meta.last_row_id}`, 'Campaign saved. It answers comments posted from now on.'));
  }

  const m = path.match(/^\/campaigns\/(\d+)(\/edit|\/toggle|\/delete)?$/);
  if (m) {
    const id = Number(m[1]);
    const c = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first();
    if (!c) return html(ui.layout('Not found', '<div class="card">Campaign not found. <a href="/">Back</a></div>'), 404);
    const action = m[2];
    if (!action && method === 'GET') {
      const st = await env.DB.prepare(`${STATS_SQL} WHERE campaign_id = ?`).bind(id).first();
      const { results: leads } = await env.DB.prepare('SELECT * FROM leads WHERE campaign_id = ? ORDER BY id DESC LIMIT 300').bind(id).all();
      return html(ui.campaignPage(c, st, leads, flash));
    }
    if (action === '/edit' && method === 'GET') return html(ui.campaignForm(c, await recentMediaSafe(env)));
    if (!action && method === 'POST') {
      const f = await readCampaignForm(request, env);
      if (f.error) return html(ui.campaignForm({ ...f.values, id }, await recentMediaSafe(env), f.error), 400);
      const v = f.values;
      await env.DB.prepare(
        `UPDATE campaigns SET name=?, keywords=?, media_id=?, media_label=?, comment_replies=?, dm_text=?, button_text=?, require_follow=?, not_following_text=?, link_text=?, link_url=?, active=?, updated_at=datetime('now') WHERE id=?`
      ).bind(v.name, v.keywords, v.media_id, v.media_label, v.comment_replies, v.dm_text, v.button_text, v.require_follow, v.not_following_text, v.link_text, v.link_url, v.active, id).run();
      await log(env, 'info', 'campaign_updated', { id, name: v.name });
      return redirect(withFlash(`/campaigns/${id}`, 'Saved.'));
    }
    if (action === '/toggle' && method === 'POST') {
      await env.DB.prepare(`UPDATE campaigns SET active = 1 - active, updated_at = datetime('now') WHERE id = ?`).bind(id).run();
      return redirect(withFlash(`/campaigns/${id}`, c.active ? 'Campaign turned off.' : 'Campaign turned on.'));
    }
    if (action === '/delete' && method === 'POST') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM leads WHERE campaign_id = ?').bind(id),
        env.DB.prepare('DELETE FROM campaigns WHERE id = ?').bind(id),
      ]);
      await log(env, 'info', 'campaign_deleted', { id, name: c.name });
      return redirect(withFlash('/', `Deleted "${c.name}".`));
    }
  }

  // ----- log -----
  if (path === '/log') {
    const level = url.searchParams.get('level') || '';
    const where = level === 'error' ? `WHERE level = 'error'` : level === 'warn' ? `WHERE level IN ('warn','error')` : '';
    const { results } = await env.DB.prepare(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT 300`).all();
    return html(ui.logPage(results, level));
  }

  // Machine-readable snapshot for Claude to self-diagnose.
  if (path === '/debug.json') {
    const s = await getSettings(env);
    delete s.access_token;
    const { results: logs } = await env.DB.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 100').all();
    const { results: leads } = await env.DB.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 50').all();
    return Response.json({ settings: s, logs, leads });
  }

  // ----- settings -----
  if (path === '/settings' && method === 'GET') {
    return html(ui.settingsPage(await getSettings(env), null, flash));
  }
  if (path === '/settings/token' && method === 'POST') {
    const token = String((await request.formData()).get('token') || '').trim();
    if (!token) return html(ui.settingsPage(await getSettings(env), null, 'Paste a token first.', true), 400);
    const test = await connectionTest(env, token);
    if (!test.me) {
      await log(env, 'warn', 'token_test_failed', test.steps);
      return html(ui.settingsPage(await getSettings(env), test, 'That token did not work, so it was NOT saved. See the test below.', true), 400);
    }
    const old = await getSettings(env);
    if (old.ig_user_id && old.ig_user_id !== (test.me.user_id || test.me.id)) {
      await log(env, 'warn', 'account_changed', { from: old.ig_username, to: test.me.username });
    }
    await setSetting(env, 'access_token', token);
    await setSetting(env, 'token_saved_at', Date.now());
    await setSetting(env, 'token_refreshed_at', '');
    await setSetting(env, 'token_status', 'ok');
    await setSetting(env, 'ig_user_id', test.me.user_id || test.me.id);
    await setSetting(env, 'ig_app_scoped_id', test.me.id || '');
    await setSetting(env, 'ig_username', test.me.username || '');
    await log(env, 'info', 'token_saved', { account: test.me.username, steps: test.steps });
    return html(ui.settingsPage(await getSettings(env), test, `Connected as @${test.me.username}.`));
  }
  if (path === '/settings/test' && method === 'POST') {
    const s = await getSettings(env);
    const test = await connectionTest(env, s.access_token || '');
    await log(env, test.steps.every((x) => x.ok !== false) ? 'info' : 'warn', 'connection_test', test.steps);
    return html(ui.settingsPage(s, test));
  }
  if (path === '/settings/pause' && method === 'POST') {
    const paused = String((await request.formData()).get('paused')) === '1' ? '1' : '0';
    await setSetting(env, 'paused', paused);
    await log(env, 'info', paused === '1' ? 'bot_paused' : 'bot_resumed');
    return redirect(withFlash('/settings', paused === '1' ? 'Bot paused. Nothing will be sent.' : 'Bot resumed.'));
  }

  return html(ui.layout('Not found', '<div class="card">Page not found. <a href="/">Back</a></div>'), 404);
}

async function recentMediaSafe(env) {
  const s = await getSettings(env);
  if (!s.access_token || s.token_status === 'invalid') return null;
  try {
    return (await new Instagram(env, s.access_token, 2, s.ig_user_id).recentMedia(25)).data || [];
  } catch (e) {
    await log(env, 'warn', 'media_list_failed', e.summary ? e.summary() : e.message);
    return null;
  }
}

async function readCampaignForm(request, env) {
  const f = await request.formData();
  const g = (k) => String(f.get(k) ?? '').trim();
  const values = {
    name: g('name'), keywords: g('keywords'), media_id: g('media_id') || null, media_label: null,
    comment_replies: g('comment_replies'), dm_text: g('dm_text'), button_text: g('button_text').slice(0, 20) || 'Send me the link',
    require_follow: f.get('require_follow') ? 1 : 0, not_following_text: g('not_following_text') || 'Follow me first, then tap the button again 🙏',
    link_text: g('link_text'), link_url: g('link_url'), active: f.get('active') ? 1 : 0,
  };
  values.keywords = values.keywords.split(',').map((k) => k.trim()).filter(Boolean).join(', ');
  let error = null;
  if (!values.name || !values.keywords || !values.dm_text || !values.link_text || !values.link_url) error = 'Please fill in name, keyword, first DM, link message and link.';
  else if (!/^https?:\/\//i.test(values.link_url)) error = 'The link must start with https://';
  if (values.media_id) {
    const media = await recentMediaSafe(env);
    const hit = (media || []).find((m) => m.id === values.media_id);
    values.media_label = hit ? `${(hit.caption || 'post').slice(0, 40)} (${ui.localTime(hit.timestamp)})` : `post ${values.media_id}`;
  }
  return { values, error };
}
