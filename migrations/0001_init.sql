-- Key/value settings: access token, account id, pause switch, last run info.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per "keyword -> post -> link" rule.
CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL,              -- comma separated, matched case-insensitively as whole words
  media_id TEXT,                       -- NULL = any post from the last 7 days
  media_label TEXT,
  comment_replies TEXT NOT NULL DEFAULT '', -- one per line, one picked at random; empty = no public reply
  dm_text TEXT NOT NULL,               -- first DM (private reply)
  button_text TEXT NOT NULL DEFAULT 'Send me the link',
  require_follow INTEGER NOT NULL DEFAULT 1,
  not_following_text TEXT NOT NULL,
  link_text TEXT NOT NULL,             -- message that carries the link; {link} is replaced
  link_url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per matching comment the bot acted on.
CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  comment_id TEXT NOT NULL UNIQUE,     -- guarantees one DM per comment
  media_id TEXT NOT NULL,
  commenter_id TEXT,                   -- IGSID
  commenter_username TEXT,
  comment_text TEXT,
  commented_at TEXT,
  status TEXT NOT NULL DEFAULT 'new',  -- new | waiting_tap | delivered | dm_failed | expired
  public_reply TEXT,                   -- sent | failed | off
  dm_mode TEXT,                        -- button | text
  conv_id TEXT,
  conv_seen_at TEXT,                   -- conversation updated_time we last looked at
  last_handled_msg_at TEXT,            -- created_time of the newest user message we've answered
  taps INTEGER NOT NULL DEFAULT 0,
  follow_fails INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dm_sent_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_campaign ON leads(campaign_id);

-- Comment count we last saw per post, so we only re-read posts that got new comments.
CREATE TABLE media_seen (
  media_id TEXT PRIMARY KEY,
  comments_count INTEGER NOT NULL DEFAULT 0,
  newest_comment_at TEXT,
  checked_at TEXT
);

-- Debug log (newest 5,000 kept).
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  level TEXT NOT NULL,                 -- info | warn | error
  event TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX idx_logs_ts ON logs(ts);
