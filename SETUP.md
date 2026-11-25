# Set up GigaChat

The illustrated version of this guide, with screenshots, is at https://galvinbay.pages.dev/builds/gigachat.

Takes about 30 minutes. You never need to write code.

## 0. What you need
- An Instagram **professional** account (Creator or Business) that is **public**.
- A Facebook account (Meta's developer site logs in with it).
- A computer (Windows or Mac).
- [Claude Code](https://claude.com/claude-code) (needs a Claude subscription).
  - Using ChatGPT? OpenAI's [Codex](https://openai.com/codex/) should work too (not tested yet). Not the normal ChatGPT chat: the setup needs an AI that can run commands on your computer.

## 1. Instagram settings (2 minutes, on your phone)
1. Instagram → Settings → **Account type and tools** → switch to **Professional** if you haven't. Your account must be public.
2. Instagram → Settings → **Messages and story replies** → **Message controls** → **Connected tools** → turn **Allow access to messages** ON. Without this the bot can't send or read DMs.

## 2. Free Cloudflare account (3 minutes)
1. Go to https://dash.cloudflare.com/sign-up and make a free account. No card, no domain needed.
2. Verify your email.

## 3. Let Claude Code install the bot (10 minutes)
1. Make an empty folder, for example `gigachat` in your Documents.
2. Open Claude Code (or Codex) in that folder and paste:
   ```
   Set up GigaChat from github.com/gosubay/gigachat
   ```
3. Claude will ask you to log in to Cloudflare: a browser page opens, click **Allow**.
   - Afterwards the browser may say "localhost refused to connect". That's normal: the login already worked.
4. Claude creates the database, publishes the bot and gives you:
   - your bot's address, like `https://gigachat.YOUR-NAME.workers.dev`
   - your dashboard password (also saved in `DASHBOARD-PASSWORD.txt` in the folder).
   - A brand-new address can take about 5 minutes before it opens. Before that the browser shows a security/connection error.

## 4. Create your Meta app (15 minutes, the long part)
This gives you the key that lets your bot use your Instagram. You make your own app; nobody else's app touches your account.

1. Go to https://developers.facebook.com → log in with Facebook → **My Apps** → **Create App**.
   - First time: click **Get Started** to register as a developer. Meta may ask you to verify a phone number.
2. **App details:** app name, anything, e.g. "My GigaChat". Check the contact email → **Next**.
3. **Use cases:** on the left click **Business messaging**, tick **Manage messaging & content on Instagram** → **Next**.
4. **Business:** pick your own brand's business portfolio, or click **Create a business portfolio**. It does **not** need to be verified. (Don't pick "I don't want to connect a business portfolio yet": the key step below needs one.) → **Next**.
   - No business portfolio yet? Click **Create a business portfolio** at the bottom: brand or your own name (no special characters), first and last name, email → **Create portfolio**. Free, about 2 minutes, no registered business or verification needed. Then pick it → **Next**.
5. **Requirements** says "No requirements identified" → **Next** → **Overview** → **Create app**. You land on the app dashboard.
6. Click **Customize the Manage messaging & content on Instagram use case** → left menu → **API setup with Unified login**.
7. Add yourself as an Instagram tester:
   1. Left menu → **App roles** → **Roles** → **Instagram Testers** tab → **Add People** → type your Instagram username.
   2. Accept the invite: on a computer open https://www.instagram.com/accounts/manage_access/ → **Tester invites** → **Accept**.
8. Back on **API setup with Unified login**:
   1. Step 1 → **Create new configuration** → **Create from template** → choose **Instagram API (unified login)** (system-user access token, never expires). When it asks which assets to share, tick **only your Instagram account** (no ad accounts).
   2. Step 2 → **Add account** → log in to Instagram → allow the permissions.
   3. Click **Generate token** next to your account. Copy the token (it starts with `EAA`). Meta shows it only once; if you lose it, click Generate token again.
   - Skip the other steps on that page.
9. Keep this token private. Don't paste it into Claude or any chat.

You do **not** need App Review, Business Verification or to publish the app. Development mode works, including DMs to people who aren't on your app.

## 5. Connect and make your first campaign (3 minutes)
1. Open your bot's address and log in with your dashboard password.
2. **Settings** → paste the token → **Save and test**. All ticks should turn green.
3. **New campaign**:
   - Keyword, e.g. `GUIDE`
   - Which post (or any post)
   - The link to send
   - Follow required: on or off
4. Test it: from a second Instagram account, comment the keyword on that post. Within about 20 seconds you get a public reply and a DM.

If nothing happens, open **Debug log** in the dashboard. Or ask Claude Code in your gigachat folder: "check why GigaChat didn't reply".

## Updating later
Open Claude Code in your gigachat folder and say: "Update GigaChat". Claude pulls the new version, tests it and republishes.
