const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    serialNumber: {
      type:     String,
      unique:   true,
      required: true,
      trim:     true,
    },
    productName: {
      type:     String,
      required: true,
      trim:     true,
    },
    warrantyDuration: {
      type:     Number,
      required: true,
      enum:     [5, 10],          // only 5 or 10 allowed at DB level too
    },
    // Stored as "DD-MM-YYYY" string — e.g. "21-03-2026"
    startDate: {
      type:     String,
      required: true,
    },
    endDate: {
      type:     String,
      required: true,
    },
  },
  {
    timestamps: true,             // adds createdAt + updatedAt automatically
  }
);

module.exports = mongoose.model("Product", productSchema);