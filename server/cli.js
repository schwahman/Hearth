// Emergency admin tool, run on the server itself (for example from your
// hosting provider's web console). Only someone with root access to the
// machine can use it, which is what makes it safe.
//
//   hearth-admin reset-password <username>   set a new temporary password
//   hearth-admin make-admin <username>        give Hearth admin rights
//   hearth-admin list-admins                  show who is an admin
//   hearth-admin unsuspend <username>         lift an account suspension
'use strict';
const crypto = require('node:crypto');

const [, , command, username] = process.argv;
const usage = () => {
  console.log(`Hearth admin tool

  hearth-admin reset-password <username>   set a new temporary password and sign out all devices
  hearth-admin make-admin <username>       give someone Hearth admin rights
  hearth-admin list-admins                 show who is a Hearth admin
  hearth-admin unsuspend <username>        lift an account suspension

After a password reset, run: systemctl restart hearth   (clears any login lockout)`);
  process.exit(command ? 1 : 0);
};
if (!command || command === 'help' || command === '--help') usage();

const { one, all, run } = require('./db');
const { newId } = require('./ids');

function findUser() {
  if (!username) { console.error('Give a username, e.g. hearth-admin reset-password josh'); process.exit(1); }
  const u = one('SELECT id, username FROM users WHERE username = ?', username);
  if (!u) { console.error(`No account named "${username}".`); process.exit(1); }
  return u;
}

function log(action, target) {
  run('INSERT INTO admin_log (id, admin_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId(), 'server-console', action, target, 'run from the server console', Date.now());
}

(async () => {
  if (command === 'reset-password') {
    const u = findUser();
    const auth = require('./auth');
    // Easy-to-type temporary password: four groups of letters/numbers.
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const groups = [];
    for (let g = 0; g < 4; g++) {
      let part = '';
      for (const b of crypto.randomBytes(4)) part += alphabet[b % alphabet.length];
      groups.push(part);
    }
    const temp = groups.join('-');
    run('UPDATE users SET password_hash = ? WHERE id = ?', await auth.hashPassword(temp), u.id);
    run('DELETE FROM auth_sessions WHERE user_id = ?', u.id);
    log('console.reset_password', u.id);
    console.log(`\nTemporary password for ${u.username}:\n\n    ${temp}\n`);
    console.log('Log in with it, then change it right away in Profile > Change password.');
    console.log('All devices were signed out. If logins are locked out, run: systemctl restart hearth');
  } else if (command === 'make-admin') {
    const u = findUser();
    run('UPDATE users SET is_admin = 1 WHERE id = ?', u.id);
    log('console.make_admin', u.id);
    console.log(`${u.username} is now a Hearth admin. They may need to refresh the page.`);
  } else if (command === 'list-admins') {
    for (const a of all('SELECT username FROM users WHERE is_admin = 1 ORDER BY created_at')) console.log(a.username);
  } else if (command === 'unsuspend') {
    const u = findUser();
    run('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?', u.id);
    log('console.unsuspend', u.id);
    console.log(`${u.username} is no longer suspended.`);
  } else {
    usage();
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
