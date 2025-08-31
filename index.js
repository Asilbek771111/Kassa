// index.js
import 'dotenv/config';
import { Telegraf, Markup, session } from "telegraf";
import fs from "fs-extra";
import db from "./models.js"; // models.js should export an opened sqlite db via `open(...)`
import { customAlphabet } from "nanoid";
import { createObjectCsvWriter } from "csv-writer";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .env");
  process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

// Config from .env
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const CHANNEL_ID = process.env.CHANNEL_ID || "";
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "").replace(/^@/, "");
const MIN_DEPOSIT = parseInt(process.env.MIN_DEPOSIT || "5000", 10);
const CHECK_TIMEOUT_MIN = parseInt(process.env.CHECK_TIMEOUT_MIN || "5", 10);
const PAYMENT_CARDS = (process.env.PAYMENT_CARDS || "").split(",").map(s=>s.trim()).filter(Boolean);

// helpers
const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);
function isAdmin(userId) { return ADMIN_IDS.includes(String(userId)); }
function nowISO() { return new Date().toISOString(); }

// secret code generator: 4 chars, A-Z0-9
function generateSecretCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}
function validateSecretCode(code) {
  return /^[A-Z0-9]{4}$/.test(code);
}

// session
bot.use(session({ defaultSession: () => ({ flow: null, data: {}, adminMode: null }) }));

// --- Database helper functions (async) ---

// ensure default provider exists
async function ensureDefaultProvider() {
  const row = await db.get("SELECT COUNT(*) as c FROM providers");
  if (!row || row.c === 0) {
    await db.run("INSERT OR IGNORE INTO providers (id,name) VALUES (?,?)", "coldbet", "ColdBet");
  }
}
await ensureDefaultProvider();

// list providers
async function listProviders() {
  return await db.all("SELECT id,name FROM providers ORDER BY name");
}

// create request (returns row)
async function createRequest(req) {
  const id = req.id || nanoid();
  const created_at = nowISO();
  const expires_at = req.expires_at || null;
  const detailsStr = JSON.stringify(req.details || {});
  await db.run(
    `INSERT INTO requests (id,user_id,provider_id,provider_name,type,amount,details,status,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, req.user_id, req.provider_id, req.provider_name, req.type, req.amount || null, detailsStr, req.status || "pending", created_at, expires_at
  );
  const row = await db.get("SELECT * FROM requests WHERE id=?", id);
  if (row) row.details = safeParse(row.details);
  return row;
}

// update request status
async function updateRequestStatus(id, status, admin_note = null) {
  const resolved_at = nowISO();
  await db.run("UPDATE requests SET status=?, resolved_at=?, admin_note=? WHERE id=?", status, resolved_at, admin_note, id);
  const row = await db.get("SELECT * FROM requests WHERE id=?", id);
  if (row) row.details = safeParse(row.details);
  return row;
}

// get request by id
async function getRequest(id) {
  const r = await db.get("SELECT * FROM requests WHERE id=?", id);
  if (!r) return null;
  r.details = safeParse(r.details);
  return r;
}

// ensure user exists
async function ensureUser(user) {
  const row = await db.get("SELECT id, username, balance, secret_code FROM users WHERE id=?", user.id);
  if (!row) {
    const code = generateSecretCode();
    await db.run("INSERT INTO users (id, username, balance, secret_code) VALUES (?,?,?,?)", user.id, user.username || null, 0, code);
    return { id: user.id, username: user.username, balance: 0, secret_code: code };
  }
  return row;
}

// safe JSON parse
function safeParse(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    console.warn("safeParse failed:", e.message);
    return {};
  }
}

// --- Keyboards & small utils ---
function mainMenuKeyboard() {
  return Markup.keyboard([
    ["Hisobni to‘ldirish", "Hisobdan yechish"],
    ["Aloqa", "Mening kodim"]
  ]).resize();
}

// check subscription (best-effort; if channel not available, skip)
async function ensureSubscribed(ctx) {
  if (!CHANNEL_ID) return true;
  try {
    const member = await ctx.telegram.getChatMember(CHANNEL_ID, ctx.from.id);
    if (["creator","administrator","member"].includes(member.status)) return true;
  } catch (e) {
    console.warn("Channel check failed:", e.message);
    return true;
  }
  await ctx.reply("Avval kanalga a’zo bo‘ling, so‘ng davom etamiz.", Markup.inlineKeyboard([
    [Markup.button.url("Kanalga obuna bo‘lish", `https://t.me/${String(CHANNEL_ID).replace("@","")}`)],
    [Markup.button.callback("Tekshirish ✅", "check_sub")]
  ]));
  return false;
}

