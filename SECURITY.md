# How Hearth protects accounts

Hearth follows the same published standards large services use: the **OWASP** Password Storage, Session Management and CSRF cheat sheets, and **NIST SP 800-63B** for password rules.

## Passwords
- **Never stored or logged.** Only a one-way **scrypt** hash is kept, with a random 16-byte salt per user. Nobody, including the server owner, can read a password back out.
- **Memory-hard hashing** (N=2^15, r=8, p=3, one of OWASP's recommended settings), so guessing from a stolen database is very slow even with GPUs.
- **Upgradable.** Settings are stored with each hash; older hashes are re-hashed with current settings automatically at the person's next login.
- **NIST-style rules:** at least 12 characters, up to 256, passphrases welcome, no forced symbols. Rejected: common/breached passwords (1,200+ list), passwords containing the username, and repetitive ones.
- **Timing-safe:** a wrong username takes as long as a wrong password, so attackers can't probe which accounts exist by timing.

## Sessions
- Logging in creates a random **256-bit token** sent only in an **HttpOnly, SameSite=Strict** cookie (plus **Secure** on HTTPS). Page scripts can't read it, so even an injected script couldn't steal it.
- The database stores only a **SHA-256 hash** of each token. A stolen database copy can't be used to log in.
- Sessions expire after **30 days unused** and **1 year** at most.
- **Changing your password signs out every other device instantly**, including live connections.
- Users can see their signed-in devices, sign out any one of them, or sign out everywhere.

## Attacks blocked
- **Password guessing:** 20 login attempts per 15 minutes per network address; after 5 wrong passwords an account locks for 1 minute, doubling up to 15 minutes.
- **Mass sign-ups:** at most 5 new accounts per hour per network address.
- **Cross-site request forgery:** changes made with the login cookie must come from Hearth's own pages (Origin check), on top of SameSite cookies.
- **Cross-site WebSocket hijacking:** live connections from other websites are refused.
- **Script injection:** strict Content-Security-Policy (only Hearth's own scripts run), all message text escaped.
- **File access:** uploads are only served to logged-in people who can see that channel.
- **Clickjacking / sniffing:** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; HSTS when on HTTPS.

## Deleting data and retention
- **Messages, channels, servers and accounts are removed from Hearth immediately** (including files on disk) and can't be restored by the user. Every deletion shows a warning; servers, channels and accounts require typing an exact phrase (accounts also need the password).
- **Retention vault:** before anything is deleted, an encrypted copy (AES-256-GCM, its own key) is stored for **30 days** (`VAULT_DAYS`), then erased automatically. Earlier versions of edited messages are kept the same way. This lets illegal activity be investigated after the fact.
- **Report evidence** is preserved for **1 year**, matching the US preservation requirement for child-safety reports (18 U.S.C. 2258A as amended by the REPORT Act of 2024).
- **Legal holds** (admin panel) stop erasure for a user or server until released, for preservation requests (e.g. 18 U.S.C. 2703(f)) or expected litigation.
- Only Hearth platform admins can open the vault; they must give a reason, and every access is recorded in the admin log.
- The live database runs with **secure delete** and flushes its write-ahead log, so deleted plaintext doesn't linger in the database file (verified by the test suite).
- Uploads never attached are removed after 24 hours; moderation logs after 90 days; system logs after 30 days.

## Email and account recovery
- Sign-up requires an email address, stored **encrypted** with a keyed hash for lookups.
- Verification, password-reset and email-change codes are single-use, short-lived (20 to 30 minutes), limited to 5 guesses, and stored only as hashes.
- "Forgot password" gives the same answer whether or not an account exists, so it can't be used to discover accounts.
- **Backup recovery codes** (10, single-use, stored hashed) let people reset without email.
- Password resets sign out every device and send a security notice. Email changes notify the old address.
- Email is sent over SMTP with TLS required (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`).

## Age checks
- Date of birth is required at sign-up (under-13s refused), stored **encrypted**, and can be set only once by the user (admins can reset it).
- Channels and servers can be rated **18+** or **21+**. They're hidden from anyone too young, enforced on the server for messages, files, live events and voice, not just in the app.
- This is self-declared age. Some US states require ID-based age verification for sites with substantial adult content; get legal advice before allowing 18+ content publicly.

## Moderation and reporting
- Role hierarchy: moderators can only act on members and roles below their own highest role, and can't grant permissions they don't have.
- Per-channel permission overrides (private and read-only channels) are enforced by the server, including live events, so hidden channels stay hidden.
- Timeouts, slowmode, bans, and a 90-day audit log of moderator actions.
- Reports: server moderators see their server's reports; child-safety reports, DM reports and whole-server reports go only to Hearth admins. Reporters are anonymous to the reported person.
- Platform admins can suspend accounts (sessions revoked immediately), delete servers, and record NCMEC CyberTipline report numbers.
- Blocking hides a person's messages and stops them sending you direct messages.

## Your data
- **Download my data** gives a JSON copy of everything stored about you (no password hash).
- Sign-up requires agreeing that you're 13+ and to the Terms and Privacy Policy (`public/terms.html`, `public/privacy.html`; fill in the bracketed operator details before going public).

## Emergency access (server console)
If an admin is locked out, someone with root access to the server can run, from the hosting provider's console:

```
hearth-admin reset-password <username>   # prints a temporary password, signs out all devices
hearth-admin make-admin <username>
hearth-admin list-admins
hearth-admin unsuspend <username>
systemctl restart hearth                 # clears any login lockout
```

Every use is written to the admin log as "server-console".

## Server side
- Runs as an unprivileged `hearth` user, sandboxed by systemd so it can only write to its own data folder.
- Data folder is readable only by that user.
- Firewall allows only SSH, HTTP and HTTPS.

## Not done yet
- **HTTPS is required before real use.** Over plain `http://`, passwords travel unencrypted. Use only throwaway test passwords until HTTPS is on.
- **Email sending needs a provider** (and a domain with SPF/DKIM). Until `SMTP_*` is configured, verification and reset codes can't be delivered.
- Two-factor authentication (authenticator app codes).
- The master encryption key lives on the same server as the database; it protects copied database files, not a fully compromised server.
- Automated CSAM hash-matching (e.g. PhotoDNA) requires applying to the provider; reports are currently reviewed by people.
- Rate limits are per server node; a multi-node setup should share them.
