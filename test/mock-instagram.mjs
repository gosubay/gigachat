// Fake Instagram API for local testing. Behaves like graph.instagram.com
// (Instagram Login, IG... tokens) and, under the /fb prefix, like graph.facebook.com
// (Unified Login, EAA... system-user tokens, account id in the path) for the calls the bot makes, and enforces Meta's rules (one private reply per comment,
// follow-ups only after the person messaged, profile only after consent).
// Control endpoints under /_mock/* let tests add comments, replies and follows.
import http from 'node:http';

const VALID = new Set(['TEST_TOKEN', 'TOKEN2']); // Instagram Login tokens (graph.instagram.com)
const VALID_FB = new Set(['EAA_TEST']); // Unified Login system-user tokens (graph.facebook.com)
const igTime = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, '+0000');
let seq = 1000;
const nid = (p) => `${p}${++seq}`;

export function createState() {
  return {
    me: { id: 'APPSCOPED_ME', user_id: '17841400000000001', username: 'testcreator', name: 'Test Creator', account_type: 'BUSINESS' },
    media: [
      { id: 'M1', caption: 'I built a Video Analyzer with AI', timestamp: igTime(new Date(Date.now() - 3600e3)), comments_count: 0, permalink: 'https://instagram.com/p/M1' },
      { id: 'M2', caption: 'Poker book launch', timestamp: igTime(new Date(Date.now() - 7200e3)), comments_count: 0, permalink: 'https://instagram.com/p/M2' },
    ],
    comments: { M1: [], M2: [] },
    replies: [],
    users: {}, // igsid -> { username, follows }
    convs: {}, // convId -> { user, updated_time, messages: [] }
    privateReplied: new Set(),
    consent: new Set(),
    sent: [], // every DM the bot sent: { to, text, quick_replies, kind }
    calls: [],
    flags: { rejectQuickRepliesInPrivateReply: false, messagesIdsOnly: false, revokeTokens: false },
  };
}

let S = createState();

