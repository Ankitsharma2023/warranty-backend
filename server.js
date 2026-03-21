// ═══════════════════════════════════════════════
//  VERSION 3 — dates stored as DD-MM-YYYY strings
// ═══════════════════════════════════════════════
const express  = require("express");
const mongoose = require("mongoose");
const cors     = require("cors");
const multer   = require("multer");
const XLSX     = require("xlsx");
const Product  = require("./models/Product");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── MongoDB ──────────────────────────────────────────────────
const MONGO_URI = "mongodb+srv://ankit:ankit123@cluster0.pxjzgk5.mongodb.net/warrantyDB";
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected — VERSION 3"))
  .catch((err) => console.log("❌ MongoDB error:", err));

// ─── Multer ───────────────────────────────────────────────────
const upload = multer({ dest: "uploads/" });

// ─── Helpers ──────────────────────────────────────────────────
function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[\s_\-]/g, "");
}
const COL_MAP = {
  serialnumber: "serialNumber", serial: "serialNumber",
  productname:  "productName",  product: "productName",
  warrantyduration: "warrantyDuration", duration: "warrantyDuration", warranty: "warrantyDuration",
  startdate: "startDate", start: "startDate",
};
function mapRow(rawRow) {
  const out = {};
  for (const [k, v] of Object.entries(rawRow)) {
    const mapped = COL_MAP[normalizeKey(k)];
    if (mapped) out[mapped] = v;
  }
  return out;
}

function parseDate(val) {
  if (!val && val !== 0) return null;
  if (val instanceof Date) return isNaN(val) ? null : val;
  if (typeof val === "number") {
    try { const p = XLSX.SSF.parse_date_code(val); if (p) return new Date(p.y, p.m-1, p.d); } catch {}
    return null;
  }
  const str = String(val).trim();
  if (!str) return null;
  // DD-MM-YYYY or DD/MM/YYYY
  let m = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  // YYYY-MM-DD
  m = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  // M/D/YY
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { let y=+m[3]; if(y<100) y+=y<50?2000:1900; return new Date(y,+m[1]-1,+m[2]); }
  const native = new Date(str);
  return isNaN(native) ? null : native;
}

function fmtDMY(d) {
  if (!d || isNaN(d)) return null;
  return `${String(d.getDate()).padStart(2,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${d.getFullYear()}`;
}

// ─── UPLOAD API ───────────────────────────────────────────────
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");

    console.log("\n📂 Processing upload — VERSION 3");

    // cellDates:FALSE → dates come as strings, never JS Date objects
    const wb      = XLSX.readFile(req.file.path, { cellDates: false });
    const ws      = wb.Sheets[wb.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(ws, { defval: "" });

    console.log(`   Total rows read: ${rawData.length}`);
    console.log(`   First raw row:`, rawData[0]);

    const today = new Date(); today.setHours(0,0,0,0);
    let successCount = 0, skippedCount = 0;
    const errors = [];

    // Duplicate check
    const seen = {};
    for (const r of rawData) {
      const sn = String(mapRow(r).serialNumber || "").trim();
      if (sn) seen[sn] = (seen[sn] || 0) + 1;
    }
    const dupes = Object.entries(seen).filter(([,c])=>c>1).map(([s])=>s);
    if (dupes.length) {
      return res.status(400).json({
        message: "Upload rejected — duplicates in file",
        duplicates: dupes, recordsProcessed: 0,
        skipped: rawData.length,
        errors: dupes.map(s=>`"${s}" appears ${seen[s]} times`),
      });
    }

    for (const [i, rawRow] of rawData.entries()) {
      const rowNum   = i + 2;
      const row      = mapRow(rawRow);
      const serial   = row.serialNumber ? String(row.serialNumber).trim() : null;
      const name     = row.productName  ? String(row.productName).trim()  : null;
      const duration = Number(row.warrantyDuration);

      if (!serial || !name) {
        skippedCount++;
        errors.push(`Row ${rowNum}: missing serial or product name`);
        continue;
      }
      if (![5,10].includes(duration)) {
        skippedCount++;
        errors.push(`Row ${rowNum} ("${serial}"): duration must be 5 or 10, got "${row.warrantyDuration}"`);
        continue;
      }

      let startDate = parseDate(row.startDate);
      if (!startDate || isNaN(startDate)) startDate = new Date();
      startDate.setHours(0,0,0,0);
      const startStr = fmtDMY(startDate);

      console.log(`   Row ${rowNum} | "${serial}" | raw="${row.startDate}" | parsed="${startStr}"`);

      if (startDate > today) {
        skippedCount++;
        errors.push(`Row ${rowNum} ("${serial}"): ${startStr} is in the future — skipped`);
        continue;
      }

      const endDate = new Date(startDate);
      endDate.setFullYear(startDate.getFullYear() + duration);
      const endStr = fmtDMY(endDate);

      // Raw driver — bypasses ALL Mongoose type casting
      await Product.collection.findOneAndUpdate(
        { serialNumber: serial },
        { $set: { serialNumber: serial, productName: name, warrantyDuration: duration, startDate: startStr, endDate: endStr } },
        { upsert: true }
      );

      console.log(`   ✅ Saved "${serial}" | startDate="${startStr}" | endDate="${endStr}"`);
      successCount++;
    }

    console.log(`\n   Done: ${successCount} saved, ${skippedCount} skipped\n`);
    res.json({ message: "Upload complete", recordsProcessed: successCount, skipped: skippedCount, errors });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Error processing file");
  }
});

// ─── SEARCH API ───────────────────────────────────────────────
app.get("/product/:serial", async (req, res) => {
  try {
    const product = await Product.findOne({ serialNumber: req.params.serial.trim() });
    if (!product) return res.status(404).json({ message: "Not found" });

    function toSafeISO(val) {
      if (!val) return null;
      if (val instanceof Date && !isNaN(val))
        return new Date(Date.UTC(val.getUTCFullYear(), val.getUTCMonth(), val.getUTCDate(), 12)).toISOString();
      const str = String(val).trim();
      const dmy = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (dmy) { const [,d,m,y]=dmy.map(Number); return new Date(Date.UTC(y,m-1,d,12)).toISOString(); }
      const iso = new Date(str);
      if (!isNaN(iso)) return new Date(Date.UTC(iso.getUTCFullYear(),iso.getUTCMonth(),iso.getUTCDate(),12)).toISOString();
      return null;
    }
    function toDisplay(val) {
      if (!val) return null;
      const iso = toSafeISO(val);
      if (!iso) return String(val);
      const d = new Date(iso);
      return `${String(d.getUTCDate()).padStart(2,"0")}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${d.getUTCFullYear()}`;
    }

    res.json({
      productName:        product.productName,
      warrantyDuration:   product.warrantyDuration,
      startDate:          toSafeISO(product.startDate),
      endDate:            toSafeISO(product.endDate),
      startDateFormatted: toDisplay(product.startDate),
      endDateFormatted:   toDisplay(product.endDate),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching product");
  }
});

app.get("/", (_, res) => res.send("Backend VERSION 3 running 🚀"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));