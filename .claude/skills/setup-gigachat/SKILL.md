---
name: setup-gigachat
description: Install, publish or update the GigaChat Instagram comment-to-DM bot on the user's own Cloudflare account. Use when the user says "set up GigaChat", "install GigaChat", pastes the github.com/gosubay/gigachat link, or says "update GigaChat".
---

# Set up GigaChat

The user is probably not a developer. Do every technical step yourself; ask them only for things only they can do (log in, click Allow, Meta screens). Speak plainly, one short step at a time. The illustrated guide for the user is https://galvinbay.pages.dev/builds/gigachat (same steps as `SETUP.md`).

**Never ask for the Meta/Instagram token.** They paste it only into their dashboard. If they paste it in chat, tell them to generate a new one and paste that into the dashboard instead.

## 0. Before you start
Tell the user in 3 lines what will happen: you install the bot on their free Cloudflare account (10 min), then they create a Meta app (15 min) with the guide, then paste a key into their dashboard. Ask if they've done guide steps 1 (Instagram settings) and 2 (Cloudflare account). If not, give them those steps from `SETUP.md` first.

## 1. Get the code
1. Check `git --version` and `node --version` (needs Node 22.12 or newer). If Node is missing: Windows `winget install OpenJS.NodeJS.LTS`, Mac: install the LTS from https://nodejs.org. Then reopen the terminal.
2. If the current folder isn't already the repo: `git clone https://github.com/gosubay/gigachat.git` into the current folder (or a `gigachat` subfolder), then work inside it.
3. `npm install`, then `npm test`. All checks must pass (three suites). If they fail, stop and diagnose; don't publish broken code.

## 2. Cloudflare login
1. Warn first: "A browser page will open. Click **Allow**. After that it may say *localhost refused to connect*. That's normal, the login worked."
2. Run `npx wrangler login`. Then `npx wrangler whoami` to confirm.
3. If they have several Cloudflare accounts, ask which one and set `account_id` in `wrangler.jsonc`.

## 3. Database
1. `npx wrangler d1 create gigachat_db`. Copy the `database_id` it prints into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_DATABASE_ID`. Ignore the config snippet wrangler prints (its binding name is wrong for this project; the bot needs `DB`) and answer **no** if it offers to add it.
   - If it says the name already exists (a previous attempt), use `npx wrangler d1 list` to get that id.
2. `npm run db:remote` (creates the tables; answer yes if asked).

## 4. Time zone
Set `TIMEZONE` in `wrangler.jsonc` to the user's IANA time zone: `node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"`. Confirm it with them in plain words ("times will show in London time, right?").

## 5. Publish
1. `npm run deploy`. Note the `https://….workers.dev` address it prints.
   - If it asks to register a workers.dev subdomain, let the user pick a short name (it becomes part of their bot's address).
2. Dashboard password: generate a random 20-character password (letters and digits). Save it to `DASHBOARD-PASSWORD.txt` in the repo folder (gitignored). Set it: pipe it into `npx wrangler secret put ADMIN_PASSWORD` (don't echo it into a shared log).
3. Check the bot answers: fetch `<address>/login` until it returns 200 (a new address can take ~5 minutes for its security certificate; retry every 30 s, up to 10 min).
4. Confirm the cron runs: on a brand-new Worker the first run can take ~10 minutes (seen: 9). Then `npx wrangler d1 execute gigachat_db --remote --command "SELECT value FROM settings WHERE key = 'last_run'"` should show a recent run with status "not connected" (expected before the key is pasted).
5. Tell the user: their bot address, their password (and that it's in `DASHBOARD-PASSWORD.txt`), and that it's running but not connected to Instagram yet.

## 6. Meta app (the user does this)
Walk them through guide step 4 (`SETUP.md` section 4, or the illustrated guide) one sub-step at a time. Wait for them after each. Common snags:
- "Select a configuration in Step 1 before generating an access token" → they skipped Step 1; do Create new configuration → Create from template.
- Can't add the Instagram account → the tester invite isn't accepted yet (instagram.com/accounts/manage_access/ → Tester invites).
- Token doesn't start with `EAA` or `IG` → they copied something else.
They paste the token into **their dashboard → Settings → Save and test**, never into chat.

## 7. Check the connection yourself
`npx wrangler d1 execute gigachat_db --remote --command "SELECT key, value FROM settings WHERE key IN ('ig_username','token_status','last_run')"` (never select `access_token`). Then the log: `npx wrangler d1 execute gigachat_db --remote --command "SELECT ts, level, event, detail FROM logs ORDER BY id DESC LIMIT 20"`. Explain any error in plain words and how to fix it.

## 8. First campaign and test
Tell them: dashboard → **New campaign** → keyword, post (or any post), link, follow required on/off. Then comment the keyword from a **second** Instagram account. A public reply and DM should arrive within ~20 seconds. If not, read the log (step 7) before asking them anything.

## Updating ("update GigaChat")
1. `git stash` if `wrangler.jsonc` has local edits, `git pull`, `git stash pop` (keep their database id, account id and TIMEZONE).
2. `npm install`, `npm test` (must pass), `npm run db:remote`, `npm run deploy`.
3. Check `last_run` updates within 2 minutes. Tell them what changed in one or two plain lines (from `git log`).
