// ═══════════════════════════════════════════════
//  VERSION 3 — dates stored as DD-MM-YYYY strings
// ═══════════════════════════════════════════════
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const Product = require("./models/Product");

require("dotenv").config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── MongoDB ──────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.log("❌ MongoDB error:", err));

// ─── Multer ───────────────────────────────────────────────────
const upload = multer({ dest: "uploads/" });

// ─── Helpers ──────────────────────────────────────────────────
function normalizeKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[\s_\-]/g, "");
}

const COL_MAP = {
  serialnumber: "serialNumber",
  serial: "serialNumber",
  productname: "productName",
  product: "productName",
  warrantyduration: "warrantyDuration",
  duration: "warrantyDuration",
  warranty: "warrantyDuration",
  startdate: "startDate",
  start: "startDate",
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
    try {
      const p = XLSX.SSF.parse_date_code(val);
      if (p) return new Date(p.y, p.m - 1, p.d);
    } catch {}
    return null;
  }
  const str = String(val).trim();
  if (!str) return null;

  // DD-MM-YYYY or DD/MM/YYYY
  let m = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);

  // YYYY-MM-DD
  m = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

  // M/D/YY or M/D/YYYY
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return new Date(y, +m[1] - 1, +m[2]);
  }

  const native = new Date(str);
  return isNaN(native) ? null : native;
}

function fmtDMY(d) {
  if (!d || isNaN(d)) return null;
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}