// --- Bot actions & handlers ---

bot.action("check_sub", async (ctx) => {
  try { await ctx.answerCbQuery() } catch {}
  if (await ensureSubscribed(ctx)) {
    try { await ctx.editMessageText("Rahmat! Endi menyuga qaytishingiz mumkin."); } catch {}
    await ctx.reply("Buyruqni tanlang:", mainMenuKeyboard());
  }
});

// START
bot.start(async (ctx) => {
  await ensureUser(ctx.from);
  if (!(await ensureSubscribed(ctx))) return;
  await ctx.reply("Assalomu alaykum! MobCash botiga xush kelibsiz. Buyruqni tanlang:", mainMenuKeyboard());
});

// Mening kodim (foydalanuvchiga berilgan 4 belgili kodni ko'rsatish)
bot.hears("Mening kodim", async (ctx) => {
  const user = await ensureUser(ctx.from);
  await ctx.reply(`Sizning maxfiy kodingiz: ${user.secret_code}\nIltimos uni hech kimga bermang.`);
});

// Aloqa
bot.hears("Aloqa", async (ctx) => {
  const at = ADMIN_USERNAME ? `@${ADMIN_USERNAME}` : (ADMIN_IDS[0] || "admin");
  await ctx.reply(`Admin bilan aloqa: ${at}\nSavollar bo‘lsa yozing.`);
});

// Hisobni to'ldirish
bot.hears("Hisobni to‘ldirish", async (ctx) => {
  if (!(await ensureSubscribed(ctx))) return;
  const provs = await listProviders();
  if (provs.length === 0) return ctx.reply("Hozircha provayderlar mavjud emas.");
  ctx.session.flow = "deposit";
  ctx.session.data = {};
  const buttons = provs.map(p => Markup.button.callback(p.name, `prov:${p.id}`));
  await ctx.reply("Qaysi platforma uchun to‘ldirmoqchisiz?", Markup.inlineKeyboard(buttons, { columns: 1 }));
});

// Hisobdan yechish
bot.hears("Hisobdan yechish", async (ctx) => {
  if (!(await ensureSubscribed(ctx))) return;
  const provs = await listProviders();
  if (provs.length === 0) return ctx.reply("Hozircha provayderlar mavjud emas.");
  ctx.session.flow = "withdraw";
  ctx.session.data = {};
  const buttons = provs.map(p => Markup.button.callback(p.name, `prov:${p.id}`));
  await ctx.reply("Qaysi platformadan yechmoqchisiz?", Markup.inlineKeyboard(buttons, { columns: 1 }));
});

// provider selected
bot.action(/^prov:(.+)$/i, async (ctx) => {
  try { await ctx.answerCbQuery() } catch {}
  const pid = ctx.match[1];
  let prov = await db.get("SELECT id,name FROM providers WHERE id=?", pid);
  if (!prov) prov = await db.get("SELECT id,name FROM providers WHERE name=?", pid);
  if (!prov) return ctx.reply("Topilmadi. Qaytadan tanlang.");
  ctx.session.data.providerId = prov.id;
  ctx.session.data.providerName = prov.name;

  if (ctx.session.flow === "deposit") {
    ctx.session.data.step = "deposit_userid";
    return ctx.reply(`${prov.name} ID raqamingizni kiriting:`);
  } else if (ctx.session.flow === "withdraw") {
    ctx.session.data.step = "withdraw_userid";
    return ctx.reply(`${prov.name} ID raqamingizni kiriting:`);
  } else {
    return ctx.reply("Iltimos, menyudan amal tanlang.");
  }
});

