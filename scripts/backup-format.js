import crypto from 'node:crypto';

export const BACKUP_MAGIC = Buffer.from('DVBAK1');
export const HEADER_LENGTH = BACKUP_MAGIC.length + 16 + 12; // magic + salt + iv
export const TAG_LENGTH = 16;

// Slow key derivation, so guessing the passphrase of a stolen backup is expensive.
export const deriveBackupKey = (passphrase, salt) =>
  crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
