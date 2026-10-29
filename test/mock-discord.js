// A tiny stand-in for Discord's REST API and CDN, so the import can be
// tested end to end without touching the real Discord.
'use strict';
const http = require('node:http');

const TOKEN = 'MTA.mock-bot-token.' + 'x'.repeat(40);
const sf = (ms) => ((BigInt(ms) - 1420070400000n) << 22n).toString();
const base = Date.UTC(2023, 0, 1);
const GUILD = '1000000000000000001';
const R = { mod: '1000000000000000010', vip: '1000000000000000011', botRole: '1000000000000000012' };
const C = {
  info: '1000000000000000100', chat: '1000000000000000101', general: '1000000000000000102', memes: '1000000000000000103',
  staff: '1000000000000000104', news: '1000000000000000105', forum: '1000000000000000106', voice: '1000000000000000107',
  loose: '1000000000000000108',
};
const BOT = { id: '1000000000000000900', username: 'HearthMover', bot: true };
const alice = { id: '2000000000000000001', username: 'alice', global_name: 'Alice A', avatar: 'abc123' };
const bob = { id: '2000000000000000002', username: 'bob', global_name: null, avatar: null };

const guild = {
  id: GUILD, name: 'Retro Gamers', icon: 'iconhash', nsfw_level: 0,
  roles: [
    { id: GUILD, name: '@everyone', permissions: String((1 << 10) | (1 << 11) | (1 << 16) | (1 << 6) | (1 << 20) | (1 << 21)), position: 0, color: 0, managed: false },
    { id: R.mod, name: 'Mods', permissions: String((1n << 13n) | (1n << 1n) | (1n << 40n)), position: 2, color: 0x33ff66, managed: false },
    { id: R.vip, name: 'VIP', permissions: '0', position: 1, color: 0xffcc00, managed: false },
    { id: R.botRole, name: 'HearthMover', permissions: String((1 << 10) | (1 << 16)), position: 3, color: 0, managed: true },
  ],
};
const ow = (id, type, allow, deny) => ({ id, type, allow: String(allow), deny: String(deny) });
const channels = [
  { id: C.info, type: 4, name: 'Information', position: 0, permission_overwrites: [] },
  { id: C.chat, type: 4, name: 'Chat', position: 1, permission_overwrites: [] },
  { id: C.general, type: 0, name: 'general', position: 0, parent_id: C.chat, topic: 'Talk about anything', rate_limit_per_user: 10, nsfw: false, permission_overwrites: [] },
  { id: C.memes, type: 0, name: 'memes', position: 1, parent_id: C.chat, nsfw: true, permission_overwrites: [] },
  { id: C.staff, type: 0, name: 'staff', position: 2, parent_id: C.chat, permission_overwrites: [ow(GUILD, 0, 0, 1 << 10), ow(R.mod, 0, 1 << 10, 0)] },
  { id: C.news, type: 5, name: 'rules', position: 0, parent_id: C.info, topic: 'Read me', permission_overwrites: [ow(GUILD, 0, 0, 1 << 11)] },
  { id: C.forum, type: 15, name: 'help-forum', position: 3, parent_id: C.chat, permission_overwrites: [] },
  { id: C.voice, type: 2, name: 'Lounge', position: 0, parent_id: C.chat, permission_overwrites: [] },
  { id: C.loose, type: 0, name: 'welcome', position: 0, permission_overwrites: [] },
];

function msg(n, channel, author, content, extra = {}) {
  return { id: sf(base + n * 60000), channel_id: channel, type: 0, author, content, timestamp: new Date(base + n * 60000).toISOString(), edited_timestamp: null, attachments: [], embeds: [], mentions: [], ...extra };
}
const messages = { [C.general]: [], [C.news]: [], [C.memes]: [], [C.staff]: [], [C.loose]: [] };
for (let i = 0; i < 150; i++) messages[C.general].push(msg(i + 10, C.general, i % 2 ? bob : alice, `message ${i}`));
const first = messages[C.general][0];
messages[C.general].push(msg(200, C.general, bob, 'replying to the first one', { type: 19, message_reference: { message_id: first.id } }));
messages[C.general].push(msg(201, C.general, alice, 'hey <@2000000000000000002> see <#1000000000000000105> <:pog:123> <@&1000000000000000010>', {
  mentions: [bob], reactions: [{ emoji: { id: null, name: '👍' }, count: 3 }, { emoji: { id: '55', name: 'pog' }, count: 1 }],
}));
messages[C.general].push(msg(202, C.general, alice, '', { type: 7 })); // "joined the server" notice: skipped
messages[C.general].push(msg(203, C.general, bob, 'look at this', {
  attachments: [{ id: '1', filename: 'screenshot.png', size: 68, url: 'CDN/attachments/1/screenshot.png', content_type: 'image/png' }],
}));
messages[C.general].push(msg(204, C.general, { id: '3000', username: 'StatBot', bot: true }, '', {
  embeds: [{ type: 'rich', title: 'Server stats', description: '42 members', fields: [{ name: 'Online', value: '7' }] }],
}));
messages[C.news].push(msg(1, C.news, alice, 'Rule 1: be kind'));
messages[C.memes].push(msg(2, C.memes, bob, 'meme spam'));
messages[C.staff].push(msg(3, C.staff, alice, 'secret'));

function start(port = 0) {
  let rateLimitedOnce = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (p.startsWith('/cdn/')) {
      // A tiny valid PNG for icons, avatars and attachments.
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d60000000049454e44ae426082', 'hex');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    if (req.headers.authorization !== `Bot ${TOKEN}`) return json(401, { message: '401: Unauthorized', code: 0 });
    if (p === '/api/users/@me') return json(200, BOT);
    if (p === '/api/oauth2/applications/@me') return json(200, { id: '1000000000000000999', name: 'HearthMover', flags: 1 << 19 });
    if (p === '/api/users/@me/guilds') return json(200, [{ id: GUILD, name: guild.name, icon: guild.icon }]);
    if (p === `/api/guilds/${GUILD}`) return json(200, guild);
    if (p === `/api/guilds/${GUILD}/channels`) return json(200, channels);
    if (p === `/api/guilds/${GUILD}/members/${BOT.id}`) return json(200, { user: BOT, roles: [R.botRole] });
    const m = /^\/api\/channels\/(\d+)\/messages$/.exec(p);
    if (m) {
      if (!rateLimitedOnce) { rateLimitedOnce = true; return json(429, { message: 'You are being rate limited.', retry_after: 0.2, global: false }); }
      if (m[1] === C.staff) return json(403, { message: 'Missing Access', code: 50001 });
      const after = BigInt(url.searchParams.get('after') || '0');
      const limit = Number(url.searchParams.get('limit') || 50);
      const page = (messages[m[1]] || []).filter((x) => BigInt(x.id) > after).slice(0, limit).reverse()
        .map((x) => JSON.parse(JSON.stringify(x).replace(/CDN\//g, `http://127.0.0.1:${server.address().port}/cdn/`)));
      return json(200, page);
    }
    json(404, { message: 'Unknown', code: 0 });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

module.exports = { start, TOKEN, GUILD, C, R, messages };
