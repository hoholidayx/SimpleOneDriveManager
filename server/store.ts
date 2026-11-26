import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { Account, UploadTask } from '../shared/types.js';

export interface Session { hash: string; csrf: string; accountId: string | null; expires: number }
export interface StoredUpload extends UploadTask { owner: string; uploadUrl?: string; itemId?: string; eTag?: string; conflict: 'fail' | 'replace' | 'rename' }
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class Store {
  private db: DatabaseSync;
  constructor(databasePath: string, private key: Buffer) {
    if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, accountId TEXT, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth (hash TEXT PRIMARY KEY, sessionHash TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_accounts (sessionHash TEXT NOT NULL, accountId TEXT NOT NULL, PRIMARY KEY (sessionHash, accountId));
    `);
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    this.db.prepare('DELETE FROM oauth WHERE expires < ?').run(Date.now());
    this.db.exec('DELETE FROM session_accounts WHERE sessionHash NOT IN (SELECT hash FROM sessions)');
    // Upgrade the previous single-account database without losing sessions or MSAL tokens.
    const legacy = this.get<Account>('account');
    if (legacy) {
      this.saveAccount(legacy);
      this.db.prepare('INSERT OR IGNORE INTO session_accounts SELECT hash, accountId FROM sessions WHERE accountId=?').run(legacy.id);
      this.delete('account');
    }
  }
  private seal(scope: string, value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  private open<T>(scope: string, value: string): T {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(scope));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as T;
  }
  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
    return row ? this.open<T>(key, row.value) : null;
  }
  set(key: string, value: unknown) { this.db.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?)').run(key, this.seal(key, value)); }
  delete(key: string) { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }
  getAccount(id: string) {
    const row = this.db.prepare('SELECT data FROM accounts WHERE id=?').get(id) as { data: string } | undefined;
    return row ? this.open<Account>(`account:${id}`, row.data) : null;
  }
  saveAccount(account: Account) {
    this.db.prepare('INSERT OR REPLACE INTO accounts VALUES (?, ?)').run(account.id, this.seal(`account:${account.id}`, account));
  }
  sessionAccounts(sessionHash: string) {
    const rows = this.db.prepare('SELECT a.id, a.data FROM accounts a JOIN session_accounts s ON s.accountId=a.id WHERE s.sessionHash=? ORDER BY a.rowid').all(sessionHash) as { id: string; data: string }[];
    return rows.map(row => this.open<Account>(`account:${row.id}`, row.data));
  }
  canAccess(sessionHash: string, accountId: string) {
    return !!this.db.prepare('SELECT 1 FROM session_accounts WHERE sessionHash=? AND accountId=?').get(sessionHash, accountId) && !!this.getAccount(accountId);
  }
  newSession(accountId: string | null = null, accounts: string[] = accountId ? [accountId] : []) {
    const token = randomBytes(32).toString('base64url');
    const session: Session = { hash: hash(token), csrf: randomBytes(32).toString('base64url'), accountId, expires: Date.now() + 7 * 86400_000 };
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(session.hash, session.csrf, accountId, session.expires);
    for (const id of new Set(accounts)) if (this.getAccount(id)) this.db.prepare('INSERT INTO session_accounts VALUES (?, ?)').run(session.hash, id);
    return { token, session };
  }
  getSession(token: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(hash(token), Date.now()) as unknown as Session | undefined;
    return row || null;
  }
  deleteSession(sessionHash: string) {
    this.db.prepare('DELETE FROM sessions WHERE hash=?').run(sessionHash);
    this.db.prepare('DELETE FROM session_accounts WHERE sessionHash=?').run(sessionHash);
    this.db.prepare('DELETE FROM oauth WHERE sessionHash=?').run(sessionHash);
  }
  saveOAuth(state: string, sessionHash: string, data: { verifier: string; nonce: string }) {
    this.db.prepare('DELETE FROM oauth WHERE expires < ?').run(Date.now());
    this.db.prepare('INSERT INTO oauth VALUES (?, ?, ?, ?)').run(hash(state), sessionHash, this.seal('oauth', data), Date.now() + 10 * 60_000);
  }
  consumeOAuth(state: string, sessionHash: string) {
    const row = this.db.prepare('SELECT data FROM oauth WHERE hash=? AND sessionHash=? AND expires>?').get(hash(state), sessionHash, Date.now()) as { data: string } | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM oauth WHERE hash=?').run(hash(state));
    return this.open<{ verifier: string; nonce: string }>('oauth', row.data);
  }
  saveUpload(task: StoredUpload) {
    this.db.prepare('INSERT OR REPLACE INTO uploads VALUES (?, ?)').run(task.id, this.seal(`upload:${task.id}`, task));
  }
  upload(id: string) {
    const row = this.db.prepare('SELECT data FROM uploads WHERE id=?').get(id) as { data: string } | undefined;
    return row ? this.open<StoredUpload>(`upload:${id}`, row.data) : null;
  }
  uploads(owner: string) {
    const rows = this.db.prepare('SELECT id,data FROM uploads').all() as { id: string; data: string }[];
    return rows.map(row => this.open<StoredUpload>(`upload:${row.id}`, row.data)).filter(task => task.owner === owner).sort((a, b) => b.createdAt - a.createdAt);
  }
  removeAccount(accountId: string) {
    this.db.exec('BEGIN');
    try {
      for (const task of this.uploads(accountId)) this.db.prepare('DELETE FROM uploads WHERE id=?').run(task.id);
      this.db.prepare('DELETE FROM oauth WHERE sessionHash IN (SELECT hash FROM sessions WHERE accountId=?)').run(accountId);
      this.db.prepare('UPDATE sessions SET accountId=NULL WHERE accountId=?').run(accountId);
      this.db.prepare('DELETE FROM session_accounts WHERE accountId=?').run(accountId);
      this.db.prepare('DELETE FROM accounts WHERE id=?').run(accountId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
