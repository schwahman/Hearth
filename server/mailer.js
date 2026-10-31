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
let lastError = null; // { message, hint, at } from the most recent failed send

// Plain-English advice for common SMTP failures (shown to Hearth admins).
function hintFor(msg) {
  if (/\b535\b|BadCredentials|Username and Password not accepted|AUTH/i.test(msg)) {
    return 'The email provider rejected the login. Check SMTP_USER (the full address) and SMTP_PASS (for Gmail, a 16-letter App Password with no spaces), then restart Hearth.';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'The server name in SMTP_HOST couldn\u2019t be found. Check it for typos.';
  if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(msg)) return 'Couldn\u2019t connect to the email server. Check SMTP_HOST and SMTP_PORT (587 or 465).';
  if (/certificate|self.signed|CERT/i.test(msg)) return 'The email server\u2019s security certificate wasn\u2019t accepted.';
  if (/\b5\.7\.0\b|\b530\b/.test(msg)) return 'The email provider wants extra verification for this account (for Gmail, make sure 2-Step Verification is on and use an App Password).';
  return 'Check the SMTP settings in /etc/hearth.env.';
}

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
    // Non-ASCII subjects (like \u00D7 or emoji) must be encoded (RFC 2047).
    `Subject: ${/[^\x20-\x7e]/.test(clean(subject)) ? `=?UTF-8?B?${Buffer.from(clean(subject)).toString('base64')}?=` : clean(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    // Dot-stuffing: lines starting with "." get an extra "."
    String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
  ].join('\r\n');
  // Failures are logged (without the password) and reported as "not sent",
  // so callers can show a clear message instead of a server error.
  try {
    await smtp(clean(to), msg);
    lastError = null;
    return true;
  } catch (e) {
    lastError = { message: String(e.message || e).slice(0, 300), hint: hintFor(String(e.message || e)), at: Date.now() };
    console.error(`[mail] could not send "${clean(subject)}": ${lastError.message} (${lastError.hint})`);
    return false;
  }
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

module.exports = { sendMail, configured: () => configured() || cfg.dev, canSend: () => configured() || cfg.dev, devOutbox, lastError: () => lastError };
