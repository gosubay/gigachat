# Instructions for AI assistants (Claude Code, Codex, Cursor, …)

GigaChat is an Instagram comment-to-DM bot: a Cloudflare Worker (plain JavaScript, no build step) + D1 database + a cron trigger every minute. The person you're helping is probably **not a developer**: use plain language, give numbered steps for anything they must click, and do everything you can yourself.

## If they asked you to set up (or update) GigaChat
Follow `.claude/skills/setup-gigachat/SKILL.md` step by step. (Claude Code also offers it as the `setup-gigachat` skill.)

## Hard rules
- **Never ask for, accept or store the Instagram/Meta token in chat or in files.** The person pastes it only into their own dashboard (Settings page). If they paste it in chat anyway, tell them to generate a new one in Meta and paste that into the dashboard.
- Never commit secrets. `DASHBOARD-PASSWORD.txt`, `.dev.vars` and `.wrangler/` are gitignored; keep it that way.
- Never weaken: one DM per comment (`leads.comment_id` is UNIQUE), only answering comments made after the campaign was created, the 45 outside calls per run cap (Cloudflare free plan allows 50), the 50 database queries per run cap.
- Run `npm test` after every code change. Never publish (`npm run deploy`) with a failing test.

## Map of the code
- `src/index.js` — routes (dashboard) + cron entry
- `src/engine.js` — the bot: find keyword comments → first DM + public reply → read replies → follow check → link
- `src/instagram.js` — Meta API client. `EAA…` keys use graph.facebook.com with the Instagram account id in the path; `IG…` keys use graph.instagram.com.
- `src/dashboard.js` — HTML pages · `src/auth.js` — password login · `src/db.js` — database helpers
- `migrations/` — database tables · `test/` — fake Instagram + full end-to-end test
- `wrangler.jsonc` — Cloudflare config: database id, `TIMEZONE` for dashboard times, `PASS_SECONDS` (checks per minute: `0,20,40`)

## Diagnosing problems (do this before asking the person anything)
- Recent log: `npx wrangler d1 execute gigachat_db --remote --command "SELECT ts, level, event, detail FROM logs ORDER BY id DESC LIMIT 30"`
- Last run summary: `npx wrangler d1 execute gigachat_db --remote --command "SELECT value FROM settings WHERE key = 'last_run'"`
- Leads: `npx wrangler d1 execute gigachat_db --remote --command "SELECT id, commenter_username, status, last_error, commented_at, dm_sent_at FROM leads ORDER BY id DESC LIMIT 20"`
- Live tail: `npx wrangler tail`
- Never print the `access_token` setting.
- If Meta behaves differently from the fake Instagram in `test/mock-instagram.mjs`, change the mock to match Meta first, watch the test fail, then fix the bot.