// text messages handler
bot.on("text", async (ctx, next) => {
  const s = ctx.session;
  const t = ctx.message.text?.trim();
  if (!s || !s.data) return next();

  // Admin mode inputs
  if (isAdmin(ctx.from.id) && s.adminMode) {
    const mode = s.adminMode;
    const val = t;
    if (mode === "add_provider") {
      const id = val.toLowerCase().replace(/[^a-z0-9]+/g, "") || "prov" + Math.floor(Math.random() * 10000);
      await db.run("INSERT OR IGNORE INTO providers (id,name) VALUES (?,?)", id, val);
      s.adminMode = null;
      return ctx.reply(`Provider qo'shildi: ${val} (${id})`);
    }
    if (mode === "remove_provider") {
      const key = val.toLowerCase();
      await db.run("DELETE FROM providers WHERE id=? OR lower(name)=lower(?)", key, key);
      s.adminMode = null;
      return ctx.reply("Provider o'chirildi yoki topilmadi.");
    }
    return;
  }

  // DEPOSIT flow
  if (s.flow === "deposit") {
    if (s.data.step === "deposit_userid") {
      s.data.userGameId = t;
      s.data.step = "deposit_amount";
      return ctx.reply(`Qancha to‘ldirmoqchisiz? (min ${MIN_DEPOSIT} UZS)`);
    }
    if (s.data.step === "deposit_amount") {
      const amount = parseInt(t, 10);
      if (isNaN(amount) || amount < MIN_DEPOSIT) return ctx.reply(`Iltimos, to‘g‘ri summa kiriting (kamida ${MIN_DEPOSIT} UZS).`);
      s.data.amount = amount;
      const cards = PAYMENT_CARDS.length ? PAYMENT_CARDS.join(" | ") : "Karta raqamlari hozircha sozlanmagan";
      s.data.step = "deposit_wait_check";
      const expiresAt = new Date(Date.now() + CHECK_TIMEOUT_MIN * 60000).toISOString();
      s.data.expiresAt = expiresAt;
      await ctx.reply(`Karta raqamlari: ${cards}\n\n${amount} UZS summani ${CHECK_TIMEOUT_MIN} daqiqa ichida o‘tkazing va chekni rasm qilib yuboring.`, Markup.inlineKeyboard([[Markup.button.callback("Bekor qilish", "cancel_flow")]]));
      return;
    }
  }

  // WITHDRAW flow
  if (s.flow === "withdraw") {
    if (s.data.step === "withdraw_userid") {
      s.data.userGameId = t;
      s.data.step = "withdraw_code";
      return ctx.reply("4 belgili maxfiy kodingizni kiriting (harf+raqam, masalan A9K3):");
    }
    if (s.data.step === "withdraw_code") {
      const code = t.toUpperCase();
      if (!validateSecretCode(code)) return ctx.reply("Noto‘g‘ri format. Iltimos 4 belgili harf yoki raqam kombinatsiyasini kiriting (masalan A9K3).");
      s.data.code = code;
      s.data.step = "withdraw_card";
      return ctx.reply("Qabul qiluvchi karta raqamingizni kiriting (12-20 raqam):");
    }
    if (s.data.step === "withdraw_card") {
      const card = t.replace(/\s+/g, "");
      if (!/^\d{12,20}$/.test(card)) return ctx.reply("Karta raqami noto‘g‘ri. 12-20 raqam bo‘lishi kerak.");
      s.data.card = card;

      // create withdraw request (store)
      const reqId = nanoid();
      await createRequest({
        id: reqId,
        user_id: ctx.from.id,
        provider_id: s.data.providerId,
        provider_name: s.data.providerName,
        type: "withdraw",
        amount: null,
        details: { userGameId: s.data.userGameId, code: s.data.code, card: s.data.card },
        status: "pending"
      });

      // notify admins
      const adminText = `🟡 Yangi YECHISH so‘rovi\nID: ${reqId}\nUser: ${ctx.from.id}\nProvider: ${s.data.providerName}\nGameID: ${s.data.userGameId}\nCode: ${s.data.code}\nCard: ${s.data.card}`;
      for (const admin of ADMIN_IDS) {
        await bot.telegram.sendMessage(admin, adminText, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Tasdiqlash ✅", callback_data: `admin:approve:${reqId}` }, { text: "Bekor qilish ❌", callback_data: `admin:reject:${reqId}` }]
            ]
          }
        });
      }

      s.flow = null; s.data = {};
      return ctx.reply("So‘rovingiz qabul qilindi. Tez orada admin ko‘rib chiqadi.");
    }
  }

  return next();
});

// photo handler — for deposit checks
bot.on("photo", async (ctx) => {
  const s = ctx.session;
  if (!(s && s.flow === "deposit" && s.data.step === "deposit_wait_check")) return;

  const fileId = ctx.message.photo.at(-1).file_id;
  const reqId = nanoid();
  const expiresAt = s.data.expiresAt || new Date(Date.now() + CHECK_TIMEOUT_MIN * 60000).toISOString();

  await createRequest({
    id: reqId,
    user_id: ctx.from.id,
    provider_id: s.data.providerId,
    provider_name: s.data.providerName,
    type: "deposit",
    amount: s.data.amount,
    details: { userGameId: s.data.userGameId, checkFileId: fileId },
    status: "pending",
    expires_at: expiresAt
  });

  // notify admins with photo
  const adminText = `🟡 Yangi TO'LDIRISH so‘rovi\nID: ${reqId}\nUser: ${ctx.from.id}\nProvider: ${s.data.providerName}\nGameID: ${s.data.userGameId}\nSumma: ${s.data.amount || 0} UZS`;
  for (const admin of ADMIN_IDS) {
    await bot.telegram.sendPhoto(admin, fileId, {
      caption: adminText,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Tasdiqlash ✅", callback_data: `admin:approve:${reqId}` }, { text: "Bekor qilish ❌", callback_data: `admin:reject:${reqId}` }]
        ]
      }
    });
  }

  s.flow = null; s.data = {};
  await ctx.reply("Chek qabul qilindi. Admin tekshiradi va tasdiqlaydi.");
});

