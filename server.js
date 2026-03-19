const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const Product = require("./models/Product");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ MongoDB Atlas Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.log(err));

// ✅ Multer setup
const upload = multer({ dest: "uploads/" });


// 🚀 Upload Excel API
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No file uploaded");
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let successCount = 0;

    for (let item of data) {
      const serial = item["Serial number"];
      const name = item["product name"];
      const duration = Number(item["warranty duration"]);

      // ✅ Validation
      if (!serial || !name) continue;
      if (![5, 10].includes(duration)) continue;

      const endDate = new Date(today);
      endDate.setFullYear(today.getFullYear() + duration);

      // ✅ Upsert (no duplicates)
      await Product.updateOne(
        { serialNumber: serial },
        {
          serialNumber: serial,
          productName: name,
          warrantyDuration: duration,
          startDate: today,
          endDate: endDate,
        },
        { upsert: true }
      );

      successCount++;
    }

    res.json({
      message: "Upload successful",
      recordsProcessed: successCount,
    });

  } catch (error) {
    console.error(error);
    res.status(500).send("Error processing file");
  }
});


// 🔍 Search API
app.get("/product/:serial", async (req, res) => {
  try {
    const product = await Product.findOne({
      serialNumber: req.params.serial,
    });

    if (!product) {
      return res.status(404).json({ message: "Not found" });
    }

    res.json({
      productName: product.productName,
      warrantyDuration: product.warrantyDuration,
      startDate: product.startDate,
      endDate: product.endDate,
    });

  } catch (error) {
    res.status(500).send("Error fetching product");
  }
});


// 🚀 Start Server
app.listen(5000, () => {
  console.log("Server running on port 5000");
});
