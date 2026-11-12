const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const FILE = process.argv[2] || path.join(process.env.USERPROFILE, "Downloads", "Market Research 2019 - Copy.xlsx");
const OUT = path.join(__dirname, "..", "public", "market.json");

const wb = XLSX.readFile(FILE);
const researches = [];
const skipped = [];

const isZelalem = t => /ዘላለም|zelalem|zelalem redit|rediet/i.test(String(t || ""));
const num = v => {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/[^\d.\-]/g, ""));
  return isFinite(n) ? n : 0;
};
const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (!rows.length) { skipped.push(name + " (empty)"); continue; }

  // locate header row: contains NO/ተ.ቁ and item/የእቃው
  let hIdx = -1, cols = null;
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r].map(clean);
    const itemC = row.findIndex(c => /^(item|የእቃው አይነት)$/i.test(c));
    const noC = row.findIndex(c => /^(no|ተ\.?ቁ)$/i.test(c));
    if (itemC >= 0 && noC >= 0) {
      const find = re => row.findIndex(c => re.test(c) && !/selling|መሸጫ|margin|ማርጅን/i.test(c));
      cols = {
        item: itemC,
        supplier: row.findIndex(c => /supplier|ተወካይ|አቅራቢ/i.test(c) && !/selling/i.test(c)),
        brand: find(/brand|ብራንድ/i),
        unit: find(/unit|መለኪያ/i) >= 0 && row.findIndex(c => /^unit$|መለኪያ/i.test(c)) >= 0 ? row.findIndex(c => /^unit$|መለኪያ/i.test(c)) : find(/unit|መለኪያ/i),
        qty: find(/quantity|ብዛት/i),
        price: row.findIndex(c => /unit price|የአንዱ ዋጋ/i.test(c) && !/በፊት|before|selling|መሸጫ|b\.vat|b\s*vat/i.test(c)),
      };
      if (cols.supplier === itemC) cols.supplier = -1;
      if (cols.brand === itemC) cols.brand = -1;
      if (cols.unit === itemC) cols.unit = -1;
      if (cols.qty === itemC) cols.qty = -1;
      if (cols.price < 0) cols.price = row.findIndex(c => /የአንዱ ዋጋ ከ15% ጋር/i.test(c));
      hIdx = r;
      break;
    }
  }
  if (hIdx < 0 || cols.price < 0) { skipped.push(name); continue; }

  // client: first non-Zelalem text row above header
  let client = "";
  for (let r = 0; r < hIdx && !client; r++) {
    const c0 = clean(rows[r][0]);
    if (c0 && !isZelalem(c0)) client = c0;
  }
  if (!client) client = name;

  // date: row mentioning ቀን/Date
  let date = "";
  for (let r = 0; r < hIdx && !date; r++) {
    for (let c = 0; c < Math.min(rows[r].length, 6); c++) {
      const v = clean(rows[r][c]);
      if (/^(ቀን|date)/i.test(v) && v.length < 40) { date = v.replace(/^(ቀን|date)\s*[:\-]?/i, "").trim() || v; break; }
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v)) { date = v; break; }
    }
  }

  const items = [];
  let current = null;
  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const get = c => (c >= 0 ? clean(row[c]) : "");
    const item = get(cols.item);
    const price = num(row[cols.price]);
    const brand = get(cols.brand);
    const supplier = get(cols.supplier);
    const unit = get(cols.unit);
    const qty = num(row[cols.qty]);
    if (!item && !brand && !supplier && !price) continue;
    if (item) current = { item, supplier, brand, unit, qty, price };
    else if (current && (brand || supplier || price)) {
      current = { ...current, supplier: supplier || current.supplier, brand: brand || current.brand, unit: unit || current.unit, qty: qty || current.qty, price: price || current.price, item: current.item + "" };
    } else continue;
    if (current.price > 0) items.push({ ...current });
  }
  if (!items.length) { skipped.push(name + " (no items)"); continue; }
  researches.push({ client, date, sheet: clean(name), items });
}

researches.sort((a, b) => a.client.localeCompare(b.client, "am"));
const totalItems = researches.reduce((n, r) => n + r.items.length, 0);
fs.writeFileSync(OUT, JSON.stringify({ updatedAt: Date.now(), researches }, null, 0));
console.log("Sheets in workbook:", wb.SheetNames.length);
console.log("Researches parsed :", researches.length);
console.log("Total price rows  :", totalItems);
console.log("Skipped:", skipped.length, skipped.slice(0, 12).join(" | "));
const size = fs.statSync(OUT).size;
console.log("market.json:", (size / 1024).toFixed(0) + " KB");
