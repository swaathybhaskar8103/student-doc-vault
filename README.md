# DocVault: secure student document storage

Students upload their certificates (mark sheets, TC, masked Aadhaar…) once and download
soft copies any time, so they don't need to borrow the originals from the college for a photocopy.

## Set up on your own laptop

Works on **macOS** and **Windows** (Linux too). For the AI check, the laptop should have **16 GB of RAM**.

### 1. Install (once)

| What | Mac | Windows |
|---|---|---|
| **Git** | already installed (or `xcode-select --install`) | git-scm.com |
| **Node.js 24 LTS** or newer | nodejs.org | nodejs.org |
| **Ollama** (runs the AI on the laptop) | ollama.com | ollama.com |
| PDF support for the AI check | built in | Poppler for Windows, with its `bin` folder added to PATH (without it, PDFs simply wait for staff review) |
| `cloudflared` (only to share online) | `brew install cloudflared` | `winget install --id Cloudflare.cloudflared` |

### 2. Get the code

```bash
git clone https://github.com/swaathybhaskar8103/student-doc-vault.git
cd student-doc-vault
npm install
npm run setup                 # creates .env with new secret keys (only once!)
ollama pull qwen2.5vl:7b      # the AI model, about 6 GB
```

The repository is private: sign in to GitHub when `git clone` asks.

### 3. Email settings

Open `.env` in a text editor and fill in the Gmail account that sends DocVault emails
(an **app password** from myaccount.google.com/apppasswords, not the normal Gmail password):

```
SMTP_USER=vaultdoc7@gmail.com
SMTP_PASS=the16letterapppassword
MAIL_FROM=DocVault <vaultdoc7@gmail.com>
```

On a laptop with less than 16 GB of RAM, also set `AI_ENABLED=false` (staff then review every document).

### 4. Start it

```bash
npm start                     # http://localhost:3000 ; Ctrl+C stops it
```

- **Students:** http://localhost:3000
- **First staff account:** open http://localhost:3000/admin/login; the first time, it shows a setup page.
  After that, add other staff from the **Staff** page.
- **Online for others** (e.g. the viva): `npm run share` instead of `npm start`, then share the link it prints.

### 5. Keep safe

- `.env` holds the keys that decrypt every document. **Never upload or share it.** Keep a copy of
  `MASTER_KEY` and `BACKUP_PASSPHRASE` somewhere safe (e.g. a password manager).
- `npm run backup` makes an encrypted backup in `backups/`. Copy it somewhere off the laptop.
- To get code updates later: `git pull`, then start again.

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

## Share it online from this computer (free, no account)

```bash
npm run share      # prints a public https://….trycloudflare.com link; Ctrl+C stops sharing
```

Uses a free Cloudflare quick tunnel (`brew install cloudflared`). This computer stays the server: the site,
documents and AI all stay here, and it only works while the computer is on (the command keeps a Mac
awake). DocVault runs in online mode: secure cookies, and **staff pages only open on this computer**
(`http://localhost:3000/admin/login`); visitors through the link only get the student pages. The link
changes each time; a fixed name needs your own domain on a free Cloudflare account.

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

- **HTTPS is mandatory.** `npm run share` and the Oracle deploy both give HTTPS; online mode refuses to start without it.
- **Lock the key:** `npm run protect-key`, and keep the recovery key and `BACKUP_PASSPHRASE` off the server.
- **Aadhaar:** full Aadhaar cards are accepted (encrypted like every file). UIDAI guidance prefers masked
  Aadhaar; the college should decide which it needs.
- Set `STAFF_ALLOWED_NETWORKS` to the college office's own address if possible (see Known limitations).

## Ideas for next version

- Email verification at sign-up.
- "Verified by AI" shown separately from "Verified by college", with a staff spot-check filter.
- The AI says what it thinks a rejected document is ("this looks like a résumé").
- Watermark downloads ("Soft copy for <name>, <date>").
- Automatic deletion of documents some years after a student leaves (DPDP Act).
