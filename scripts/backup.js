// Encrypted backup of everything DocVault stores: the database and the (already encrypted) document files.
//   npm run backup   ->  backups/docvault-2026-09-30-2130.dvbak
// The archive is encrypted with BACKUP_PASSPHRASE, so a leaked backup is useless on its own.
// Restoring also needs the document key: the unlock passphrase (npm run protect-key) or MASTER_KEY.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { backup } from 'node:sqlite';

import { db, DATA_DIR } from '../src/db.js';
import { BACKUP_MAGIC, deriveBackupKey } from './backup-format.js';

const passphrase = process.env.BACKUP_PASSPHRASE ?? '';
if (passphrase.length < 20) {
  console.error('BACKUP_PASSPHRASE must be set in .env (at least 20 characters). Run npm run setup to add one.');
  process.exit(1);
}
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(import.meta.dirname, '..', 'backups'));
const KEEP = Number(process.env.BACKUP_KEEP) || 7;
fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '');
const finalPath = path.join(BACKUP_DIR, `docvault-${stamp}.dvbak`);
const partialPath = `${finalPath}.partial`;
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'docvault-backup-'));

try {
  // A consistent copy of the live database, safe to take while the site is running.
  await backup(db, path.join(staging, 'vault.db'));

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveBackupKey(passphrase, salt), iv);
  // The passphrase-locked key file (if used) goes in too, so a restore only needs the unlock passphrase.
  const keyFile = fs.existsSync(path.join(DATA_DIR, 'master-key.json')) ? ['master-key.json'] : [];
  const tar = spawn('tar', ['-czf', '-', '-C', staging, 'vault.db', '-C', DATA_DIR, 'files', ...keyFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  const tarDone = new Promise((resolve, reject) =>
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`)))));
  tarDone.catch(() => {}); // awaited below; this stops an early tar exit from crashing the script

  // File layout: MAGIC | salt | iv | encrypted tar.gz | GCM tag
  await pipeline(
    tar.stdout,
    cipher,
    async function* (encrypted) {
      yield Buffer.concat([BACKUP_MAGIC, salt, iv]);
      for await (const chunk of encrypted) yield chunk;
      yield cipher.getAuthTag();
    },
    fs.createWriteStream(partialPath, { mode: 0o600 }),
  );
  await tarDone;
  fs.renameSync(partialPath, finalPath);

  // Keep only the newest KEEP backups.
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^docvault-.*\.dvbak$/.test(f)).sort().reverse().slice(KEEP);
  for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f));

  const mb = (fs.statSync(finalPath).size / 1048576).toFixed(1);
  console.log(`Backup written: ${finalPath} (${mb} MB)${old.length ? `, removed ${old.length} older` : ''}`);
  console.log('Copy it somewhere off this server. Restoring needs BACKUP_PASSPHRASE and MASTER_KEY.');
} catch (err) {
  fs.rmSync(partialPath, { force: true });
  console.error('Backup failed:', err.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
