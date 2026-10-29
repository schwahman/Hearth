// Sends email over SMTP, written from scratch on Node's TLS sockets.
// Works with any email-sending service that offers SMTP (Amazon SES,
// Postmark, Mailgun, Zoho, Microsoft 365, and so on).
//
// Settings (in /etc/hearth.env):
//   SMTP_HOST, SMTP_PORT (465 = TLS, 587 = STARTTLS), SMTP_USER, SMTP_PASS,
//   MAIL_FROM ("Hearth <no-reply@yourdomain.com>")
// Without SMTP settings, emails can't be sent; MAIL_DEV=true prints them to
// the server log instead (testing only: never in production).
'use strict';
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const cfg = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || '',
  dev: process.env.MAIL_DEV === 'true',
};

const configured = () => !!(cfg.host && cfg.from);
const devOutbox = []; // MAIL_DEV only, for tests

function addressOf(from) {
  const m = /<([^>]+)>/.exec(from);
  return m ? m[1] : from;
}

// Strip anything that could inject extra headers.
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').slice(0, 300);

async function sendMail({ to, subject, text }) {
  if (!configured()) {
    if (cfg.dev) {
      devOutbox.push({ to, subject, text });
      console.log(`[mail:dev] to=${to} subject="${subject}"\n${text}`);
      return true;
    }
    console.warn('[mail] SMTP is not configured; email not sent');
    return false;
  }
  const domain = addressOf(cfg.from).split('@')[1] || 'localhost';
  const msg = [
    `From: ${clean(cfg.from)}`,
    `To: ${clean(to)}`,
    `Subject: ${clean(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    // Dot-stuffing: lines starting with "." get an extra "."
    String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
  ].join('\r\n');
  await smtp(clean(to), msg);
  return true;
}

function smtp(to, message) {
  return new Promise((resolve, reject) => {
    let sock;
    let buf = '';
    let waiting = null;
    const timer = setTimeout(() => fail(new Error('SMTP timeout')), 30000);
    const fail = (err) => { clearTimeout(timer); if (sock) sock.destroy(); reject(err); };

    const onData = (d) => {
      buf += d.toString('utf8');
      // A reply is complete when a line has "NNN " (space, not dash).
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          const w = waiting; waiting = null;
          if (w) w(reply);
          return;
        }
      }
    };
    const expect = (code) => new Promise((res, rej) => {
      waiting = (reply) => (reply.startsWith(String(code)) ? res(reply) : rej(new Error(`SMTP: ${reply.split('\n').pop()}`)));
    });
    const cmd = (line, code) => { const p = expect(code); sock.write(line + '\r\n'); return p; };
    const attach = (s) => { sock = s; s.on('data', onData); s.on('error', fail); };

    (async () => {
      const implicit = cfg.port === 465;
      attach(implicit ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect(cfg.port, cfg.host));
      await expect(220);
      const ehlo = await cmd('EHLO hearth', 250);
      if (!implicit) {
        if (!/STARTTLS/i.test(ehlo)) throw new Error('SMTP server does not offer STARTTLS; refusing to send unencrypted');
        await cmd('STARTTLS', 220);
        sock.removeListener('data', onData);
        attach(tls.connect({ socket: sock, servername: cfg.host }));
        await new Promise((r) => sock.once('secureConnect', r));
        await cmd('EHLO hearth', 250);
      }
      if (cfg.user) {
        await cmd('AUTH LOGIN', 334);
        await cmd(Buffer.from(cfg.user).toString('base64'), 334);
        await cmd(Buffer.from(cfg.pass).toString('base64'), 235);
      }
      await cmd(`MAIL FROM:<${addressOf(cfg.from)}>`, 250);
      await cmd(`RCPT TO:<${to}>`, 250);
      await cmd('DATA', 354);
      await cmd(`${message}\r\n.`, 250);
      sock.write('QUIT\r\n');
      clearTimeout(timer);
      sock.end();
      resolve();
    })().catch(fail);
  });
}

module.exports = { sendMail, configured: () => configured() || cfg.dev, canSend: () => configured() || cfg.dev, devOutbox };
