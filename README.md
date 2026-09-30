# DocVault: secure student document storage

Students upload their certificates (mark sheets, TC, masked Aadhaar…) once and download
soft copies any time, so they don't need to borrow the originals from the college for a photocopy.

## Run it

```bash
npm install
npm run setup   # creates .env with random secret keys (only once!)
npm start       # http://localhost:3000
```

## How it works

1. **Register:** name, email, password → the site generates a random Student ID (e.g. `STU-B4HT-MWQS`).
2. **Upload:** choose the document type and a PDF/JPG/PNG (max 5 MB).
3. **Download:** log in with Student ID + password → download any document as a soft copy.

## College staff (admin panel)

There is no public staff sign-up (a student could otherwise approve their own documents). Instead:

- **First staff account:** open `http://localhost:3000/admin/login` on the server computer. While no staff
  exist, it shows a one-time setup page. It only works from the server itself and closes once an account exists.
- **More staff:** a logged-in staff member adds (or removes) colleagues on the **Staff** page, where they
  can also change their own password.
- **Locked out of every staff account?** On the server, run `npm run create-admin` to create one or reset a password.

Staff log in at `/admin/login` (linked at the bottom of the student login page) and can:
- see the **review queue** (Pending / Verified / Rejected / All), searchable by student name, ID or email
- open a document and mark it **Verified** or **Rejected** (a reason is required when rejecting)
- browse all students and their documents

Students see a status badge on each document, get an email for every decision, and see
"Opened by college staff" in their activity log whenever staff open one of their files.

## AI document check (runs on your own server)