// cancel
bot.action("cancel_flow", async (ctx) => {
  try { await ctx.answerCbQuery("Bekor qilindi"); } catch {}
  ctx.session.flow = null; ctx.session.data = {};
  try { await ctx.editMessageText("Amal bekor qilindi."); } catch {}
});

// Admin approve/reject
bot.action(/^admin:(approve|reject):([A-Z0-9]{8})$/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  if (!isAdmin(ctx.from.id)) return ctx.reply("Faqat adminlar uchun.");
  const action = ctx.match[1];
  const id = ctx.match[2];
  const req = await getRequest(id);
  if (!req) return ctx.reply("So‘rov topilmadi.");
  if (req.status !== "pending") return ctx.reply("Bu so‘rov allaqachon ko‘rilgan.");

  if (action === "approve") {
    await updateRequestStatus(id, "approved", `Manually approved by ${ctx.from.id}`);

    // If deposit — credit user balance
    if (req.type === "deposit") {
      const details = safeParse(req.details);
      const amount = req.amount || (details.amount || 0);
      if (amount && amount > 0) {
        const userRow = await db.get("SELECT balance FROM users WHERE id=?", req.user_id);
        if (userRow) {
          await db.run("UPDATE users SET balance = ? WHERE id = ?", (userRow.balance || 0) + amount, req.user_id);
        }
        try {
          await bot.telegram.sendMessage(req.user_id, `✅ Hisobingizga ${amount} UZS tushdi. Provider: ${req.provider_name}`);
        } catch {}
      } else {
        try {
          await bot.telegram.sendMessage(req.user_id, `✅ To'ldirish tasdiqlandi. Provider: ${req.provider_name}`);
        } catch {}
      }
    } else if (req.type === "withdraw") {
      // notify user
      try {
        await bot.telegram.sendMessage(req.user_id, `✅ Pul kartangizga o‘tkazildi. (Admin tomonidan tasdiqlandi)`);
      } catch {}
    }

    // Update admin message (edit text only)
    try { await ctx.editMessageText(`✔️ Tasdiqlandi\nID: ${id}`); } catch {}

  } else {
    await updateRequestStatus(id, "rejected", `Rejected by ${ctx.from.id}`);
    try {
      await bot.telegram.sendMessage(req.user_id, `❌ Operatsiya bekor qilindi. Iltimos admin bilan bog'laning: @${ADMIN_USERNAME || ADMIN_IDS[0]}`);
    } catch {}
    try { await ctx.editMessageText(`❌ Bekor qilindi\nID: ${id}`); } catch {}
  }
});

// Admin commands and panel
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Faqat adminlar uchun.");
  await ctx.reply("Admin paneli:", Markup.inlineKeyboard([
    [Markup.button.callback("➕ Provider qo‘shish", "ap:add"), Markup.button.callback("➖ Provider o‘chirish", "ap:remove")],
    [Markup.button.callback("📃 Providerlar ro‘yxati", "ap:list"), Markup.button.callback("🕒 Kutilayotgan so‘rovlar", "ap:pending")],
    [Markup.button.callback("📊 Statistika", "ap:stats"), Markup.button.callback("⬇️ Export CSV", "ap:export")]
  ]));
});

bot.action("ap:list", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  if (!isAdmin(ctx.from.id)) return;
  const rows = await listProviders();
  if (!rows.length) return ctx.reply("Hech narsa yo'q.");
  const txt = rows.map(r => `• ${r.name} (${r.id})`).join("\n");
  await ctx.reply("Providerlar:\n" + txt);
});
bot.action("ap:add", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  if (!isAdmin(ctx.from.id)) return;
  ctx.session.adminMode = "add_provider";
  await ctx.reply("Yangi provider nomini kiriting (masalan ColdBet):");
});
bot.action("ap:remove", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  if (!isAdmin(ctx.from.id)) return;
  ctx.session.adminMode = "remove_provider";
  await ctx.reply("O'chirmoqchi bo'lgan provider id yoki nomini kiriting:");
});

