const mongoose = require('mongoose');

const TokenPriceSchema = new mongoose.Schema({
  contractAddress: { 
    type: String, 
    required: true, 
    unique: true,
    lowercase: true,
    index: true
  },
  price_usd: Number,
  fdv_usd: Number, // Fully diluted valuation
  volume_usd: { type: Number, default: 0 },
  price_change_percentage_24h: Number,
  last_updated: { type: Date, default: Date.now },
  name: { type: String },
  symbol: { type: String }
  // Add any other price-related fields you need
}, { timestamps: true });

module.exports = mongoose.model('TokenPrice', TokenPriceSchema);