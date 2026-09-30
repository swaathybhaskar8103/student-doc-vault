// Holds the document encryption key (the "data key") in memory only.
//
// Two ways to provide it:
//  1. MASTER_KEY in .env (simple, but the key then sits on disk next to the files), or
//  2. data/master-key.json: the data key locked ("wrapped") with an unlock passphrase that only
//     college staff know. The server starts LOCKED; a staff member unlocks it at /unlock from the
//     college network and the key then exists only in memory until the next restart.
// Set up option 2 with: npm run protect-key
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './db.js';

export const KEY_FILE = path.join(DATA_DIR, 'master-key.json');
const KDF = { N: 2 ** 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }; // deliberately slow to guess
export const MIN_PASSPHRASE = 16;

let dataKey = null;

const envKey = Buffer.from(process.env.MASTER_KEY ?? '', 'hex');
if (envKey.length === 32) dataKey = envKey;
else if (process.env.MASTER_KEY) throw new Error('MASTER_KEY must be 64 hex characters.');
else if (!fs.existsSync(KEY_FILE)) throw new Error('No encryption key: set MASTER_KEY in .env (npm run setup) or create data/master-key.json (npm run protect-key).');

export const keyFileExists = () => fs.existsSync(KEY_FILE);
export const keyFromEnv = () => envKey.length === 32;
export const isUnlocked = () => dataKey !== null;

export function getDataKey() {
  if (!dataKey) {
    const err = new Error('DocVault is locked. A staff member must unlock it at /unlock.');
    err.locked = true;
    throw err;
  }
  return dataKey;
}

const deriveKek = (passphrase, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(passphrase, salt, 32, KDF, (err, key) => (err ? reject(err) : resolve(key))));

// Lock `key` with `passphrase` and write the key file.
export async function writeKeyFile(key, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', await deriveKek(passphrase, salt), iv);
  const wrapped = Buffer.concat([cipher.update(key), cipher.final()]);
  const file = { version: 1, kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p,
    salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), wrapped: wrapped.toString('hex') };
  const tmp = `${KEY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, KEY_FILE);
}

// Returns the data key if the passphrase is right, otherwise null. GCM makes a wrong passphrase detectable.
export async function openKeyFile(passphrase) {
  const f = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  const kek = await deriveKek(passphrase, Buffer.from(f.salt, 'hex'));
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(f.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(f.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(f.wrapped, 'hex')), decipher.final()]);
  } catch {
    return null;
  }
}

export async function unlock(passphrase) {
  if (dataKey) return true;
  const key = await openKeyFile(passphrase);
  if (!key) return false;
  dataKey = key;
  return true;
}
