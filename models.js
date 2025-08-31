// models.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fs from "fs-extra";

const DB_PATH = process.env.DB_PATH || "./db.sqlite";
await fs.ensureFile(DB_PATH);

// sqlite3 ni promise asosida ishlatish
const db = await open({
  filename: DB_PATH,
  driver: sqlite3.Database,
});

// users: id = telegram user id
await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  balance INTEGER DEFAULT 0,
  secret_code TEXT
);
`);

// providers: ColdBet, boshqalar
await db.exec(`
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
`);

// requests: deposit/withdraw requests
await db.exec(`
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
`);

export default db;
