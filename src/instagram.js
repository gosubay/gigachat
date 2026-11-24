// Instagram API client. Works with both kinds of Meta key:
//  - IG... token (Instagram Login): graph.instagram.com, the account is "/me".
//  - EAA... token (Unified Login system-user token, forced on new Meta apps since 2026):
//    graph.facebook.com, "/me" is the system user, so the Instagram account id goes in the path.
// Every call counts against a per-run budget so we never pass Cloudflare's
// free-plan limit of 50 outside calls per run.

export class BudgetExceeded extends Error {
  constructor() {
    super('Call budget for this run used up');
    this.name = 'BudgetExceeded';
  }
}

export class IgError extends Error {
  constructor(status, body, path) {
    const err = (body && body.error) || {};
    super(err.message || `HTTP ${status}`);
    this.name = 'IgError';
    this.status = status;
    this.code = err.code;
    this.subcode = err.error_subcode;
    this.type = err.type;
    this.path = path;
    this.body = body;
  }
  get tokenProblem() {
    return this.code === 190 || this.status === 401;
  }
  get rateLimited() {
    return [4, 17, 32, 613].includes(this.code) || this.status === 429;
  }
  summary() {
    return { path: this.path, status: this.status, code: this.code, subcode: this.subcode, message: this.message };
  }
}

export class Instagram {
  constructor(env, token, budget, igId) {
    this.fb = /^EAA/.test(token || '');
    this.base = `${this.fb ? env.FB_API_BASE || 'https://graph.facebook.com' : env.IG_API_BASE || 'https://graph.instagram.com'}`.replace(/\/$/, '');
    this.igId = igId || null; // Instagram account id; needed in paths for EAA tokens
    this.version = env.IG_API_VERSION || 'v24.0';
    this.token = token;
    this.budget = budget ?? Number(env.CALL_BUDGET || 45);
    this.calls = 0;
    this.ms = 0; // time spent waiting on Meta (debug)
    this.trace = []; // [call, ms] per call (debug)
  }

  remaining() {
    return this.budget - this.calls;
  }

  async request(method, path, { query = {}, body, versioned = true } = {}) {
    if (this.calls >= this.budget) throw new BudgetExceeded();
    this.calls++;
    const url = new URL(`${this.base}${versioned ? '/' + this.version : ''}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const init = { method, headers: { Authorization: `Bearer ${this.token}` } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const t0 = Date.now();
    let res, text;
    try { res = await fetch(url.toString(), init); text = await res.text(); }
    finally { const d = Date.now() - t0; this.ms += d; if (this.trace.length < 40) this.trace.push(`${method} ${path.replace(/\/\d{6,}/g, '/:id')} ${d}`); }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    if (!res.ok || (data && data.error)) throw new IgError(res.status, data, `${method} ${path}`);
    return data;
  }

  async me() {
    if (!this.fb) return this.request('GET', '/me', { query: { fields: 'user_id,username,name,account_type' } });
    const r = await this.request('GET', '/me/assigned_instagram_accounts', { query: { fields: 'id,username' } });
    const a = (r && r.data || [])[0];
    if (!a) {
      throw new IgError(400, { error: { message: 'No Instagram account is shared with this key. Generate the token again and tick your Instagram account.', code: 'no_account' } }, 'GET /me/assigned_instagram_accounts');
    }
    this.igId = a.id;
    return { id: a.id, user_id: a.id, username: a.username, account_type: 'professional, unified login', accounts: (r.data || []).length };
  }

  // Path of the Instagram account node.
  async acct() {
    if (!this.fb) return '/me';
    if (!this.igId) await this.me();
    return `/${this.igId}`;
  }

  async recentMedia(limit = 25, fields = 'id,caption,permalink,timestamp,media_type,media_product_type,comments_count,thumbnail_url,media_url') {
    return this.request('GET', `${await this.acct()}/media`, {
      query: { fields, limit },
    });
  }

  media(id) {
    return this.request('GET', `/${id}`, { query: { fields: 'id,caption,permalink,timestamp,comments_count' } });
  }

  comments(mediaId, after) {
    return this.request('GET', `/${mediaId}/comments`, {
      query: { fields: 'id,text,timestamp,from{id,username},username,parent_id', limit: 50, after },
    });
  }

  replyToComment(commentId, message) {
    return this.request('POST', `/${commentId}/replies`, { body: { message } });
  }

  // First DM, tied to a comment. Allowed once, within 7 days of the comment.
  async privateReply(commentId, message) {
    return this.request('POST', `${await this.acct()}/messages`, { body: { recipient: { comment_id: commentId }, message } });
  }

  // Follow-up DM. Allowed within 24h of the person's last message.
  async sendMessage(igsid, message) {
    return this.request('POST', `${await this.acct()}/messages`, { body: { recipient: { id: igsid }, message } });
  }

  async conversations(limit = 50) {
    return this.request('GET', `${await this.acct()}/conversations`, { query: { platform: 'instagram', fields: 'id,updated_time', limit } });
  }

  async conversationWith(igsid) {
    return this.request('GET', `${await this.acct()}/conversations`, { query: { platform: 'instagram', user_id: igsid, fields: 'id,updated_time' } });
  }

  // Tries to get the newest messages with sender + text in one call.
  conversationMessages(convId) {
    return this.request('GET', `/${convId}`, { query: { fields: 'messages.limit(10){id,created_time,from,message}' } });
  }

  message(messageId) {
    return this.request('GET', `/${messageId}`, { query: { fields: 'id,created_time,from,message' } });
  }

  userProfile(igsid) {
    return this.request('GET', `/${igsid}`, { query: { fields: 'username,is_user_follow_business' } });
  }

  // Only IG tokens expire (60 days). EAA system-user tokens are set to never expire.
  async refreshToken() {
    if (this.fb) return null;
    return this.request('GET', '/refresh_access_token', {
      query: { grant_type: 'ig_refresh_token', access_token: this.token },
      versioned: false,
    });
  }
}