Every upload gets a first-pass check from a vision AI model running **locally** in
[Ollama](https://ollama.com). Documents never leave the server: the file is decrypted in memory,
turned into an image in a private temp folder (deleted straight after), and sent only to Ollama on
`127.0.0.1`.

The model reads the document; plain code then decides:

| Result | When |
|---|---|
| ❌ Problem found | Unreadable (blurry, cut off, dark) or wrong type for what the student chose |
| ⚠️ Needs a look | Name on the document doesn't match the account name, no name found, or type unclear |
| ✅ Looks good | Readable, right type, the student's own name |

With `AI_AUTO_DECISION=true` the AI's result **is** the decision: ✅ looks good → **Verified**,
❌ problem → **Rejected** (the student is emailed the reason and uploads a new copy). Only ⚠️ "needs a
look" cases (e.g. a name mismatch) wait for staff, who can also override any decision. With
`AI_AUTO_DECISION=false`, every document waits for staff, who see flagged ones first and can verify
all AI-passed documents in one step.

Note for the report: an AI can be fooled by a convincing fake, so auto-approval means no person
checks the approved documents. Staff can spot-check verified documents in the review queue.

Setup:

```bash
ollama pull qwen2.5vl:7b      # ~6 GB, Apache 2.0 licence, free
```

`.env` settings:

```
AI_ENABLED=true
AI_MODEL=qwen2.5vl:7b          # college server with 32 GB+: qwen2.5vl:32b for better accuracy
AI_AUTO_DECISION=true          # AI verifies/rejects by itself; false = staff decide
OLLAMA_URL=http://127.0.0.1:11434
```

PDFs are converted with `pdftoppm` (install `poppler` on Linux) or macOS's built-in `sips`.
If Ollama is off or the model isn't downloaded, uploads still work and wait in the queue until it's back.

## Keeping the documents private

**Staff pages only open from the college network.** Set `STAFF_ALLOWED_NETWORKS` in `.env` to the college's
public IP address (open ifconfig.me on the college Wi-Fi), e.g. `STAFF_ALLOWED_NETWORKS=203.0.113.10`.
Every `/admin` page, including the login, returns "Staff pages can only be opened from the college network"
anywhere else, so a leaked staff password is useless from outside. Students can use the site from anywhere.
Online mode refuses to start without this setting.

**The encryption key is not stored on the disk.** Run once:

```bash
npm run protect-key                 # lock the key with an unlock passphrase (16+ characters)
npm run protect-key -- --change     # change the passphrase later
```

It shows a **recovery key once**: print it and keep it locked away (e.g. the principal's safe). After
this, DocVault starts **locked** after every restart: students see "starting up", and a staff member opens
`/unlock` from the college network and types the passphrase. The key then lives only in memory. Every
unlock is emailed to all staff. If the passphrase is lost, put the recovery key back in `.env` as
`MASTER_KEY=...`.

## Backups

```bash
npm run backup                                   # -> backups/docvault-<date>.dvbak (encrypted)
npm run restore-backup -- backups/<file>.dvbak   # decrypts into a new folder, never touches live data
```

Backups contain the database and the (already encrypted) document files, encrypted again with
`BACKUP_PASSPHRASE`. The newest 7 are kept. On the server a daily backup runs at 02:30.
Copy backups off the server. **Store `MASTER_KEY` and `BACKUP_PASSPHRASE` somewhere safe, off the
server**: without them nothing can be decrypted.

## Put it online (Oracle Cloud free server)

1. **Server:** Oracle Cloud → Compute → Create instance → image **Ubuntu 24.04**, shape
   **VM.Standard.A1.Flex (Ampere ARM), 4 OCPU / 24 GB** (Always Free). Download the SSH private key.
2. **Open web ports:** Networking → your VCN → Security List → add ingress rules for TCP **80** and **443**
   from `0.0.0.0/0`.
3. **Free domain:** at duckdns.org create e.g. `docvault-yourname` and point it at the server's public IP.
4. **Deploy from your Mac** (project folder):
   ```bash
   chmod 600 ~/Downloads/ssh-key-*.key
   bash deploy/push.sh ubuntu@SERVER_IP ~/Downloads/ssh-key-*.key
   ```
   It installs updates, firewall, fail2ban, Node.js, Ollama + the AI model, Caddy (HTTPS), creates the
   `.env` with new secrets, starts DocVault and the daily backup, and asks for the first staff account.
5. Run the same command again any time to **update** the code; data, settings and accounts are kept.

Useful on the server: `sudo systemctl status docvault`, `sudo journalctl -u docvault -f`,
`sudo systemctl list-timers docvault-backup.timer`.

## Security measures

| Threat | Protection |
|---|---|
| Someone guesses/knows a Student ID | Login needs ID **and** password. IDs are random, not sequential |
| Password guessing | 5 wrong tries locks the account for 15 min; 20 attempts per IP per 15 min |
| Stolen database | Passwords hashed with scrypt + salt; never stored in plain text |
| Stolen server disk / backup | Every file encrypted with AES-256-GCM before being written. The only decrypted copy is a few-second temp file during the AI check, kept in memory (`/dev/shm`) on Linux and cleaned up at startup. With `protect-key` the key itself is not on the disk either |
| Student A opening Student B's file | Every download query checks `student_id` = logged-in student |
| File tampered with on disk | GCM authentication tag detects it; download is refused |
| Malicious upload (script renamed .pdf) | File type checked from its actual bytes, not its name |
| Forged form submissions (CSRF) | Secret token on every form + `SameSite=Strict` cookies |
| XSS | All output HTML-escaped; strict Content-Security-Policy via Helmet |
| Session hijack / shared PCs | HttpOnly cookies, new session ID on login, 15-min idle logout, `no-store` caching |
| Unnoticed misuse | Activity log (logins, failed attempts, uploads, downloads) shown to the student |
| Stolen staff password | Staff pages only open from the college network (`STAFF_ALLOWED_NETWORKS`). Weak staff passwords (under 12 characters) must be changed before anything else. Optional two-step login (`STAFF_TWO_STEP=true`) emails a 6-digit code after the password; best when each staff member has their own account |
| Right to erasure (DPDP Act) | Students can permanently delete their account and every document |
| Server lost or broken | Daily encrypted backups; restore is verified by GCM authentication |
| Unsafe online settings | Production mode refuses to start without an https `APP_URL` and email; app listens on 127.0.0.1 behind Caddy |
| Leaked Aadhaar numbers | Full Aadhaar cards are accepted but stored encrypted like every file; the AI's notes keep only the last 4 digits |

## Known limitations

- **The AI check can be fooled.** With `AI_AUTO_DECISION=true`, a convincing fake certificate (or an image
  with misleading text) may be verified without a person looking at it. Staff can still open and override
  any verified document from the review queue.
- **"College network" is only as narrow as the college's IP address.** If students on campus Wi-Fi share the
  office's public IP, they can reach the staff login page, where a shared staff password (two-step login
  off) is the only protection; five wrong tries also lock the staff account for 15 minutes. Using the
  office's own network/VPN address, or individual staff accounts with `STAFF_TWO_STEP=true`, closes this.
- **Email isn't verified at sign-up**, so someone could register with another person's email address.

## Before going live (important)

- **HTTPS is mandatory.** Deploy behind HTTPS and set `NODE_ENV=production` in `.env`.
- **Back up `MASTER_KEY`** separately from the data. If it's lost, no file can ever be decrypted.
  If it leaks together with the `data/` folder, the encryption is useless.
- **Aadhaar:** store only the *masked* Aadhaar (last 4 digits visible). Storing full Aadhaar numbers
  is restricted under the Aadhaar Act / UIDAI rules.
- Sessions live in memory: restarting the server logs everyone out. Fine for a demo.

## Ideas for next version

- Password reset via email OTP (currently a forgotten password can't be recovered).
- Two-factor login (OTP to email/phone).
- Watermark downloads ("Soft copy for <name>, <date>").
