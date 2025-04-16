const mongoose = require('mongoose');

const TokenSchema = new mongoose.Schema({
  contractAddress: { 
    type: String, 
    required: true, 
    unique: true,
    lowercase: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  symbol: {
    type: String,
    required: true
  },
  decimals: {
    type: Number,
    default: 18
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  deployer: {
    type: String,
    required: true
  },
  // Price tracking fields
  price_usd: {
    type: Number,
    default: 0
  },
  total_supply: {
    type: Number,
    default: 0
  },
  market_cap_usd: {
    type: Number,
    default: 0
  },
  volume_usd_24h: {
    type: Number,
    default: 0
  },
  pool_address: {
    type: String,
    default: null
  },
  last_updated: {
    type: Date,
    default: Date.now
  },
  // Block tracking fields
  blockNumber: {
    type: Number,
    default: 0,
    description: "Block number when token was created"
  },
  last_trade: {
    type: Number,
    default: 0,
    description: "Block number of the last trade for this token"
  },
  last_batch_update: {
    type: Date,
    default: Date.now,
    description: "Timestamp of last batch service update"
  }
  // Add any other token metadata fields you need
}, { timestamps: true });

// Add a pre-save middleware to calculate market cap
TokenSchema.pre('save', function(next) {
  // Calculate market cap using price and supply
  const adjustedSupply = this.total_supply / Math.pow(10, this.decimals);
  this.market_cap_usd = this.price_usd * adjustedSupply;
  next();
});

module.exports = mongoose.model('Token', TokenSchema);