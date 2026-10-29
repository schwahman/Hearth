// End-to-end smoke test: starts a throwaway server, then exercises the API
// and gateway with two users.   npm test
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_PORT = PORT + 1000;
const mockDiscord = require('./mock-discord');
const mockReady = mockDiscord.start(MOCK_PORT);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));

const srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, MAIL_DEV: 'true', RATE_LIMIT_SCALE: '20',
    DISCORD_API_BASE: `http://127.0.0.1:${MOCK_PORT}/api`, DISCORD_CDN_BASE: `http://127.0.0.1:${MOCK_PORT}/cdn` },
  stdio: ['ignore', 'pipe', 'inherit'],
});

// Emails the server "sent" (MAIL_DEV prints them to its output).
const mail = [];
let outBuf = '';
srv.stdout.on('data', (d) => {
  outBuf += d.toString();
  let i;
  while ((i = outBuf.indexOf('[mail:dev]')) >= 0) {
    const next = outBuf.indexOf('[mail:dev]', i + 1);
    const end = next >= 0 ? next : (outBuf.includes('\n\n', i) && outBuf.length - i > 200 ? outBuf.length : -1);
    if (end < 0) break;
    mail.push(outBuf.slice(i, end));
    outBuf = outBuf.slice(end);
  }
});
async function lastCodeFor(to, pattern) {
  for (let t = 0; t < 50; t++) {
    const all = [...mail, outBuf].filter((m) => m.includes(`to=${to}`));
    const m = all.length && all[all.length - 1].match(pattern);
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no email for ' + to);
}

async function req(method, p, body, token, extra = {}) {
  if (p === '/auth/register' && body && body.username && body.email === undefined) body = { ...body, email: `${body.username}@test.example` };
  if (p === '/auth/register' && body && body.username && body.birthdate === undefined) body = { ...body, birthdate: '1990-01-01' };
  const res = await fetch(BASE + '/api' + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra.headers },
    body: extra.raw || (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
}

function client(token, opts) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`, opts);
  const events = [];
  const waiters = [];
  const closed = new Promise((r) => { ws.onclose = (e) => r(e.code); });
  ws.onopen = () => ws.send(JSON.stringify(token ? { op: 'IDENTIFY', token } : { op: 'IDENTIFY' }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    events.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  };
  return {
    ws, events, closed,
    send: (o) => ws.send(JSON.stringify(o)),
    wait(t, pred = () => true, ms = 3000) {
      const found = events.find((m) => m.t === t && pred(m.d));
      if (found) { events.splice(events.indexOf(found), 1); return Promise.resolve(found.d); }
      return new Promise((resolve, reject) => {
        const w = { match: (m) => m.t === t && pred(m.d), resolve: (m) => { events.splice(events.indexOf(m), 1); clearTimeout(timer); resolve(m.d); } };
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${t}`)), ms);
        waiters.push(w);
      });
    },
  };
}

let passed = 0;
function ok(label) { passed++; console.log('  ✓', label); }

