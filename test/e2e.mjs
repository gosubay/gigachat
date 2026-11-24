// End-to-end test: real Worker code (wrangler dev, local database) talking to
// the fake Instagram. Run with: npm test
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import { start as startMock } from './mock-instagram.mjs';

const BOT = 'http://127.0.0.1:8787';
const MOCK = 'http://127.0.0.1:8788';
const STATE_DIR = '.wrangler/e2e-state';
const PASSWORD = 'local-test-password';
const BURST = process.argv.includes('--burst'); // small call budget: proves leftover work carries over
const FB = process.argv.includes('--fb'); // Unified Login: EAA token, graph.facebook.com
const TOKEN = FB ? 'EAA_TEST' : 'TEST_TOKEN';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`, extra !== undefined ? JSON.stringify(extra, null, 1).slice(0, 800) : ''); }
}

const mock = async (path, body) => (await fetch(MOCK + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
let cookie = '';
async function bot(path, form) {
  const res = await fetch(BOT + path, {
    method: form ? 'POST' : 'GET', redirect: 'manual',
    headers: { Cookie: cookie, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}
const runCheck = () => bot('/run-now', {});
const sentTo = async (user) => (await mock('/_mock/state')).sent.filter((s) => s.to === user);

async function burst() {
  console.log('Burst: 12 comments, only 8 Instagram calls and 28 database queries allowed per run');
  await bot('/login', { password: PASSWORD });
  await bot('/settings/token', { token: TOKEN });
  await bot('/campaigns', { name: 'B', keywords: 'ai', comment_replies: 'Sent!', dm_text: 'Hi', button_text: 'Link', require_follow: '1', not_following_text: 'Follow', link_text: '{link}', link_url: 'https://example.com/b', active: '1' });
  await sleep(1100);
  const users = Array.from({ length: 12 }, (_, i) => `user${i}`);
  for (const u of users) await mock('/_mock/comment', { media: 'M1', user: u, text: 'AI' });
  let runs = 0;
  for (; runs < 15; runs++) {
    await runCheck();
    const st = await mock('/_mock/state');
    if (new Set(st.sent.map((x) => x.to)).size === 12 && st.replies.length === 12) break;
  }
  const st = await mock('/_mock/state');
  check(`all 12 got exactly one DM (took ${runs + 1} runs)`, st.sent.length === 12 && new Set(st.sent.map((x) => x.to)).size === 12, st.sent.length);
  check('all 12 got a public reply', st.replies.length === 12, st.replies.length);
  const r = await bot('/log');
  check('log notes the budget was used up', r.text.includes('budget_used'));
}

async function main() {
  // Fresh local database every run.
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  execSync(`npx wrangler d1 migrations apply gigachat_db --local --persist-to ${STATE_DIR}`, { stdio: 'pipe' });

  const mockServer = await startMock(8788);
  const dev = spawn('npx', ['wrangler', 'dev', '--port', '8787', '--ip', '127.0.0.1', '--persist-to', STATE_DIR, '--test-scheduled', '--var', `IG_API_BASE:${MOCK}`, '--var', `FB_API_BASE:${MOCK}/fb`, '--var', `ADMIN_PASSWORD:${PASSWORD}`, '--var', 'PASS_SECONDS:0,2', ...(BURST ? ['--var', 'CALL_BUDGET:8', '--var', 'DB_QUERY_BUDGET:28'] : [])], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let devLog = '';
  dev.stdout.on('data', (d) => (devLog += d));
  dev.stderr.on('data', (d) => (devLog += d));
  const stop = () => { try { execSync(`taskkill /pid ${dev.pid} /T /F`, { stdio: 'ignore' }); } catch {} mockServer.close(); };

  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BOT + '/health')).ok) break; } catch {} await sleep(500); }

    if (BURST) { await burst(); return; }
    if (FB) console.log('(Unified Login mode: EAA token, graph.facebook.com)');
    console.log('Login');
    check('dashboard asks for login', (await bot('/')).location === '/login');
    check('wrong password refused', (await bot('/login', { password: 'nope' })).status === 401);
    check('right password accepted', (await bot('/login', { password: PASSWORD })).location === '/');

    console.log('Connect Instagram');
    let r = await bot('/settings/token', { token: 'BAD' });
    check('bad token is not saved', r.status === 400 && r.text.includes('NOT saved'));
    const callsBeforeConnect = (await mock('/_mock/state')).calls.length; // the 'BAD' token call above goes to graph.instagram.com, correctly
    r = await bot('/settings/token', { token: TOKEN });
    check('good token connects as @testcreator', r.text.includes('Connected as @testcreator'), r.text.slice(0, 300));
    check('connection test shows ticks', (r.text.match(/✔/g) || []).length >= 3);

    // A comment from before the campaign existed must be ignored.
    await mock('/_mock/comment', { media: 'M1', user: 'early_bird', text: 'AI pls', at: Date.now() - 120000 });

    console.log('Create campaigns');
    r = await bot('/campaigns/new');
    check('post picker lists Instagram posts', r.text.includes('Video Analyzer') && r.text.includes('Poker book'));
    r = await bot('/campaigns', {
      name: 'Analyzer', keywords: 'AI, analyzer', media_id: '', comment_replies: 'Sent! Check your DMs', dm_text: 'Hey {name}! Tap below',
      button_text: 'Send me the link', require_follow: '1', not_following_text: 'Follow me first, then tap again', link_text: 'Here: {link}', link_url: 'https://example.com/analyzer', active: '1',
    });
    check('campaign 1 saved', r.location?.startsWith('/campaigns/1'), r);
    r = await bot('/campaigns', {
      name: 'Poker', keywords: 'poker', media_id: 'M2', comment_replies: '', dm_text: 'unused', button_text: 'x',
      not_following_text: 'x', link_text: 'Book', link_url: 'https://example.com/poker', active: '1',
    });
    check('campaign 2 (one post, no follow gate) saved', r.location?.startsWith('/campaigns/2'), r);
    await sleep(1100);

    console.log('Comments arrive');
    await mock('/_mock/comment', { media: 'M1', user: 'alice', text: 'AI please!' });
    await mock('/_mock/comment', { media: 'M1', user: 'bob', text: 'nice video, said again' });
    await mock('/_mock/comment', { media: 'M1', user: 'carol', text: 'i want the ai' });
    await mock('/_mock/comment', { media: 'M1', user: 'testcreator', text: 'AI (my own comment)' });
    await mock('/_mock/comment', { media: 'M1', user: 'mike', text: 'MAIL me' }); // "ai" inside a word: no match
    await mock('/_mock/comment', { media: 'M2', user: 'dave', text: 'POKER' });
    await mock('/_mock/comment', { media: 'M1', user: 'frank', text: 'poker' }); // poker campaign is only for M2

    // First run via the real cron path.
    // (Tests use 2 checks per cron run, at 0s and 2s; live uses 0s, 20s, 40s.)
    const sch = await fetch(BOT + '/__scheduled?cron=*+*+*+*+*');
    check('cron trigger runs', sch.ok);
    const until = async (cond, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(150); } return false; };
    await until(async () => (await mock('/_mock/state')).sent.length >= 3);
    let st = await mock('/_mock/state');
    const dmd = [...new Set(st.sent.map((s) => s.to))].sort();
    check('DMs went to alice, carol, dave only', JSON.stringify(dmd) === JSON.stringify(['alice', 'carol', 'dave']), dmd);
    check('alice DM has the button + her name', st.sent.find((s) => s.to === 'alice')?.quick_replies?.[0]?.title === 'Send me the link' && st.sent.find((s) => s.to === 'alice').text.includes('@alice'));
    check('dave (no follow gate) gets the link straight away', st.sent.find((s) => s.to === 'dave')?.text.includes('https://example.com/poker'));
    check('public replies under alice + carol only (dave campaign has none)', st.replies.length === 2, st.replies);

    console.log('Second check in the same minute');
    await mock('/_mock/comment', { media: 'M2', user: 'ivy', text: 'poker pls' });
    const caught = await until(async () => (await sentTo('ivy')).length === 1);
    check('a comment made after the first check is answered by the second one, same cron run', caught);
    const lastRun = async () => JSON.parse(JSON.parse((await bot('/debug.json')).text).settings.last_run || '{}');
    await until(async () => (await lastRun()).passes === 2);
    const lr = await lastRun();
    check('cron run did 2 checks and stayed within the 50 database queries', lr.passes === 2 && lr.dbQueries > 0 && lr.dbQueries <= 50, lr);
    check('first DMs and reply check ran side by side', lr.steps?.check1?.comments >= 0 && lr.steps?.check1?.replies >= 0, lr.steps);

    console.log('No duplicates');
    await runCheck();
    st = await mock('/_mock/state');
    check('second run sends nothing new', st.sent.length === 4, st.sent.length);

    console.log('Follow gate');
    await mock('/_mock/message', { user: 'alice', text: 'Send me the link' });
    await runCheck();
    let a = await sentTo('alice');
    check('alice not following -> told to follow, with button again', a.length === 2 && a[1].text.includes('Follow me first') && a[1].quick_replies, a);
    await mock('/_mock/follow', { user: 'alice' });
    await sleep(1100);
    await mock('/_mock/message', { user: 'alice', text: 'Send me the link' });
    await runCheck();
    a = await sentTo('alice');
    check('alice follows -> gets the link', a.length === 3 && a[2].text.includes('https://example.com/analyzer'), a);

    await mock('/_mock/follow', { user: 'carol' });
    await mock('/_mock/message', { user: 'carol', text: 'hi!' });
    await runCheck();
    const c = await sentTo('carol');
    check('carol (already follows, typed instead of tapping) gets the link', c.length === 2 && c[1].text.includes('analyzer'), c);

    await runCheck();
    check('no repeat link on next run', (await mock('/_mock/state')).sent.length === 7);

    console.log('Fallbacks Meta might force on us');
    await mock('/_mock/flags', { rejectQuickRepliesInPrivateReply: true, messagesIdsOnly: true });
    await mock('/_mock/comment', { media: 'M1', user: 'erin', text: 'Analyzer' });
    await runCheck();
    let e = await sentTo('erin');
    check('button refused -> plain-text DM with "reply" hint', e.length === 1 && !e[0].quick_replies && e[0].text.includes('Reply with any message'), e);
    await mock('/_mock/follow', { user: 'erin' });
    await mock('/_mock/message', { user: 'erin', text: 'link pls' });
    await runCheck();
    e = await sentTo('erin');
    check('reply read even when Meta returns message ids only', e.length === 2 && e[1].text.includes('analyzer'), e);

    console.log('Dashboard');
    r = await bot('/campaigns/1');
    check('campaign page shows 3 links delivered', /<div class="n">3<\/div><div class="l">Links delivered/.test(r.text));
    check('campaign page shows 1 new follower (alice)', /<div class="n">1<\/div><div class="l">New followers/.test(r.text));
    r = await bot('/log');
    check('debug log records DMs and links', r.text.includes('dm_sent') && r.text.includes('link_delivered') && r.text.includes('dm_failed'));
    r = await bot('/settings/pause', { paused: '1' });
    await mock('/_mock/comment', { media: 'M1', user: 'gina', text: 'ai' });
    await runCheck();
    check('paused bot sends nothing', (await sentTo('gina')).length === 0);
    await bot('/settings/pause', { paused: '0' });
    await runCheck();
    check('resumed bot catches up', (await sentTo('gina')).length === 1);

    if (FB) {
      const calls = (await mock('/_mock/state')).calls.slice(callsBeforeConnect);
      check('Unified Login: every call went to graph.facebook.com', calls.length > 0 && calls.every((x) => x.includes(' /fb/')), calls.filter((x) => !x.includes(' /fb/')));
    }

    console.log('Token expiry');
    await mock('/_mock/flags', { revokeTokens: true });
    await mock('/_mock/comment', { media: 'M1', user: 'hank', text: 'ai' });
    await runCheck();
    r = await bot('/');
    check('home page warns token was rejected', r.text.includes('Instagram rejected the token'));
    const dbg = JSON.parse((await bot('/debug.json')).text);
    check('debug.json works and hides the token', !('access_token' in dbg.settings) && dbg.logs.some((l) => l.event === 'token_rejected'));
  } catch (err) {
    failed++;
    console.error('TEST CRASHED', err);
  } finally {
    stop();
    fs.writeFileSync('.wrangler/e2e-dev.log', devLog);
    console.log(`\n${passed} passed, ${failed} failed${failed ? ' (worker log: .wrangler/e2e-dev.log)' : ''}`);
    process.exit(failed ? 1 : 0);
  }
}

main();