// ─── UPLOAD API ───────────────────────────────────────────────
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");

    // cellDates:false → dates always come as formatted strings
    const wb = XLSX.readFile(req.file.path, { cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(ws, { defval: "" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let successCount = 0;
    let skippedCount = 0;
    const errors = [];

    // ── Collect all valid serials from this file ──
    const seen = {};
    const allSerials = [];
    for (const r of rawData) {
      const row = mapRow(r);
      const sn = String(row.serialNumber || "").trim();
      // Skip completely empty rows
      if (!sn && !row.productName && !row.warrantyDuration) continue;
      if (sn) {
        seen[sn] = (seen[sn] || 0) + 1;
        allSerials.push(sn);
      }
    }

    // ── Check 1: Duplicate serials WITHIN the file ──
    const dupesInFile = Object.entries(seen)
      .filter(([, c]) => c > 1)
      .map(([s]) => s);
    if (dupesInFile.length) {
      return res.status(400).json({
        message: "Upload rejected — duplicate serial numbers within the file",
        duplicates: dupesInFile,
        recordsProcessed: 0,
        skipped: rawData.length,
        errors: dupesInFile.map(
          (s) => `"${s}" appears ${seen[s]} times in this file`,
        ),
      });
    }

    // ── Check 2: Serials that ALREADY EXIST in the database ──
    const existingInDB = await Product.find(
      { serialNumber: { $in: allSerials } },
      { serialNumber: 1, _id: 0 },
    );
    if (existingInDB.length > 0) {
      const existingSerials = existingInDB.map((p) => p.serialNumber);
      return res.status(400).json({
        message:
          "Upload rejected — serial numbers already exist in the database",
        duplicates: existingSerials,
        recordsProcessed: 0,
        skipped: rawData.length,
        errors: existingSerials.map(
          (s) => `"${s}" already exists in the database`,
        ),
      });
    }

    // ── Process each row ──
    for (const [i, rawRow] of rawData.entries()) {
      const rowNum = i + 2;
      const row = mapRow(rawRow);
      const serial = row.serialNumber ? String(row.serialNumber).trim() : null;
      const name = row.productName ? String(row.productName).trim() : null;
      const duration = Number(row.warrantyDuration);

      // Missing fields
      if (!serial || !name) {
        skippedCount++;
        errors.push(`Row ${rowNum}: missing serial number or product name`);
        continue;
      }

      // Duration must be 5 or 10
      if (![5, 10].includes(duration)) {
        skippedCount++;
        errors.push(
          `Row ${rowNum} ("${serial}"): duration must be 5 or 10, got "${row.warrantyDuration}"`,
        );
        continue;
      }

      // Parse purchase/install date — empty/invalid → today
      let purchaseDate = parseDate(row.startDate);
      if (!purchaseDate || isNaN(purchaseDate)) purchaseDate = new Date();
      purchaseDate.setHours(0, 0, 0, 0);

      // Reject future purchase dates
      if (purchaseDate > today) {
        skippedCount++;
        errors.push(
          `Row ${rowNum} ("${serial}"): start date ${fmtDMY(purchaseDate)} is in the future — skipped`,
        );
        continue;
      }

      // Warranty activates 2 months after the purchase/install date
      const startDate = new Date(purchaseDate);
      startDate.setMonth(startDate.getMonth() + 2);
      startDate.setHours(0, 0, 0, 0);
      const startStr = fmtDMY(startDate);

      // Calculate end date (from warranty start, not purchase date)
      const endDate = new Date(startDate);
      endDate.setFullYear(startDate.getFullYear() + duration);
      const endStr = fmtDMY(endDate);

      // Raw MongoDB driver — bypasses Mongoose type casting entirely
      await Product.collection.findOneAndUpdate(
        { serialNumber: serial },
        {
          $set: {
            serialNumber: serial,
            productName: name,
            warrantyDuration: duration,
            startDate: startStr,
            endDate: endStr,
          },
        },
        { upsert: true },
      );

      successCount++;
    }

    res.json({
      message: "Upload complete",
      recordsProcessed: successCount,
      skipped: skippedCount,
      errors,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Error processing file");
  }
});

// ─── SEARCH API ───────────────────────────────────────────────
app.get("/product/:serial", async (req, res) => {
  try {
    const product = await Product.findOne({
      serialNumber: req.params.serial.trim(),
    });

    if (!product) return res.status(404).json({ message: "Not found" });

    // Handles both old ISODate objects and new "DD-MM-YYYY" strings
    function toSafeISO(val) {
      if (!val) return null;
      if (val instanceof Date && !isNaN(val)) {
        return new Date(
          Date.UTC(
            val.getUTCFullYear(),
            val.getUTCMonth(),
            val.getUTCDate(),
            12,
          ),
        ).toISOString();
      }
      const str = String(val).trim();
      const dmy = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (dmy) {
        const [, d, m, y] = dmy.map(Number);
        return new Date(Date.UTC(y, m - 1, d, 12)).toISOString();
      }
      const iso = new Date(str);
      if (!isNaN(iso)) {
        return new Date(
          Date.UTC(
            iso.getUTCFullYear(),
            iso.getUTCMonth(),
            iso.getUTCDate(),
            12,
          ),
        ).toISOString();
      }
      return null;
    }

    function toDisplay(val) {
      if (!val) return null;
      const iso = toSafeISO(val);
      if (!iso) return String(val);
      const d = new Date(iso);
      return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
    }

    res.json({
      productName: product.productName,
      warrantyDuration: product.warrantyDuration,
      startDate: toSafeISO(product.startDate),
      endDate: toSafeISO(product.endDate),
      startDateFormatted: toDisplay(product.startDate),
      endDateFormatted: toDisplay(product.endDate),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching product");
  }
});

// ─── ALL PRODUCTS API (admin export / database viewer) ────────
app.get("/products", async (req, res) => {
  try {
    const products = await Product.find(
      {},
      { _id: 0, __v: 0, createdAt: 0, updatedAt: 0 },
    ).sort({ serialNumber: 1 });

    const data = products.map((p) => ({
      serialNumber: p.serialNumber,
      productName: p.productName,
      warrantyDuration: p.warrantyDuration,
      startDate: p.startDate,
      endDate: p.endDate,
    }));

    res.json({ total: data.length, products: data });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching products");
  }
});

// ─── Health Check ─────────────────────────────────────────────
app.get("/", (_, res) => res.send("Backend is running 🚀"));

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
// will call on server

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