function userByName(name) {
  let entry = Object.entries(S.users).find(([, u]) => u.username === name);
  if (!entry) {
    const id = nid('IGSID_');
    S.users[id] = { username: name, follows: false };
    entry = [id, S.users[id]];
  }
  return entry[0];
}
function convFor(igsid) {
  let id = Object.keys(S.convs).find((k) => S.convs[k].user === igsid);
  if (!id) { id = nid('CONV_'); S.convs[id] = { user: igsid, updated_time: igTime(), messages: [] }; }
  return id;
}
function addMsg(igsid, fromMe, text) {
  const cid = convFor(igsid);
  const t = igTime(new Date(Date.now() + 1)); // strictly after anything the bot recorded
  const from = fromMe ? { id: S.me.user_id, username: S.me.username } : { id: igsid, username: S.users[igsid].username };
  const m = { id: nid('MSG_'), created_time: t, from, message: text };
  S.convs[cid].messages.unshift(m);
  S.convs[cid].updated_time = t;
  if (!fromMe) S.users[igsid].lastMsgAt = Date.now();
  return m;
}
const err = (res, status, code, message) => send(res, status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'mock' } });
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function handler() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // '/fb/...' stands for graph.facebook.com, everything else for graph.instagram.com.
    const fb = url.pathname.startsWith('/fb/');
    const p = fb ? url.pathname.slice(3) : url.pathname;
    const body = req.method === 'POST' ? await readBody(req) : {};

    // ---- control endpoints ----
    if (p === '/_mock/reset') { S = createState(); return send(res, 200, { ok: true }); }
    if (p === '/_mock/state') return send(res, 200, { ...S, privateReplied: [...S.privateReplied], consent: [...S.consent] });
    if (p === '/_mock/flags') { Object.assign(S.flags, body); return send(res, 200, S.flags); }
    if (p === '/_mock/comment') {
      const igsid = userByName(body.user);
      const c = { id: nid('C_'), text: body.text, timestamp: igTime(body.at ? new Date(body.at) : new Date()), from: { id: igsid, username: body.user }, username: body.user };
      S.comments[body.media].unshift(c);
      S.media.find((m) => m.id === body.media).comments_count++;
      return send(res, 200, c);
    }
    if (p === '/_mock/message') {
      const igsid = userByName(body.user);
      S.consent.add(igsid);
      return send(res, 200, addMsg(igsid, false, body.text));
    }
    if (p === '/_mock/follow') { S.users[userByName(body.user)].follows = body.follows !== false; return send(res, 200, { ok: true }); }

    // ---- fake Graph API ----
    S.calls.push(`${req.method} ${fb ? '/fb' : ''}${p}`);
    const auth = (req.headers.authorization || '').replace('Bearer ', '') || url.searchParams.get('access_token');
    if (p === '/refresh_access_token') {
      if (!VALID.has(url.searchParams.get('access_token'))) return err(res, 400, 190, 'Invalid OAuth access token');
      return send(res, 200, { access_token: 'TOKEN2', token_type: 'bearer', expires_in: 5184000 });
    }
    if (S.flags.revokeTokens) return err(res, 400, 190, 'Error validating access token: Session has expired');
    // Meta: each host only accepts its own kind of token.
    if (!(fb ? VALID_FB : VALID).has(auth)) return err(res, 400, 190, 'Invalid OAuth access token - Cannot parse access token');

    const parts = p.split('/').filter(Boolean); // ['v24.0', ...]
    if (!/^v\d+\.\d+$/.test(parts[0])) return err(res, 400, 2500, 'Unknown path components');
    const [, a, b] = parts;

    // On graph.facebook.com /me is the system user, not the Instagram account.
    if (fb && a === 'me') {
      if (req.method === 'GET' && !b) return send(res, 200, { id: 'SYSTEM_USER_1', name: 'GigaChat system user' });
      if (req.method === 'GET' && b === 'assigned_instagram_accounts') return send(res, 200, { data: [{ id: S.me.user_id, username: S.me.username }] });
      return err(res, 400, 100, `Tried accessing nonexisting field (${b}) on node type (User)`);
    }
    // "acct" = the Instagram account node: /me on graph.instagram.com, /{ig-user-id} on graph.facebook.com.
    const acct = fb ? a === S.me.user_id : a === 'me';

    if (req.method === 'GET' && a === 'me' && !b) return send(res, 200, S.me);
    if (req.method === 'GET' && acct && b === 'media') return send(res, 200, { data: S.media.slice(0, Number(url.searchParams.get('limit') || 25)) });
    if (req.method === 'GET' && acct && b === 'conversations') {
      if (url.searchParams.get('platform') !== 'instagram') return err(res, 400, 100, 'platform required');
      let list = Object.entries(S.convs).map(([id, c]) => ({ id, updated_time: c.updated_time, user: c.user }));
      const uid = url.searchParams.get('user_id');
      if (uid) list = list.filter((c) => c.user === uid);
      list.sort((x, y) => (x.updated_time < y.updated_time ? 1 : -1));
      return send(res, 200, { data: list.slice(0, Number(url.searchParams.get('limit') || 25)).map(({ id, updated_time }) => ({ id, updated_time })) });
    }
    if (req.method === 'POST' && acct && b === 'messages') {
      const r = body.recipient || {};
      const text = body.message?.text || '';
      if (r.comment_id) {
        const all = Object.values(S.comments).flat();
        const c = all.find((x) => x.id === r.comment_id);
        if (!c) return err(res, 400, 100, 'Invalid comment_id');
        if (S.privateReplied.has(c.id)) return err(res, 400, 10, 'This comment has already been replied to privately');
        if (body.message?.quick_replies && S.flags.rejectQuickRepliesInPrivateReply) return err(res, 400, 100, 'Param message[quick_replies] is not supported for private replies');
        S.privateReplied.add(c.id);
        const igsid = c.from.id;
        const m = addMsg(igsid, true, text);
        S.sent.push({ to: S.users[igsid].username, text, quick_replies: body.message.quick_replies || null, kind: 'private_reply' });
        return send(res, 200, { recipient_id: igsid, message_id: m.id });
      }
      if (r.id) {
        const u = S.users[r.id];
        if (!u) return err(res, 400, 100, 'No matching user found');
        if (!u.lastMsgAt || Date.now() - u.lastMsgAt > 24 * 3600e3) return err(res, 400, 10, 'This message is sent outside of allowed window.');
        const m = addMsg(r.id, true, text);
        S.sent.push({ to: u.username, text, quick_replies: body.message.quick_replies || null, kind: 'message' });
        return send(res, 200, { recipient_id: r.id, message_id: m.id });
      }
      return err(res, 400, 100, 'recipient required');
    }
    if (req.method === 'POST' && b === 'replies') {
      const all = Object.values(S.comments).flat();
      const c = all.find((x) => x.id === a);
      if (!c) return err(res, 400, 100, 'Invalid comment');
      const r = { id: nid('R_'), parent: a, text: body.message };
      S.replies.push(r);
      return send(res, 200, { id: r.id });
    }
    if (req.method === 'GET' && b === 'comments') {
      const list = S.comments[a];
      if (!list) return err(res, 400, 100, 'Unsupported get request');
      const after = Number(url.searchParams.get('after') || 0);
      const page = list.slice(after, after + 50);
      const paging = after + 50 < list.length ? { cursors: { after: String(after + 50) }, next: 'more' } : { cursors: {} };
      return send(res, 200, { data: page, paging });
    }
    if (req.method === 'GET' && a && !b) {
      const media = S.media.find((m) => m.id === a);
      if (media) return send(res, 200, media);
      if (S.convs[a]) {
        const msgs = S.convs[a].messages.slice(0, 20);
        return send(res, 200, { id: a, messages: { data: S.flags.messagesIdsOnly ? msgs.map(({ id, created_time }) => ({ id, created_time })) : msgs } });
      }
      for (const c of Object.values(S.convs)) {
        const m = c.messages.find((x) => x.id === a);
        if (m) return send(res, 200, m);
      }
      if (S.users[a]) {
        if (!S.consent.has(a)) return err(res, 400, 230, 'User consent is required to access user profile');
        return send(res, 200, { id: a, username: S.users[a].username, is_user_follow_business: !!S.users[a].follows });
      }
      return err(res, 400, 100, `Object with ID '${a}' does not exist`);
    }
    return err(res, 400, 2500, `Mock does not handle ${req.method} ${p}`);
  };
}

export function start(port = 8788) {
  const server = http.createServer(handler());
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('mock-instagram.mjs')) {
  start().then(() => console.log('Mock Instagram on http://127.0.0.1:8788'));
}
