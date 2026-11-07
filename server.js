const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Allow health checks / status text even when the DB is not configured yet.
app.get("/api/health", async (req, res) => {
  if (!DATABASE_URL) return res.status(503).json({ ok: false, error: "DATABASE_URL is not set in .env" });
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
}

const SCHEMA = `
create table if not exists suppliers (
  id text primary key,
  name text not null,
  tin text default '',
  type text not null,
  contact text default '',
  phone text default '',
  address text default '',
  products jsonb not null default '[]',
  notes text default '',
  status text not null default 'active',
  flag_note text default '',
  flag_date bigint default 0,
  created bigint not null,
  updated_at bigint not null default 0
);
create index if not exists suppliers_updated_at_idx on suppliers (updated_at);
`;

async function initDb() {
  if (!pool) return;
  await pool.query(SCHEMA);
}

// row -> client shape
const rowOut = r => ({
  id: r.id,
  name: r.name,
  tin: r.tin || "",
  type: r.type,
  contact: r.contact || "",
  phone: r.phone || "",
  address: r.address || "",
  products: Array.isArray(r.products) ? r.products : JSON.parse(r.products || "[]"),
  notes: r.notes || "",
  status: r.status || "active",
  flag_note: r.flag_note || "",
  flag_date: Number(r.flag_date) || 0,
  created: Number(r.created) || 0,
  updated_at: Number(r.updated_at) || 0,
});

const COLS = ["id", "name", "tin", "type", "contact", "phone", "address", "products", "notes", "status", "flag_note", "flag_date", "created", "updated_at"];

function toParams(s) {
  return [
    String(s.id || ""),
    String(s.name || ""),
    String(s.tin || ""),
    String(s.type || "Factory"),
    String(s.contact || ""),
    String(s.phone || ""),
    String(s.address || ""),
    JSON.stringify(Array.isArray(s.products) ? s.products : []),
    String(s.notes || ""),
    s.status === "no_answer" ? "no_answer" : "active",
    String(s.flag_note || ""),
    Number(s.flag_date) || 0,
    Number(s.created) || Date.now(),
    Number(s.updated_at) || Date.now(),
  ];
}

app.get("/api/suppliers", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL is not set in .env on the server" });
  try {
    const { rows } = await pool.query("select * from suppliers order by created desc");
    res.json(rows.map(rowOut));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/suppliers", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL is not set in .env on the server" });
  const items = Array.isArray(req.body) ? req.body : [req.body];
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const raw of items) {
        const s = toParams(raw);
        await client.query(
          `insert into suppliers (${COLS.join(",")}) values (${s.map((_, i) => "$" + (i + 1)).join(",")})
           on conflict (id) do update set
             name = excluded.name, tin = excluded.tin, type = excluded.type, contact = excluded.contact,
             phone = excluded.phone, address = excluded.address, products = excluded.products,
             notes = excluded.notes, status = excluded.status, flag_note = excluded.flag_note,
             flag_date = excluded.flag_date, updated_at = excluded.updated_at`,
          s
        );
      }
      await client.query("commit");
      res.json({ ok: true, count: items.length });
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/suppliers/:id", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL is not set in .env on the server" });
  try {
    const { rowCount } = await pool.query("delete from suppliers where id = $1", [req.params.id]);
    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  next();
});

(async () => {
  let dbReady = !!pool;
  try {
    await initDb();
    console.log("PostgreSQL schema ready.");
  } catch (e) {
    dbReady = false;
    console.warn("Could not initialize or reach the suppliers table:", e.message);
  }
  app.listen(PORT, () => {
    console.log(dbReady
      ? `Supplier Hub running → http://localhost:${PORT}  (PostgreSQL connected)`
      : `Supplier Hub running → http://localhost:${PORT}  (WARNING: PostgreSQL not connected — check DATABASE_URL in .env)`);
  });
})();
