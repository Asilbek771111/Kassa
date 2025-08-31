// models.js
import Database from "better-sqlite3";
import fs from "fs-extra";

const DB_PATH = process.env.DB_PATH || "./db.sqlite";
await fs.ensureFile(DB_PATH);

const db = new Database(DB_PATH);

// users: id = telegram user id
db.prepare(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  balance INTEGER DEFAULT 0,
  secret_code TEXT
);
`).run();

// providers: ColdBet, boshqalar
db.prepare(`
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
`).run();

// requests: deposit/withdraw requests
db.prepare(`
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  provider_id TEXT,
  provider_name TEXT,
  type TEXT,          -- deposit | withdraw
  amount INTEGER,
  details TEXT,       -- JSON: { userGameId, checkFileId, pin, card, ... }
  status TEXT,        -- pending | approved | rejected | expired
  created_at TEXT,
  expires_at TEXT,
  resolved_at TEXT,
  admin_note TEXT
);
`).run();

export default db;
