// Generates .env with fresh random secrets. Never overwrites an existing one:
// losing MASTER_KEY makes every stored document permanently unreadable.
import fs from 'node:fs';
import crypto from 'node:crypto';

const envPath = new URL('../.env', import.meta.url);
if (fs.existsSync(envPath)) {
  console.log('.env already exists; leaving it alone.');
  process.exit(0);
}
const secret = () => crypto.randomBytes(32).toString('hex');
fs.writeFileSync(
  envPath,
  `PORT=3000\nNODE_ENV=development\nMASTER_KEY=${secret()}\nSESSION_SECRET=${secret()}\n\n` +
    '# Email (Gmail): SMTP_USER = your Gmail address, SMTP_PASS = a 16-character App Password\n' +
    '# (Google Account > Security > 2-Step Verification > App passwords). Leave blank to print emails to the log.\n' +
    'SMTP_HOST=smtp.gmail.com\nSMTP_PORT=465\nSMTP_USER=\nSMTP_PASS=\nMAIL_FROM=\nAPP_URL=http://localhost:3000\n' +
    '\n# Local AI document check (Ollama on this computer; documents never leave it).\n' +
    'AI_ENABLED=true\nAI_MODEL=qwen2.5vl:7b\nOLLAMA_URL=http://127.0.0.1:11434\nAI_AUTO_DECISION=true\n' +
    '\n# Encrypts backups (npm run backup). Store a copy off the server with MASTER_KEY.\n' +
    `BACKUP_PASSPHRASE=${crypto.randomBytes(24).toString('base64url')}\nSTAFF_TWO_STEP=false\n` +
    '\n# Staff pages only open from these IP addresses/ranges (the college network). Empty = this computer\n' +
    '# and private networks (fine for testing). Online: the college\'s public IP (open ifconfig.me there).\n' +
    'STAFF_ALLOWED_NETWORKS=\n',
  { mode: 0o600 },
);
console.log('Created .env with new MASTER_KEY and SESSION_SECRET.');
console.log('Save MASTER_KEY and BACKUP_PASSPHRASE somewhere safe, off this computer: without them, files and backups cannot be decrypted.');
