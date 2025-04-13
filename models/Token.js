const mongoose = require('mongoose');

const TokenSchema = new mongoose.Schema({
  contractAddress: { 
    type: String, 
    required: true, 
    unique: true,
    lowercase: true,
    index: true
  },
  name: String,
  symbol: String,
  decimals: Number,
  createdAt: Date,
  deployer: String,
  // Price tracking fields
  price_usd: {
    type: Number,
    default: 0
  },
  last_updated: {
    type: Date,
    default: null
  },
  blockNumber: {
    type: Number,
    default: 0
  },
  // Add any other token metadata fields you need
}, { timestamps: true });

module.exports = mongoose.model('Token', TokenSchema);