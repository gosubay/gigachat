// Dashboard pages (plain server-rendered HTML, works on phone and desktop).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Dashboard times are shown in the TIMEZONE setting from wrangler.jsonc (e.g. "Europe/London").
let TZ = 'UTC';
export function setTimeZone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz || 'UTC' }); TZ = tz || 'UTC'; } catch { TZ = 'UTC'; }
}

export function localTime(t) {
  if (!t) return '—';
  const d = new Date(typeof t === 'number' ? t : String(t).includes('T') ? t : String(t).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return esc(t);
  return d.toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

const CSS = `
:root{--bg:#0b0d10;--card:#14181d;--line:#262c34;--text:#e8edf2;--muted:#8b96a3;--accent:#c6f432;--bad:#ff6b6b;--warn:#ffb547;--ok:#4ade80}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid var(--line);background:#0f1216;position:sticky;top:0;z-index:2}
header b{font-size:16px;margin-right:8px}header nav{display:flex;gap:14px;flex-wrap:wrap}header nav a{color:var(--muted)}header nav a.on{color:var(--text)}
main{max-width:1100px;margin:0 auto;padding:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:18px}
h1{font-size:22px;margin:0 0 14px}h2{font-size:17px;margin:0 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.stat{background:#0f1216;border:1px solid var(--line);border-radius:10px;padding:12px}.stat .n{font-size:24px;font-weight:700}.stat .l{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.tw{overflow-x:auto}
.btn{display:inline-block;background:var(--accent);color:#111;border:0;border-radius:8px;padding:9px 16px;font-weight:600;cursor:pointer;font-size:14px}
.btn.sec{background:transparent;color:var(--text);border:1px solid var(--line)}.btn.bad{background:var(--bad);color:#111}
form.inline{display:inline}
label{display:block;margin:14px 0 4px;font-weight:600;font-size:14px}.hint{color:var(--muted);font-size:13px;font-weight:400}
input[type=text],input[type=url],input[type=password],textarea,select{width:100%;background:#0f1216;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 10px;font:inherit}
textarea{min-height:70px}
.pill{display:inline-block;padding:1px 9px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.muted{color:var(--muted)}
.flash{padding:12px 14px;border-radius:10px;margin-bottom:16px;border:1px solid var(--line);background:#132016}
.flash.err{background:#2a1414}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;margin:0;color:#c9d1d9}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
`;

export function layout(title, body, { nav = '', flash = '', flashErr = false } = {}) {
  const link = (href, name) => `<a href="${href}" class="${nav === href ? 'on' : ''}">${name}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · GigaChat</title><style>${CSS}</style></head><body>
<header><b>⚡ GigaChat</b><nav>${link('/', 'Campaigns')}${link('/log', 'Debug log')}${link('/settings', 'Settings')}</nav></header>
<main>${flash ? `<div class="flash ${flashErr ? 'err' : ''}">${esc(flash)}</div>` : ''}${body}</main></body></html>`;
}

export function loginPage(error, noPassword) {
  return layout('Sign in', `<div class="card" style="max-width:380px;margin:40px auto">
<h1>Sign in</h1>
${noPassword ? '<p class="bad">No dashboard password is set yet. Claude sets it with <code>wrangler secret put ADMIN_PASSWORD</code>.</p>' : ''}
${error ? `<p class="bad">${esc(error)}</p>` : ''}
<form method="post" action="/login"><label>Password</label><input type="password" name="password" autofocus>
<p><button class="btn">Sign in</button></p></form></div>`);
}

export function statusCard(s) {
  const run = s.last_run ? JSON.parse(s.last_run) : null;
  const connected = !!s.access_token;
  const tokenBad = s.token_status === 'invalid';
  const expires = s.token_expires_at ? Number(s.token_expires_at) : null;
  let state;
  if (!connected) state = `<span class="warn">Not connected</span> — <a href="/settings">paste your Instagram token</a>`;
  else if (tokenBad) state = `<span class="bad">Instagram rejected the token</span> — <a href="/settings">paste a new one</a>`;
  else if (s.paused === '1') state = `<span class="warn">Paused</span> (not sending anything)`;
  else state = `<span class="ok">Running</span> as @${esc(s.ig_username || '?')} · checks every minute`;
  return `<div class="card"><div class="row" style="justify-content:space-between">
<div><h2 style="margin:0">Bot status</h2><div>${state}</div>
<div class="muted" style="font-size:13px">Last check: ${run ? `${localTime(run.at)} — ${run.stoppedBy ? esc(run.stoppedBy) : `ok, ${run.calls} Instagram calls`}` : 'never'}
${expires ? ` · Token valid until ${localTime(expires)} (auto-renews)` : ''}</div></div>
<form method="post" action="/run-now" class="inline"><button class="btn sec">Run check now</button></form></div></div>`;
}

export function homePage(s, campaigns, stats, flash) {
  const by = new Map(stats.map((x) => [x.campaign_id, x]));
  const rows = campaigns.map((c) => {
    const st = by.get(c.id) || {};
    return `<tr><td><a href="/campaigns/${c.id}"><b>${esc(c.name)}</b></a><br><span class="muted">${esc(c.keywords)} · ${c.media_id ? esc(c.media_label || 'one post') : 'any post'}</span></td>
<td>${c.active ? '<span class="pill ok">On</span>' : '<span class="pill muted">Off</span>'}</td>
<td>${st.comments || 0}</td><td>${st.dms || 0}</td><td>${st.tapped || 0}</td><td>${st.new_followers || 0}</td><td><b>${st.delivered || 0}</b></td><td class="${st.failed ? 'bad' : ''}">${st.failed || 0}</td></tr>`;
  }).join('');
  return layout('Campaigns', `${statusCard(s)}
<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:8px"><h1 style="margin:0">Campaigns</h1><a class="btn" href="/campaigns/new">+ New campaign</a></div>
${campaigns.length ? `<div class="tw"><table><tr><th>Campaign</th><th></th><th>Comments</th><th>DMs sent</th><th>Replied</th><th>New followers</th><th>Links delivered</th><th>Failed</th></tr>${rows}</table></div>`
    : '<p class="muted">No campaigns yet. Create one: pick a keyword, a post and the link to send.</p>'}
<p class="hint">New followers = people who weren't following when they asked, then followed and got the link.</p></div>`, { nav: '/', flash });
}

export function campaignForm(c, media, error) {
  const v = (k, d = '') => esc(c?.[k] ?? d);
  const opts = [`<option value="">Any post (all posts)</option>`]
    .concat((media || []).map((m) => `<option value="${esc(m.id)}" ${c?.media_id === m.id ? 'selected' : ''}>${esc(localTime(m.timestamp))} · ${esc((m.caption || '(no caption)').slice(0, 60))} · ${m.comments_count ?? 0} comments</option>`));
  if (c?.media_id && !(media || []).some((m) => m.id === c.media_id)) opts.push(`<option value="${esc(c.media_id)}" selected>${esc(c.media_label || c.media_id)}</option>`);
  const isNew = !c?.id;
  return layout(isNew ? 'New campaign' : 'Edit campaign', `<div class="card"><h1>${isNew ? 'New campaign' : 'Edit campaign'}</h1>
${error ? `<p class="bad">${esc(error)}</p>` : ''}
<form method="post" action="${isNew ? '/campaigns' : `/campaigns/${c.id}`}">
<label>Name <span class="hint">— only you see this</span></label><input type="text" name="name" required value="${v('name')}" placeholder="Video Analyzer giveaway">
<label>Keyword(s) <span class="hint">— comma separated, not case-sensitive, matched as whole words</span></label><input type="text" name="keywords" required value="${v('keywords')}" placeholder="AI, analyzer">
<label>Which post</label><select name="media_id">${opts.join('')}</select>
${media ? '' : '<p class="hint warn">Connect Instagram in Settings to pick a specific post. Until then only "Any post" is available.</p>'}
<label>Public reply under their comment <span class="hint">— one per line, the bot picks one at random. Leave empty for no public reply.</span></label>
<textarea name="comment_replies">${v('comment_replies', 'Sent! Check your DMs 📩\nJust DMed you 🔥\nCheck your inbox 👀')}</textarea>
<label>First DM <span class="hint">— {name} becomes their @username</span></label><textarea name="dm_text" required>${v('dm_text', 'Hey {name}! Here’s the file you asked for. Tap the button below 👇')}</textarea>
<label>Button text <span class="hint">— max 20 characters</span></label><input type="text" name="button_text" maxlength="20" value="${v('button_text', 'Send me the link')}">
<label><input type="checkbox" name="require_follow" value="1" ${c ? (c.require_follow ? 'checked' : '') : 'checked'}> Only send the link to followers (follow gate)</label>
<label>Message if they don't follow yet</label><textarea name="not_following_text">${v('not_following_text', 'Almost there! Follow me first, then tap the button again 🙏')}</textarea>
<label>Message with the link <span class="hint">— {link} is replaced with the link</span></label><textarea name="link_text" required>${v('link_text', 'Here you go 👉 {link}\n\nEnjoy!')}</textarea>
<label>Link</label><input type="url" name="link_url" required value="${v('link_url')}" placeholder="https://github.com/...">
<label><input type="checkbox" name="active" value="1" ${c ? (c.active ? 'checked' : '') : 'checked'}> Campaign is on</label>
<p class="hint">Only comments posted <b>after</b> a campaign is created are answered, so old comments never get a surprise DM.</p>
<p class="row"><button class="btn">Save</button><a class="btn sec" href="${isNew ? '/' : `/campaigns/${c.id}`}">Cancel</a></p></form></div>`, { nav: '/' });
}

const STATUS = {
  new: ['Queued', 'muted'], waiting_tap: ['DM sent, waiting for reply', 'warn'], delivered: ['Link delivered', 'ok'],
  dm_failed: ['DM failed', 'bad'], expired: ['Expired', 'muted'],
};

export function campaignPage(c, st, leads, flash) {
  st = st || {};
  const tiles = [['Comments caught', st.comments], ['DMs sent', st.dms], ['Replied / tapped', st.tapped], ['Not following at first', st.gate_fails], ['New followers', st.new_followers], ['Links delivered', st.delivered], ['Failed', st.failed]]
    .map(([l, n]) => `<div class="stat"><div class="n">${n || 0}</div><div class="l">${l}</div></div>`).join('');
  const rows = leads.map((l) => {
    const [label, cls] = STATUS[l.status] || [l.status, ''];
    return `<tr><td>${localTime(l.created_at)}</td><td>@${esc(l.commenter_username || '?')}</td><td>${esc(l.comment_text)}</td>
<td class="${cls}">${label}${l.follow_fails ? ` <span class="muted">(${l.follow_fails}× not following)</span>` : ''}${l.dm_mode === 'text' ? ' <span class="muted">(no button)</span>' : ''}
${l.last_error ? `<br><span class="bad" style="font-size:12px">${esc(l.last_error)}</span>` : ''}</td><td class="muted">${esc(l.public_reply || '—')}</td></tr>`;
  }).join('');
  return layout(c.name, `<div class="card"><div class="row" style="justify-content:space-between"><div><h1 style="margin:0">${esc(c.name)}</h1>
<div class="muted">Keywords: ${esc(c.keywords)} · ${c.media_id ? esc(c.media_label || 'one post') : 'any post'} · ${c.active ? '<span class="ok">On</span>' : 'Off'}</div></div>
<div class="row"><a class="btn sec" href="/campaigns/${c.id}/edit">Edit</a>
<form method="post" action="/campaigns/${c.id}/toggle" class="inline"><button class="btn sec">${c.active ? 'Turn off' : 'Turn on'}</button></form>
<form method="post" action="/campaigns/${c.id}/delete" class="inline" onsubmit="return confirm('Delete this campaign and its stats? This cannot be undone.')"><button class="btn bad">Delete</button></form></div></div>
<div class="grid" style="margin-top:16px">${tiles}</div></div>
<div class="card"><h2>People (newest first)</h2>${leads.length ? `<div class="tw"><table><tr><th>When</th><th>Who</th><th>Comment</th><th>Status</th><th>Public reply</th></tr>${rows}</table></div>` : '<p class="muted">Nobody yet.</p>'}</div>`, { nav: '/', flash });
}

export function logPage(rows, level) {
  const f = (l, name) => `<a class="pill ${level === l ? 'ok' : ''}" href="/log${l ? `?level=${l}` : ''}">${name}</a>`;
  const body = rows.map((r) => `<tr><td style="white-space:nowrap">${localTime(r.ts)}</td><td class="${r.level === 'error' ? 'bad' : r.level === 'warn' ? 'warn' : 'muted'}">${r.level}</td><td><b>${esc(r.event)}</b><pre>${esc(r.detail || '')}</pre></td></tr>`).join('');
  return layout('Debug log', `<div class="card"><div class="row" style="justify-content:space-between"><h1 style="margin:0">Debug log</h1>
<div class="row">${f('', 'All')}${f('warn', 'Warnings + errors')}${f('error', 'Errors')}</div></div>
<p class="hint">Every DM, failure and manual check is recorded here (newest 5,000 kept). Quiet minutes aren't logged.</p>
${rows.length ? `<div class="tw"><table>${body}</table></div>` : '<p class="muted">Nothing logged yet.</p>'}</div>`, { nav: '/log' });
}

export function settingsPage(s, test, flash, flashErr) {
  const testHtml = test ? `<div class="card"><h2>Connection test</h2><table>${test.steps.map((x) => `<tr><td>${x.ok === true ? '<span class="ok">✔</span>' : x.ok === false ? '<span class="bad">✘</span>' : '<span class="muted">–</span>'}</td><td>${esc(x.name)}</td><td class="muted">${esc(x.detail)}</td></tr>`).join('')}</table>
<p class="hint">This checks reading. Sending DMs to strangers is proven by the real test: a second account comments your keyword.</p></div>` : '';
  return layout('Settings', `${testHtml}
<div class="card"><h2>Instagram connection</h2>
<p>${s.access_token ? `Connected as <b>@${esc(s.ig_username || '?')}</b>${s.token_status === 'invalid' ? ' — <span class="bad">token rejected, paste a new one</span>' : ''}` : '<span class="warn">Not connected yet.</span>'}</p>
<form method="post" action="/settings/token"><label>Instagram access token <span class="hint">— from developers.facebook.com → your app → API setup with Unified login → "Generate token". Starts with EAA (older apps: IG)</span></label>
<input type="password" name="token" placeholder="Paste token here" autocomplete="off"><p class="row"><button class="btn">Save and test</button></p></form>
${s.access_token ? `<form method="post" action="/settings/test" class="inline"><button class="btn sec">Run connection test again</button></form>` : ''}</div>
<div class="card"><h2>Pause switch</h2><p>${s.paused === '1' ? 'The bot is <b class="warn">paused</b>: it sends nothing.' : 'The bot is <b class="ok">on</b>.'}</p>
<form method="post" action="/settings/pause" class="inline"><input type="hidden" name="paused" value="${s.paused === '1' ? '0' : '1'}"><button class="btn ${s.paused === '1' ? '' : 'sec'}">${s.paused === '1' ? 'Resume bot' : 'Pause bot'}</button></form></div>
<div class="card"><form method="post" action="/logout" class="inline"><button class="btn sec">Sign out</button></form></div>`, { nav: '/settings', flash, flashErr });
}