bot.action("ap:pending", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  if (!isAdmin(ctx.from.id)) return;
  const pend = await db.all("SELECT * FROM requests WHERE status='pending' ORDER BY created_at DESC");
  if (!pend.length) return ctx.reply("Kutilayotgan so'rovlar yo'q.");
  for (const r of pend) {
    const details = safeParse(r.details);
    if (r.type === "deposit" && details.checkFileId) {
      await bot.telegram.sendPhoto(ctx.from.id, details.checkFileId, {
        caption: `ID:${r.id}\nUser:${r.user_id}\nProv:${r.provider_name}\nSum:${r.amount || (details.amount||0)} UZS`,
        reply_markup: { inline_keyboard: [[{ text: "Tasdiqlash ✅", callback_data: `admin:approve:${r.id}` }, { text: "Bekor qilish ❌", callback_data: `admin:reject:${r.id}` }]] }
      });
    } else {
      await bot.telegram.sendMessage(ctx.from.id, `ID:${r.id}\nUser:${r.user_id}\nProv:${r.provider_name}\nType:${r.type}`, {
        reply_markup: { inline_keyboard: [[{ text: "Tasdiqlash ✅", callback_data: `admin:approve:${r.id}` }, { text: "Bekor qilish ❌", callback_data: `admin:reject:${r.id}` }]] }
      });
    }
  }
});

bot.action("ap:stats", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  if (!isAdmin(ctx.from.id)) return;
  const totalRow = await db.get("SELECT COUNT(*) as c FROM requests");
  const pendingRow = await db.get("SELECT COUNT(*) as c FROM requests WHERE status='pending'");
  const approvedRow = await db.get("SELECT SUM(amount) as s FROM requests WHERE status='approved' AND type='deposit'");
  const total = totalRow?.c || 0;
  const pending = pendingRow?.c || 0;
  const approvedDeposits = approvedRow?.s || 0;
  await ctx.reply(`Statistika:\nUmumiy so'rovlar: ${total}\nKutilayotgan: ${pending}\nTasdiqlangan deposit summasi: ${approvedDeposits} UZS`);
});

bot.action("ap:export", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  if (!isAdmin(ctx.from.id)) return;
  const rows = await db.all("SELECT id,user_id,provider_name,type,amount,status,created_at,resolved_at FROM requests ORDER BY created_at DESC");
  const csvPath = "./requests_export.csv";
  const csvWriter = createObjectCsvWriter({
    path: csvPath,
    header: [
      { id: "id", title: "id" },
      { id: "user_id", title: "user_id" },
      { id: "provider_name", title: "provider_name" },
      { id: "type", title: "type" },
      { id: "amount", title: "amount" },
      { id: "status", title: "status" },
      { id: "created_at", title: "created_at" },
      { id: "resolved_at", title: "resolved_at" }
    ]
  });
  await csvWriter.writeRecords(rows);
  await ctx.reply("Export tayyor.");
  await ctx.replyWithDocument({ source: csvPath });
});

// Background: expire pending deposits after timeout
setInterval(() => {
  (async () => {
    try {
      const now = new Date().toISOString();
      const pend = await db.all("SELECT * FROM requests WHERE status='pending' AND expires_at IS NOT NULL");
      for (const r of pend) {
        if (r.expires_at && r.expires_at <= now) {
          await db.run("UPDATE requests SET status='expired', resolved_at=? WHERE id=?", now, r.id);
          try { await bot.telegram.sendMessage(r.user_id, "⏳ Chek vaqti tugadi. Iltimos qayta urinib ko‘ring yoki admin bilan bog‘laning."); } catch {}
          for (const a of ADMIN_IDS) {
            try { await bot.telegram.sendMessage(a, `So'rov ID:${r.id} muddati tugadi va expired holatiga o'tdi.`); } catch {}
          }
        }
      }
    } catch (e) {
      console.warn("Expire loop error:", e.message);
    }
  })();
}, 60 * 1000);

// Help
bot.command("help", async (ctx) => {
  await ctx.reply("Menyu:\n- Hisobni to‘ldirish\n- Hisobdan yechish\n- Aloqa\n- Mening kodim\n\nAdminlar uchun: /admin");
});

// Error handler
bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  try { ctx.reply("Xatolik yuz berdi. Iltimos keyinroq urinib ko‘ring."); } catch {}
});

bot.launch().then(()=>console.log("Bot started")).catch(console.error);
