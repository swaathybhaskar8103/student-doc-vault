// Decrypts a backup into a new folder. It never touches the live data folder.
//   npm run restore-backup -- backups/docvault-2026-09-30-2130.dvbak [output-folder]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

import { BACKUP_MAGIC, HEADER_LENGTH, TAG_LENGTH, deriveBackupKey } from './backup-format.js';

const [file, outArg] = process.argv.slice(2);
if (!file) {
  console.error('Usage: npm run restore-backup -- <backup file> [output folder]');
  process.exit(1);
}
const passphrase = process.env.BACKUP_PASSPHRASE ?? '';
const outDir = path.resolve(outArg || `restored-${path.basename(file, '.dvbak')}`);
if (fs.existsSync(outDir)) {
  console.error(`${outDir} already exists. Choose another output folder.`);
  process.exit(1);
}

const size = fs.statSync(file).size;
const fd = fs.openSync(file, 'r');
const header = Buffer.alloc(HEADER_LENGTH);
const tag = Buffer.alloc(TAG_LENGTH);
fs.readSync(fd, header, 0, HEADER_LENGTH, 0);
fs.readSync(fd, tag, 0, TAG_LENGTH, size - TAG_LENGTH);
fs.closeSync(fd);
if (!header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
  console.error('This is not a DocVault backup file.');
  process.exit(1);
}
const salt = header.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + 16);
const iv = header.subarray(BACKUP_MAGIC.length + 16);
const decipher = crypto.createDecipheriv('aes-256-gcm', deriveBackupKey(passphrase, salt), iv);
decipher.setAuthTag(tag);

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const tar = spawn('tar', ['-xzf', '-', '-C', outDir], { stdio: ['pipe', 'inherit', 'pipe'] });
tar.stderr.resume(); // a wrong passphrase makes tar complain about garbage; we report it ourselves
const tarDone = new Promise((resolve, reject) =>
  tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error('tar could not unpack it')))));
tarDone.catch(() => {}); // awaited below; this stops an early tar exit from crashing the script

try {
  await Promise.all([
    pipeline(fs.createReadStream(file, { start: HEADER_LENGTH, end: size - TAG_LENGTH - 1 }), decipher, tar.stdin),
    tarDone,
  ]);
  console.log(`Backup decrypted and verified into ${outDir}`);
  console.log(`To restore: stop DocVault, move the current data/ folder aside, then move ${outDir} to data/.`);
  console.log('Start DocVault with the same MASTER_KEY that was used when the backup was made.');
} catch {
  fs.rmSync(outDir, { recursive: true, force: true });
  console.error('Could not restore: wrong BACKUP_PASSPHRASE, or the file is damaged or was tampered with.');
  process.exit(1);
}
