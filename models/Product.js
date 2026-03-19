const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
  serialNumber: {
    type: String,
    unique: true,
  },
  productName: String,
  warrantyDuration: Number,
  startDate: Date,
  endDate: Date,
});

module.exports = mongoose.model("Product", productSchema);