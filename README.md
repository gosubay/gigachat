# GigaChat

A free Instagram comment-to-DM bot that you host yourself on Cloudflare's free plan.

Someone comments a keyword on your post → GigaChat replies under the comment and DMs them → (optional) they follow you → they get your link.

- **Free:** runs on Cloudflare's free plan. No monthly fee, no card.
- **Yours:** your own Meta app, your own hosting, your own data. Nobody else connects to your account.
- **Fast enough:** checks for new comments every 20 seconds. No Meta App Review needed.

## Set it up

You don't need to code. Install [Claude Code](https://claude.com/claude-code), open it in an empty folder, and paste (OpenAI's Codex should work too, not tested yet):

```
Set up GigaChat from github.com/gosubay/gigachat
```

Claude downloads the code, creates your database, publishes your bot and gives you your dashboard password. You then create a Meta app (about 15 minutes, step by step in [SETUP.md](SETUP.md)) and paste its key into your dashboard.

> **AI assistants:** read [AGENTS.md](AGENTS.md) and follow it.

## What it does
- Keyword comments (whole word, any case) on one post or on any post.
- A random public reply under the comment ("Sent! Check your DMs").
- A first DM with a button. Optional follow gate: the link only goes to people who follow you; others get "follow me first" and the button again.
- A dashboard (phone and desktop) to add campaigns, see stats (comments, DMs, taps, new followers, links sent) and a debug log.

## Limits to know
- Instagram professional accounts only (Creator or Business).
- Only comments made after a campaign is created get answered. Each comment gets one DM, ever.
- Meta allows the first DM only within 7 days of the comment, and follow-ups within 24 hours of the person's last message.

## For developers
- Cloudflare Worker (plain JavaScript, no build step) + D1 database + a cron trigger every minute.
- `npm install` then `npm test` runs the whole flow locally against a fake Instagram.

License: MIT