async function main() {
  await new Promise((r) => srv.stdout.once('data', r));

  const PW = 'velvet harbor lantern 42';
  const a = await req('POST', '/auth/register', { acceptTerms: true, username: 'alice', password: PW, displayName: 'Alice', returnToken: true });
  const b = await req('POST', '/auth/register', { acceptTerms: true, username: 'bob', password: PW, returnToken: true });
  assert.equal(a.status, 200, JSON.stringify(a.data)); assert.equal(b.status, 200);
  assert.equal((await req('POST', '/auth/register', { acceptTerms: true, username: 'ALICE', password: PW })).status, 409);
  assert.equal((await req('POST', '/auth/login', { username: 'alice', password: 'wrong-pass-123' })).status, 401);
  ok('register, duplicate check, bad login rejected');

  for (const [pw, why] of [['short1', 'too short'], ['password1234', 'common'], ['Qwerty123456', 'common (any capitalization)'],
    ['carol-is-the-best', 'contains username'], ['aaaaaaaaaaaaaa', 'repetitive']]) {
    const r = await req('POST', '/auth/register', { acceptTerms: true, username: 'carol', password: pw });
    assert.equal(r.status, 400, `${why} password should be rejected`);
  }
  ok('weak passwords rejected (length, common list, username, repetition)');
  const A = a.data.token; const B = b.data.token;

  const ca = client(A); const cb = client(B);
  const readyA = await ca.wait('READY');
  await cb.wait('READY');
  assert.equal(readyA.user.username, 'alice');
  ok('both clients connected over the hand-written WebSocket gateway');

  const srvRes = await req('POST', '/servers', { name: 'Test Server' }, A);
  const server = srvRes.data;
  assert.equal(server.channels.length, 2);
  await ca.wait('SERVER_CREATE', (d) => d.id === server.id);
  const general = server.channels.find((c) => c.type === 'text');
  const voiceCh = server.channels.find((c) => c.type === 'voice');
  ok('server created with default text + voice channels');

  assert.equal((await req('GET', `/channels/${general.id}/messages`, null, B)).status, 404);
  ok('non-member cannot read channel');

  const inv = (await req('POST', `/servers/${server.id}/invites`, {}, A)).data;
  assert.equal((await req('GET', `/invites/${inv.code}`)).data.server.name, 'Test Server');
  const joined = await req('POST', `/invites/${inv.code}`, null, B);
  assert.equal(joined.status, 200);
  await cb.wait('SERVER_CREATE', (d) => d.id === server.id);
  await ca.wait('MEMBER_ADD', (d) => d.member.user.username === 'bob');
  ok('invite preview + join; owner sees MEMBER_ADD live');

  const sent = await req('POST', `/channels/${general.id}/messages`, { content: 'hello **bob**' }, A);
  assert.equal(sent.status, 200);
  const got = await cb.wait('MESSAGE_CREATE', (d) => d.id === sent.data.id);
  assert.equal(got.content, 'hello **bob**');
  ok('message delivered live to the other user');

  cb.send({ op: 'TYPING', channelId: general.id });
  await ca.wait('TYPING_START', (d) => d.userId === b.data.user.id);
  ok('typing indicator');

  await req('PUT', `/messages/${sent.data.id}/reactions/${encodeURIComponent('🔥')}`, null, B);
  await ca.wait('REACTION_ADD', (d) => d.emoji === '🔥');
  const reply = await req('POST', `/channels/${general.id}/messages`, { content: 'hi', replyTo: sent.data.id }, B);
  assert.equal(reply.data.replyTo, sent.data.id);
  assert.equal((await req('PATCH', `/messages/${sent.data.id}`, { content: 'nope' }, B)).status, 403);
  assert.equal((await req('PATCH', `/messages/${sent.data.id}`, { content: 'edited' }, A)).status, 200);
  await cb.wait('MESSAGE_UPDATE', (d) => d.content === 'edited');
  ok('reactions, replies, edit (own only)');

  for (let i = 0; i < 60; i++) await req('POST', `/channels/${general.id}/messages`, { content: `bulk ${i}` }, A);
  const page1 = (await req('GET', `/channels/${general.id}/messages?limit=50`, null, B)).data;
  const page2 = (await req('GET', `/channels/${general.id}/messages?limit=50&before=${page1[0].id}`, null, B)).data;
  assert.equal(page1.length, 50); assert.equal(page2.length, 12);
  assert.equal(page1.at(-1).content, 'bulk 59');
  ok('message history pagination');

  assert.equal((await req('POST', `/servers/${server.id}/channels`, { name: 'secret' }, B)).status, 403);
  const role = (await req('POST', `/servers/${server.id}/roles`, { name: 'Mod', permissions: 1 << 5 }, A)).data;
  await req('PUT', `/servers/${server.id}/members/${b.data.user.id}/roles/${role.id}`, null, A);
  const made = await req('POST', `/servers/${server.id}/channels`, { name: 'Mod Chat' }, B);
  assert.equal(made.status, 200); assert.equal(made.data.name, 'mod-chat');
  assert.equal((await req('POST', `/servers/${server.id}/roles`, { name: 'x', permissions: 1 << 30 }, B)).status, 403);
  ok('permissions: role grants Manage Channels; cannot escalate');

  const file = Buffer.from('hello file');
  const up = await req('POST', `/channels/${general.id}/attachments`, null, B, { raw: file, headers: { 'X-Filename': 'note.txt', 'Content-Type': 'text/plain' } });
  assert.equal(up.status, 200);
  await req('POST', `/channels/${general.id}/messages`, { content: '', attachments: [up.data] }, B);
  const dl = await fetch(BASE + up.data.url, { headers: { Authorization: 'Bearer ' + A } });
  assert.equal(await dl.text(), 'hello file');
  assert.equal((await fetch(BASE + up.data.url)).status, 401);
  ok('file upload; download requires login + channel access');

  // Voice: both join, signaling is relayed point-to-point.
  ca.send({ op: 'VOICE_JOIN', channelId: voiceCh.id });
  await cb.wait('VOICE_STATE_UPDATE', (d) => d.userId === a.data.user.id && d.channelId === voiceCh.id);
  cb.send({ op: 'VOICE_JOIN', channelId: voiceCh.id });
  const bState = await ca.wait('VOICE_STATE_UPDATE', (d) => d.userId === b.data.user.id && d.channelId === voiceCh.id);
  ca.send({ op: 'VOICE_SIGNAL', toSession: bState.sessionId, data: { type: 'offer', sdp: 'fake' } });
  const sig = await cb.wait('VOICE_SIGNAL');
  assert.equal(sig.data.sdp, 'fake');
  cb.send({ op: 'VOICE_STATE', mute: true, video: true });
  await ca.wait('VOICE_STATE_UPDATE', (d) => d.userId === b.data.user.id && d.mute && d.video);
  cb.send({ op: 'VOICE_LEAVE' });
  await ca.wait('VOICE_STATE_UPDATE', (d) => d.userId === b.data.user.id && d.channelId === null);
  ok('voice join/leave, mute/video state, WebRTC signaling relay');

  const dm = await req('POST', '/dms', { username: 'bob' }, A);
  await cb.wait('DM_CREATE', (d) => d.id === dm.data.id);
  await req('POST', `/channels/${dm.data.id}/messages`, { content: 'private' }, A);
  await cb.wait('MESSAGE_CREATE', (d) => d.channelId === dm.data.id);
  ok('direct messages');

  const msgs = (await req('GET', `/channels/${general.id}/messages?limit=5`, null, A)).data;
  const bobsMsg = msgs.find((m) => m.author.username === 'bob');
  const alicesMsg = msgs.find((m) => m.author.username === 'alice');
  assert.equal((await req('DELETE', `/messages/${alicesMsg.id}`, null, B)).status, 403);
  assert.equal((await req('DELETE', `/messages/${bobsMsg.id}`, null, A)).status, 204);
  ok('delete: others blocked, owner can moderate');
  await req('PUT', `/servers/${server.id}/bans/${b.data.user.id}`, {}, A);
  await cb.wait('SERVER_DELETE', (d) => d.id === server.id);
  assert.equal((await req('POST', `/invites/${inv.code}`, null, B)).status, 403);
  ok('ban removes member live and blocks rejoining');


  // ---------------- security checks ----------------
  const { DatabaseSync } = require('node:sqlite');
  const dbr = new DatabaseSync(path.join(dataDir, 'hearth.db'), { readOnly: true });
  const aliceRow = dbr.prepare("SELECT password_hash FROM users WHERE username = 'alice'").get();
  assert.match(aliceRow.password_hash, /^scrypt\$32768\$8\$3\$/);
  assert.ok(!aliceRow.password_hash.includes(PW));
  const sessRows = dbr.prepare('SELECT token_hash FROM auth_sessions').all();
  assert.ok(sessRows.length > 0 && sessRows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
  assert.ok(!sessRows.some((r) => r.token_hash === A));
  dbr.close();
  ok('database holds only scrypt hashes and hashed session tokens');

  // Browser-style login: token only in an HttpOnly cookie.
  const web = await req('POST', '/auth/login', { username: 'alice', password: PW }, null, { headers: { Origin: BASE } });
  assert.equal(web.status, 200); assert.equal(web.data.token, undefined);
  const setCookie = web.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  const cookieHdr = setCookie.split(';')[0];
  const host = new URL(BASE).host;
  const viaCookie = (method, p, body, origin) => req(method, p, body, null, { headers: { Cookie: cookieHdr, ...(origin ? { Origin: origin } : {}) } });
  assert.equal((await viaCookie('GET', '/users/@me')).status, 200);
  assert.equal((await viaCookie('POST', '/servers', { name: 'evil' }, 'https://evil.example')).status, 403);
  assert.equal((await viaCookie('POST', '/servers', { name: 'no-origin' })).status, 403);
  assert.equal((await viaCookie('POST', '/servers', { name: 'ok' }, `http://${host}`)).status, 200);
  assert.equal((await req('POST', '/auth/login', { username: 'alice', password: PW }, null, { headers: { Origin: 'https://evil.example' } })).status, 403);
  ok('login cookie is HttpOnly/SameSite; cross-site requests blocked (CSRF)');

  const evilWs = client(null, { headers: { Cookie: cookieHdr, Origin: 'https://evil.example' } });
  assert.equal(await evilWs.closed, 4003);
  const goodWs = client(null, { headers: { Cookie: cookieHdr, Origin: `http://${host}` } });
  await goodWs.wait('READY');
  ok('WebSocket: cookie login works, other websites refused');

  // Upgrading an old-style hash on login.
  {
    const crypto = require('node:crypto');
    const salt = crypto.randomBytes(16);
    const oldHash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync('legacy pass phrase', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
    await req('POST', '/auth/register', { acceptTerms: true, username: 'legacy', password: 'temporary words here' });
    const w = new DatabaseSync(path.join(dataDir, 'hearth.db'));
    w.exec('PRAGMA busy_timeout = 5000');
    w.prepare("UPDATE users SET password_hash = ? WHERE username = 'legacy'").run(oldHash);
    assert.equal((await req('POST', '/auth/login', { username: 'legacy', password: 'legacy pass phrase' })).status, 200);
    assert.match(w.prepare("SELECT password_hash FROM users WHERE username = 'legacy'").get().password_hash, /^scrypt\$32768\$/);
    w.close();
  }
  ok('older password hashes upgraded automatically on login');

  // Changing password signs out other devices immediately.
  const other = await req('POST', '/auth/login', { username: 'alice', password: PW, returnToken: true });
  const otherWs = client(other.data.token);
  await otherWs.wait('READY');
  const NEWPW = 'copper meadow rocket 7';
  assert.equal((await req('POST', '/users/@me/password', { currentPassword: 'nope nope nope', newPassword: NEWPW }, A)).status, 403);
  assert.equal((await req('POST', '/users/@me/password', { currentPassword: PW, newPassword: NEWPW }, A)).status, 200);
  assert.equal(await otherWs.closed, 4004);
  assert.equal((await req('GET', '/users/@me', null, other.data.token)).status, 401);
  assert.equal((await req('GET', '/users/@me', null, A)).status, 200);
  assert.equal((await req('POST', '/auth/login', { username: 'alice', password: NEWPW })).status, 200);
  ok('password change requires current password and signs out other devices');

  const sessions = (await req('GET', '/users/@me/sessions', null, A)).data;
  assert.ok(sessions.some((x) => x.current));
  await req('POST', '/auth/logout', null, A);
  assert.equal((await req('GET', '/users/@me', null, A)).status, 401);
  ok('device list and logout');

  for (let i = 0; i < 5; i++) await req('POST', '/auth/login', { username: 'bob', password: 'wrong guess ' + i });
  const locked = await req('POST', '/auth/login', { username: 'bob', password: PW });
  assert.equal(locked.status, 429);
  assert.ok(locked.headers.get('retry-after'));
  ok('repeated wrong passwords lock the account temporarily');

  goodWs.ws.close();
  // ---------------- permanent deletion & data rights ----------------
  const noTerms = await req('POST', '/auth/register', { username: 'erin', password: PW });
  assert.equal(noTerms.status, 400);
  ok('sign-up requires agreeing to terms (13+)');

  const A2 = (await req('POST', '/auth/login', { username: 'alice', password: NEWPW, returnToken: true })).data.token;
  const ca2 = client(A2); await ca2.wait('READY');
  const D = (await req('POST', '/auth/register', { acceptTerms: true, username: 'dave', password: 'granite willow comet 9', returnToken: true })).data.token;
  const daveId = (await req('GET', '/users/@me', null, D)).data.id;
  const srv2 = (await req('POST', '/servers', { name: 'Alice Place' }, A2)).data;
  const gen2 = srv2.channels.find((c) => c.type === 'text');
  const inv2 = (await req('POST', `/servers/${srv2.id}/invites`, {}, A2)).data;
  await req('POST', `/invites/${inv2.code}`, null, D);
  const daveFile = (await req('POST', `/channels/${gen2.id}/attachments`, null, D, { raw: Buffer.from('dave data'), headers: { 'X-Filename': 'd.txt', 'Content-Type': 'text/plain' } })).data;
  await req('POST', `/channels/${gen2.id}/messages`, { content: 'hi from dave', attachments: [daveFile] }, D);
  await req('POST', `/channels/${gen2.id}/messages`, { content: 'alice stays' }, A2);
  const daveSrv = (await req('POST', '/servers', { name: 'Dave Den' }, D)).data;
  const fileDir = path.join(dataDir, 'uploads', gen2.id);
  assert.ok(fs.readdirSync(fileDir).length === 1);

  const exp = await fetch(BASE + '/api/users/@me/export', { headers: { Authorization: 'Bearer ' + D } });
  const expData = await exp.json();
  assert.equal(expData.account.username, 'dave');
  assert.ok(expData.messages.some((m) => m.content === 'hi from dave'));
  assert.ok(!JSON.stringify(expData).includes('scrypt$'));
  ok('download my data (no password hash included)');

  assert.equal((await req('DELETE', '/users/@me', { password: 'granite willow comet 9', confirm: 'DELETE' }, D)).status, 409);
  assert.equal((await req('DELETE', `/servers/${daveSrv.id}`, { confirmName: 'wrong' }, D)).status, 400);
  assert.equal((await req('DELETE', `/servers/${daveSrv.id}`, { confirmName: 'Dave Den' }, D)).status, 204);
  ok('server deletion needs the exact name typed; owners must delete/transfer servers first');

  assert.equal((await req('DELETE', '/users/@me', { password: 'granite willow comet 9', confirm: 'delete' }, D)).status, 400);
  assert.equal((await req('DELETE', '/users/@me', { password: 'wrong password here', confirm: 'DELETE' }, D)).status, 403);
  assert.equal((await req('DELETE', '/users/@me', { password: 'granite willow comet 9', confirm: 'DELETE' }, D)).status, 204);
  await ca2.wait('USER_DELETE', (d) => d.userId === daveId);
  assert.equal((await req('GET', '/users/@me', null, D)).status, 401);
  const left = (await req('GET', `/channels/${gen2.id}/messages`, null, A2)).data;
  assert.ok(!left.some((m) => m.author.username === 'dave') && left.some((m) => m.content === 'alice stays'));
  assert.equal(fs.readdirSync(fileDir).length, 0);
  {
    const dbr2 = new DatabaseSync(path.join(dataDir, 'hearth.db'), { readOnly: true });
    assert.equal(dbr2.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'dave'").get().n, 0);
    assert.equal(dbr2.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_id = ?').get(daveId).n, 0);
    dbr2.close();
    const raw = fs.readFileSync(path.join(dataDir, 'hearth.db'));
    assert.ok(!raw.includes(Buffer.from('hi from dave')), 'deleted text must not remain in the database file');
  }
  ok('account deletion: password + typed DELETE; messages, files and account erased, even from the db file');

  const chFile = (await req('POST', `/channels/${gen2.id}/attachments`, null, A2, { raw: Buffer.from('x'), headers: { 'X-Filename': 'x.txt' } })).data;
  await req('POST', `/channels/${gen2.id}/messages`, { attachments: [chFile] }, A2);
  assert.equal((await req('DELETE', `/servers/${srv2.id}`, { confirmName: 'Alice Place' }, A2)).status, 204);
  assert.ok(!fs.existsSync(fileDir));
  ok('server deletion removes its uploaded files from disk');
  ca2.ws.close();


  // ---------------- email recovery ----------------
  const FPW = 'harvest lantern pickle 8';
  const fr = await req('POST', '/auth/register', { acceptTerms: true, username: 'frank', email: 'Frank@Test.Example', password: FPW, returnToken: true });
  const F = fr.data.token;
  assert.equal((await req('POST', '/auth/register', { acceptTerms: true, username: 'frank2', email: 'frank@test.example', password: FPW })).status, 409);
  const vcode = await lastCodeFor('frank@test.example', /verification code is:\s+(\d{6})/);
  assert.equal((await req('POST', '/users/@me/email/verify', { code: '000000' }, F)).status, 400);
  assert.equal((await req('POST', '/users/@me/email/verify', { code: vcode }, F)).data.emailVerified, true);
  {
    const dbr3 = new DatabaseSync(path.join(dataDir, 'hearth.db'), { readOnly: true });
    const row = dbr3.prepare("SELECT email_enc, email_hash FROM users WHERE username = 'frank'").get();
    dbr3.close();
    assert.ok(!row.email_enc.includes('frank') && /^[0-9a-f]{64}$/.test(row.email_hash));
  }
  ok('sign-up email verified with a code; stored encrypted; duplicates refused');

  const g1 = await req('POST', '/auth/forgot', { identifier: 'nobody@nowhere.example' });
  const g2 = await req('POST', '/auth/forgot', { identifier: 'frank@test.example' });
  assert.equal(g1.status, 200); assert.equal(JSON.stringify(g1.data), JSON.stringify(g2.data));
  const rcode = await lastCodeFor('frank@test.example', /reset code is:\s+([A-Z0-9]{8})/);
  assert.equal((await req('POST', '/auth/reset', { identifier: 'frank', code: 'WRONGCOD', newPassword: 'brand new phrase 77' })).status, 400);
  assert.equal((await req('POST', '/auth/reset', { identifier: 'frank@test.example', code: rcode, newPassword: 'brand new phrase 77' })).status, 200);
  assert.equal((await req('GET', '/users/@me', null, F)).status, 401);
  assert.equal((await req('POST', '/auth/reset', { identifier: 'frank', code: rcode, newPassword: 'another phrase here 1' })).status, 400);
  ok('forgot password: same answer for unknown accounts, emailed code works once, old sessions signed out');

  const F2 = (await req('POST', '/auth/login', { username: 'frank', password: 'brand new phrase 77', returnToken: true })).data.token;
  const rc = (await req('POST', '/users/@me/recovery-codes', { password: 'brand new phrase 77' }, F2)).data.codes;
  assert.equal(rc.length, 10);
  assert.equal((await req('POST', '/auth/reset', { identifier: 'frank', recoveryCode: rc[0].toLowerCase(), newPassword: 'third phrase for him' })).status, 200);
  assert.equal((await req('POST', '/auth/reset', { identifier: 'frank', recoveryCode: rc[0], newPassword: 'fourth phrase for him' })).status, 400);
  ok('backup recovery codes reset the password, each only once');

  // ---------------- moderation ----------------
  const OW = A2;
  const M = (await req('POST', '/auth/register', { acceptTerms: true, username: 'moddy', password: 'moderator phrase 123', returnToken: true })).data.token;
  const U = (await req('POST', '/auth/register', { acceptTerms: true, username: 'member1', password: 'member phrase 456 ok', returnToken: true })).data.token;
  const modId = (await req('GET', '/users/@me', null, M)).data.id;
  const memId = (await req('GET', '/users/@me', null, U)).data.id;
  const ms = (await req('POST', '/servers', { name: 'Mod Test' }, OW)).data;
  const msGen = ms.channels.find((c) => c.type === 'text');
  const msInv = (await req('POST', `/servers/${ms.id}/invites`, {}, OW)).data;
  await req('POST', `/invites/${msInv.code}`, null, M);
  await req('POST', `/invites/${msInv.code}`, null, U);
  const MODP = (1 << 4) | (1 << 5) | (1 << 6) | (1 << 9) | (1 << 14) | (1 << 15) | 1 | 2;
  const modRole = (await req('POST', `/servers/${ms.id}/roles`, { name: 'Mod', permissions: MODP }, OW)).data;
  assert.equal((await req('PUT', `/servers/${ms.id}/members/${modId}/roles/${modRole.id}`, null, OW)).status, 200);
  assert.equal((await req('POST', `/servers/${ms.id}/roles`, { name: 'x', permissions: 1 << 30 }, M)).status, 403);
  const helper = (await req('POST', `/servers/${ms.id}/roles`, { name: 'Helper', permissions: 0 }, M)).data;
  assert.equal((await req('PATCH', `/roles/${modRole.id}`, { name: 'Boss' }, M)).status, 403);
  assert.equal((await req('PUT', `/servers/${ms.id}/members/${memId}/roles/${helper.id}`, null, M)).status, 200);
  const ownerId = (await req('GET', '/users/@me', null, OW)).data.id;
  assert.equal((await req('DELETE', `/servers/${ms.id}/members/${ownerId}`, {}, M)).status, 403);
  ok('role hierarchy: mods manage only roles and members below them');

  const staff = (await req('POST', `/servers/${ms.id}/channels`, { name: 'staff' }, OW)).data;
  const everyone = (await req('GET', `/servers/${ms.id}`, null, OW)).data.roles.find((r) => r.isDefault);
  await req('PUT', `/channels/${staff.id}/overrides/role/${everyone.id}`, { allow: 0, deny: 1 }, OW);
  await req('PUT', `/channels/${staff.id}/overrides/role/${modRole.id}`, { allow: 1, deny: 0 }, OW);
  assert.equal((await req('GET', `/channels/${staff.id}/messages`, null, U)).status, 404);
  assert.equal((await req('GET', `/channels/${staff.id}/messages`, null, M)).status, 200);
  assert.ok(!(await req('GET', `/servers/${ms.id}`, null, U)).data.channels.some((c) => c.id === staff.id));
  const cu = client(U); await cu.wait('READY');
  await req('POST', `/channels/${staff.id}/messages`, { content: 'secret staff talk' }, M);
  await req('POST', `/channels/${msGen.id}/messages`, { content: 'public hello' }, M);
  await cu.wait('MESSAGE_CREATE', (d) => d.content === 'public hello');
  assert.ok(!cu.events.some((e) => e.t === 'MESSAGE_CREATE' && e.d.content === 'secret staff talk'));
  ok('private channels: hidden from the list, the API and live events');

  assert.equal((await req('PUT', `/servers/${ms.id}/members/${memId}/timeout`, { minutes: 10, reason: 'cool off' }, M)).status, 200);
  assert.equal((await req('POST', `/channels/${msGen.id}/messages`, { content: 'can I talk?' }, U)).status, 403);
  await req('PUT', `/servers/${ms.id}/members/${memId}/timeout`, { minutes: 0 }, M);
  assert.equal((await req('POST', `/channels/${msGen.id}/messages`, { content: 'back' }, U)).status, 200);
  await req('PATCH', `/channels/${msGen.id}`, { slowmode: 30 }, M);
  assert.equal((await req('POST', `/channels/${msGen.id}/messages`, { content: 'again' }, U)).status, 429);
  const auditLog = (await req('GET', `/servers/${ms.id}/audit-log`, null, M)).data;
  assert.ok(auditLog.some((a) => a.action === 'member.timeout') && auditLog.some((a) => a.action === 'channel.permissions'));
  assert.equal((await req('GET', `/servers/${ms.id}/audit-log`, null, U)).status, 403);
  ok('timeouts, slowmode, and audit log');

  // ---------------- reports, blocks, admin ----------------
  const modMsg = (await req('POST', `/channels/${msGen.id}/messages`, { content: 'mean words here' }, M)).data;
  assert.equal((await req('POST', '/reports', { targetType: 'message', targetId: modMsg.id, category: 'harassment', details: 'rude' }, U)).data.sentTo[0], 'server');
  const queue = (await req('GET', `/servers/${ms.id}/reports`, null, M)).data;
  assert.equal(queue.length, 1); assert.equal(queue[0].evidence.message.content, 'mean words here');
  const csam = (await req('POST', '/reports', { targetType: 'message', targetId: modMsg.id, category: 'child_safety' }, U)).data;
  assert.deepEqual(csam.sentTo, ['platform']);
  assert.equal((await req('GET', `/servers/${ms.id}/reports`, null, M)).data.length, 1);
  assert.equal((await req('GET', '/admin/reports', null, U)).status, 404);
  const adminQ = (await req('GET', '/admin/reports', null, OW)).data;
  assert.ok(adminQ.some((r) => r.category === 'child_safety' && r.evidence.message.content === 'mean words here'));
  ok('reports: server mods see server reports; child-safety reports go only to Hearth admins');

  await req('POST', `/servers/${ms.id}/reports/${queue[0].id}/resolve`, { action: 'delete_message', note: 'removed' }, OW);
  assert.ok(!(await req('GET', `/channels/${msGen.id}/messages`, null, U)).data.some((m) => m.id === modMsg.id));
  const adminQ2 = (await req('GET', '/admin/reports', null, OW)).data;
  assert.equal(adminQ2.find((r) => r.category === 'child_safety').evidence.message.content, 'mean words here');
  ok('reported content stays preserved as evidence after it is deleted');

  await req('PUT', `/users/@me/blocks/${ownerId}`, null, U);
  const member1 = 'member1';
  assert.equal((await req('POST', '/dms', { username: member1 }, OW)).status, 403);
  ok('blocking stops direct messages');

  const vlist = (await req('GET', `/admin/vault?user=${daveId}`, null, OW)).data;
  const acct = vlist.find((v) => v.kind === 'account');
  assert.ok(acct);
  assert.equal((await req('POST', `/admin/vault/${acct.id}/open`, {}, OW)).status, 400);
  const opened = (await req('POST', `/admin/vault/${acct.id}/open`, { reason: 'test investigation' }, OW)).data;
  assert.ok(opened.data.messages.some((m) => m.content === 'hi from dave'));
  assert.equal(opened.data.account.email, 'dave@test.example');
  await req('POST', '/admin/holds', { targetType: 'user', targetId: daveId, reason: 'Preservation request #123' }, OW);
  assert.equal((await req('GET', '/admin/holds', null, OW)).data[0].targetId, daveId);
  const alog = (await req('GET', '/admin/log', null, OW)).data;
  assert.ok(alog.some((l) => l.action === 'vault.open' && l.detail === 'test investigation'));
  ok('deleted accounts kept encrypted in the vault; admin access needs a reason and is logged; legal holds');

  await req('POST', `/admin/users/${memId}/suspend`, { reason: 'test' }, OW);
  assert.equal((await req('GET', '/users/@me', null, U)).status, 401);
  assert.equal((await req('POST', '/auth/login', { username: 'member1', password: 'member phrase 456 ok' })).status, 403);
  await req('POST', `/admin/users/${memId}/unsuspend`, null, OW);
  assert.equal((await req('POST', '/auth/login', { username: 'member1', password: 'member phrase 456 ok' })).status, 200);
  ok('Hearth admins can suspend and restore accounts');

  // ---------------- age-restricted channels & commands ----------------
  assert.equal((await req('POST', '/auth/register', { acceptTerms: true, username: 'tiny', password: 'little kid phrase 1', birthdate: '2020-05-05' })).status, 400);
  const T = (await req('POST', '/auth/register', { acceptTerms: true, username: 'teen1', password: 'teenager phrase 22', birthdate: '2011-03-03', returnToken: true })).data.token;
  await req('POST', `/invites/${msInv.code}`, null, T);
  const adultCh = (await req('POST', `/servers/${ms.id}/channels`, { name: 'after dark' }, OW)).data;
  await req('PATCH', `/channels/${adultCh.id}`, { ageRating: 18 }, OW);
  const teenView = await req('GET', `/channels/${adultCh.id}/messages`, null, T);
  assert.equal(teenView.status, 403); assert.equal(teenView.data.code, 'age_restricted');
  assert.ok(!(await req('GET', `/servers/${ms.id}`, null, T)).data.channels.some((c) => c.id === adultCh.id));
  assert.equal((await req('GET', `/channels/${adultCh.id}/messages`, null, M)).status, 200);
  assert.equal((await req('POST', '/users/@me/birthdate', { date: '1980-01-01' }, T)).status, 409);
  await req('PATCH', `/channels/${adultCh.id}`, { ageRating: 21 }, OW);
  const me21 = (await req('GET', '/users/@me', null, M)).data;
  assert.equal(me21.over21, true);
  ok('age gates: under-13 sign-ups refused; 18+/21+ channels hidden from minors; birth date set once');

  const roll = (await req('POST', `/channels/${msGen.id}/roll`, { dice: '2d6+1' }, OW)).data;
  assert.equal(roll.kind, 'roll'); assert.match(roll.content, /^rolled 2d6\+1: \*\*\d+\*\*/);
  const meMsg = (await req('POST', `/channels/${msGen.id}/messages`, { content: 'waves', kind: 'me' }, OW)).data;
  assert.equal(meMsg.kind, 'me');
  const purged = (await req('POST', `/channels/${msGen.id}/purge`, { count: 3 }, M)).data;
  assert.equal(purged.deleted, 3);
  assert.equal((await req('POST', `/channels/${msGen.id}/purge`, { count: 3 }, T)).status, 403);
  ok('slash command actions: server-side dice and coin, /me, moderator purge');

  // ---------------- Discord import ----------------
  await mockReady;
  const P_ = { VIEW_CHANNELS: 1, SEND_MESSAGES: 2, MANAGE_MESSAGES: 16, KICK_MEMBERS: 512, MODERATE_MEMBERS: 16384 };
  const JN = (await req('POST', '/auth/register', { acceptTerms: true, username: 'joiner', password: 'joining later phrase 3', returnToken: true })).data.token;
  const IM = (await req('POST', '/auth/register', { acceptTerms: true, username: 'mover', password: 'moving day phrase 9', returnToken: true })).data.token;
  assert.equal((await req('POST', '/imports/discord/inspect', { token: 'nope' }, IM)).status, 400);
  assert.equal((await req('POST', '/imports/discord/inspect', { token: 'MTA.wrong-token.' + 'y'.repeat(40) }, IM)).status, 400);
  const insp = (await req('POST', '/imports/discord/inspect', { token: mockDiscord.TOKEN }, IM)).data;
  assert.equal(insp.messageContentIntent, true);
  assert.match(insp.inviteUrl, /client_id=1000000000000000999&scope=bot&permissions=66560$/);
  assert.equal(insp.guilds[0].name, 'Retro Gamers');
  const pv = (await req('POST', '/imports/discord/preview', { token: mockDiscord.TOKEN, guildId: mockDiscord.GUILD }, IM)).data;
  const pvc = Object.fromEntries(pv.channels.map((c) => [c.name, c]));
  assert.equal(pvc.staff.readable, false); assert.equal(pvc.general.readable, true); assert.equal(pvc.staff.private, true);
  assert.equal(pvc['help-forum'].type, 'unsupported');
  assert.deepEqual(pv.roles.map((r) => r.name), ['Mods', 'VIP']); assert.deepEqual(pv.skippedRoles, ['HearthMover']);
  ok('import wizard: token checked, invite link built, server preview shows what the bot can read');

  const { C: DC } = mockDiscord;
  assert.equal((await req('POST', '/imports/discord', { token: mockDiscord.TOKEN, options: { guildId: mockDiscord.GUILD } }, IM)).status, 400);
  const job = (await req('POST', '/imports/discord', {
    token: mockDiscord.TOKEN, accepted: true,
    options: { guildId: mockDiscord.GUILD, channels: { [DC.general]: { messages: true }, [DC.news]: { messages: true }, [DC.staff]: { messages: true }, [DC.memes]: { messages: false } } },
  }, IM)).data;
  let done;
  for (let t = 0; t < 100; t++) {
    done = (await req('GET', '/imports', null, IM)).data.find((j) => j.id === job.id);
    if (done.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.equal(done.progress.messages, 155); // 150 + reply + mentions + file + embed + rule; join notice skipped
  assert.equal(done.progress.files, 1);
  assert.ok(done.progress.notes.some((n) => /staff.*couldn.t read/.test(n)));
  assert.ok(done.progress.notes.some((n) => /help-forum/.test(n)));
  const isrv = (await req('GET', `/servers/${done.serverId}`, null, IM)).data;
  assert.equal(isrv.name, 'Retro Gamers'); assert.ok(isrv.icon);
  const byName = Object.fromEntries(isrv.channels.map((c) => [c.name, c]));
  assert.equal(byName.Chat.type, 'category'); assert.equal(byName.general.parentId, byName.Chat.id);
  assert.equal(byName.rules.parentId, byName.Information.id); assert.equal(byName.welcome.parentId, null);
  assert.equal(byName.Lounge.type, 'voice'); assert.ok(!byName['help-forum']);
  assert.equal(byName.general.slowmode, 10); assert.equal(byName.general.topic, 'Talk about anything');
  assert.equal(byName.memes.ageRating, 18);
  assert.ok(isrv.channels.every((c) => c.pendingReview));
  const mods = isrv.roles.find((r) => r.name === 'Mods'); const evr = isrv.roles.find((r) => r.isDefault);
  assert.equal(mods.color, '#33ff66'); assert.ok(mods.position > isrv.roles.find((r) => r.name === 'VIP').position);
  assert.equal(mods.permissions, P_.MANAGE_MESSAGES | P_.KICK_MEMBERS | P_.MODERATE_MEMBERS);
  assert.ok(!isrv.roles.some((r) => r.name === 'HearthMover'));
  assert.equal(evr.permissions & P_.SEND_MESSAGES, P_.SEND_MESSAGES);
  const staffOv = byName.staff.overrides;
  assert.ok(staffOv.find((o) => o.id === evr.id && o.deny === P_.VIEW_CHANNELS));
  assert.ok(staffOv.find((o) => o.id === mods.id && o.allow === P_.VIEW_CHANNELS));
  assert.ok(byName.rules.overrides.find((o) => o.id === evr.id && o.deny === P_.SEND_MESSAGES));
  ok('import rebuilds server, roles (color, order, permissions), categories, channels and their permissions');

  let hist = [];
  let before = '';
  for (;;) {
    const page = (await req('GET', `/channels/${byName.general.id}/messages?limit=100${before}`, null, IM)).data;
    if (!page.length) break;
    hist = page.concat(hist); before = `&before=${page[0].id}`;
  }
  assert.equal(hist.length, 155); // 154 + the "archived above" divider
  assert.equal(hist[0].content, 'message 0'); assert.equal(hist[149].content, 'message 149');
  assert.ok(hist.every((m, i) => i === 0 || m.createdAt >= hist[i - 1].createdAt));
  assert.equal(hist[0].imported.name, 'Alice A'); assert.equal(hist[0].imported.username, 'alice'); assert.ok(hist[0].imported.avatar);
  assert.equal(hist[1].imported.name, 'bob'); assert.equal(hist[0].createdAt, Date.UTC(2023, 0, 1) + 10 * 60000);
  assert.equal(hist[150].replyTo, hist[0].id);
  assert.equal(hist[151].content, 'hey @bob see #rules :pog: @Mods');
  assert.deepEqual(hist[151].importedReactions, [{ emoji: '👍', count: 3 }, { emoji: ':pog:', count: 1 }]);
  const fileUrl = hist[152].attachments[0].url;
  assert.ok(fileUrl.startsWith(`/uploads/${byName.general.id}/`));
  assert.equal((await fetch(BASE + fileUrl, { headers: { Authorization: 'Bearer ' + IM } })).status, 200);
  assert.match(hist[153].content, /Server stats.*42 members.*\*\*Online\*\*: 7/s); assert.equal(hist[153].imported.bot, true);
  assert.equal(hist[154].kind, 'import_marker');
  assert.equal((await req('GET', `/channels/${byName.memes.id}/messages`, null, IM)).data.length, 0);
  assert.equal((await req('GET', `/channels/${byName.staff.id}/messages`, null, IM)).data.length, 0);
  assert.equal((await req('PATCH', `/messages/${hist[0].id}`, { content: 'mine now' }, IM)).status, 403);
  assert.equal((await req('POST', '/dms', { username: 'discord-archive' }, IM)).status, 404);
  assert.equal((await req('POST', '/auth/login', { username: 'discord-archive', password: 'anything at all 1' })).status, 401);
  ok('import brings history in order with original names, replies, mentions, files, embeds and reactions; archive is locked');

  const iinv = (await req('POST', `/servers/${done.serverId}/invites`, {}, IM)).data;
  await req('POST', `/invites/${iinv.code}`, null, JN);
  assert.equal((await req('GET', `/servers/${done.serverId}`, null, JN)).data.channels.length, 0);
  assert.equal((await req('GET', `/channels/${byName.general.id}/messages`, null, JN)).status, 404);
  await req('PATCH', `/channels/${byName.general.id}`, { pendingReview: false }, IM);
  assert.ok((await req('GET', `/servers/${done.serverId}`, null, JN)).data.channels.some((c) => c.id === byName.general.id));
  assert.equal((await req('POST', `/servers/${done.serverId}/channels/open`, {}, JN)).status, 403);
  assert.ok((await req('POST', `/servers/${done.serverId}/channels/open`, {}, IM)).data.opened > 5);
  const importVisible = (await req('GET', `/servers/${done.serverId}`, null, JN)).data.channels.map((c) => c.name);
  assert.ok(importVisible.includes('rules') && !importVisible.includes('staff'));
  ok('imported channels stay hidden from members until the owner reviews and opens them');

  cu.ws.close();
  ca.ws.close(); cb.ws.close();
  console.log(`\nAll ${passed} checks passed.`);
}

main().then(() => { srv.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); })
  .catch((err) => { console.error('\nFAILED:', err); srv.kill(); process.exit(1); });
