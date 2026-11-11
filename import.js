const fs = require("fs");
const path = require("path");
const X = require("xlsx");
const { Pool } = require("pg");
require("dotenv").config();
if (!process.env.DATABASE_URL) require("dotenv").config({ path: path.join(__dirname, "render.env") });

const FILE = process.argv[2] || "C:/Users/Dell QTV1260/Downloads/Supplier_List - Copy.xlsx";
const PREFIX = {
  "Food Stuff": "FS",
  "Cleaning Materials": "CM",
  "Household Items": "HI",
  "Construction Materials": "CN",
  "Textile": "TX",
  "Plastic Products": "PP",
  "Stationery Materials": "SM",
};

function mapType(raw, notes) {
  const t = String(raw || "").toLowerCase().trim();
  if (t.includes("factory")) return "Factory";
  if (t.includes("import")) return "Importer";
  if (t.includes("agent")) return "Agent";
  if (t.includes("wholesale")) return "Wholesaler";
  if (t.includes("dealer") || t.includes("sales") || t.includes("individual")) { notes.push(`Original type on source list: ${String(raw).trim()}`); return "Agent"; }
  if (t) { notes.push(`Original type on source list: ${String(raw).trim()}`); return "Wholesaler"; }
  notes.push("Type not given on the source list");
  return "Wholesaler";
}

function cleanPhone(p, notes) {
  let s = String(p || "").trim();
  if (!s) return "";
  if (/not readable|unclear/i.test(s)) { notes.push(`Phone note from source: "${s}"`); return ""; }
  return s.replace(/\s*;\s*/g, "; ").replace(/\/\s*;/g, ";").replace(/\s*\/\s*$/, "").replace(/\s+;$/, "").trim();
}

(async () => {
  const wb = X.readFile(FILE);
  const rows = [];
  const seen = new Set();
  for (const sheetName of wb.SheetNames) {
    const prefix = PREFIX[sheetName];
    if (!prefix) { console.log("Skipping unknown sheet:", sheetName); continue; }
    const grid = X.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
    const hi = grid.findIndex(r => r && r.some(c => typeof c === "string" && c.includes("Supplier Name")));
    if (hi < 0) { console.log("No header in sheet:", sheetName); continue; }
    const head = grid[hi].map(c => String(c || "").trim());
    const col = name => head.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
    const cId = col("ID"), cName = col("Supplier Name"), cTin = col("TIN"), cProd = col("Category Products"), cContact = col("Contact Person"), cPhone = col("Phone"), cAddr = col("Address"), cType = col("Supplier Type"), cNotes = col("Notes");
    let n = 0;
    for (const r of grid.slice(hi + 1)) {
      const name = String(r[cName] || "").trim();
      if (!name) continue;
      n++;
      const notes = [];
      const productsDetail = String(r[cProd] || "").trim();
      const excelNotes = String(cNotes >= 0 ? r[cNotes] || "" : "").trim();
      const phone = cleanPhone(cPhone >= 0 ? r[cPhone] : "", notes);
      const type = mapType(cType >= 0 ? r[cType] : "", notes);
      const finalNotes = [productsDetail && "Supplies: " + productsDetail, excelNotes, ...notes].filter(Boolean).join(" — ");
      const excelId = cId >= 0 ? String(r[cId] || "").trim() : "";
      let base = `SUP-${prefix}-${String(excelId || n).padStart(3, "0")}`;
      let id = base, k = 2;
      while (seen.has(id)) id = `${base}-${k++}`;
      seen.add(id);
      rows.push({
        id,
        name, tin: String(cTin >= 0 ? r[cTin] || "" : "").trim(),
        type,
        contact: String(cContact >= 0 ? r[cContact] || "" : "").trim(),
        phone,
        address: String(cAddr >= 0 ? r[cAddr] || "" : "").trim(),
        products: [sheetName],
        notes: finalNotes,
        status: "active", flag_note: "", flag_date: 0,
        created: Date.now(), updated_at: Date.now(),
      });
    }
    console.log(`${sheetName}: ${n} suppliers`);
  }
  console.log("TOTAL:", rows.length);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
  const COLS = ["id", "name", "tin", "type", "contact", "phone", "address", "products", "notes", "status", "flag_note", "flag_date", "created", "updated_at"];
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const s of rows) {
      const v = [s.id, s.name, s.tin, s.type, s.contact, s.phone, s.address, JSON.stringify(s.products), s.notes, s.status, s.flag_note, s.flag_date, s.created, s.updated_at];
      await client.query(
        `insert into suppliers (${COLS.join(",")}) values (${v.map((_, i) => "$" + (i + 1)).join(",")})
         on conflict (id) do update set name=excluded.name, tin=excluded.tin, type=excluded.type, contact=excluded.contact,
           phone=excluded.phone, address=excluded.address, products=excluded.products, notes=excluded.notes,
           status=excluded.status, flag_note=excluded.flag_note, flag_date=excluded.flag_date, updated_at=excluded.updated_at`,
        v
      );
    }
    await client.query("commit");
    const { rows: cnt } = await client.query("select products->>0 as cat, count(*) from suppliers group by 1 order by 1");
    console.log("Imported OK. Category counts:");
    cnt.forEach(r => console.log(" ", r.cat, r.count));
    const { rows: tot } = await client.query("select count(*)::int as total from suppliers");
    console.log("DB TOTAL:", tot[0].total);
  } catch (e) {
    await client.query("rollback");
    console.error("FAILED, rolled back:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
