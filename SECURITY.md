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

## Server side
- Runs as an unprivileged `hearth` user, sandboxed by systemd so it can only write to its own data folder.
- Data folder is readable only by that user.
- Firewall allows only SSH, HTTP and HTTPS.

## Not done yet
- **HTTPS is required before real use.** Over plain `http://`, passwords travel unencrypted. Use only throwaway test passwords until HTTPS is on.
- Two-factor authentication (authenticator app codes).
- Password reset by email (needs an email sender).
- Rate limits are per server node; a multi-node setup should share them.
