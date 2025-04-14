const { ethers } = require('ethers');
const cron = require('node-cron');
const axios = require('axios');
const Token = require('../models/Token');
require('dotenv').config();

// Create a configured axios instance for GeckoTerminal
const geckoTerminalApi = axios.create({
  baseURL: 'https://api.geckoterminal.com/api/v2',
  timeout: 30000,
  headers: {
    'Accept': 'application/json'
  }
});

class TokenBatchProcessor {
  constructor() {
    this.wsProvider = null;
    this.batchSize = 30;
    this.processingInterval = 2000; // 2 seconds between batches
  }

  async initialize() {
    try {
      // Connect to WebSocket provider
      this.wsProvider = new ethers.WebSocketProvider(process.env.WS_RPC_URL);
      console.log('WebSocket provider connected');

      // Start processing tokens
      this.processTokensInBatches();
    } catch (error) {
      console.error('Initialization Error:', error);
      this.reconnect();
    }
  }

  async reconnect() {
    console.log('Reconnecting...');
    setTimeout(() => this.initialize(), 5000);
  }

  async processTokensInBatches() {
    try {
      // Get all tokens that need updating (sorted by last_updated)
      const tokens = await Token.find({})
        .sort({ last_updated: 1 })
        .limit(300); // Process up to 300 tokens at a time

      if (tokens.length === 0) {
        console.log('No tokens found to process');
        return;
      }

      console.log(`Processing ${tokens.length} tokens in batches of ${this.batchSize}`);

      // Process tokens in batches
      for (let i = 0; i < tokens.length; i += this.batchSize) {
        const batch = tokens.slice(i, i + this.batchSize);
        await this.processBatch(batch);

        // Wait before processing next batch to respect rate limits
        if (i + this.batchSize < tokens.length) {
          await new Promise(resolve => setTimeout(resolve, this.processingInterval));
        }
      }
    } catch (error) {
      console.error('Error processing tokens:', error);
    }
  }

  async fetchGeckoTerminalData(tokenAddresses) {
    try {
      // Format addresses for GeckoTerminal (comma-separated, URL encoded)
      const addressesParam = tokenAddresses.map(addr => addr.toLowerCase()).join('%2C');
      
      console.log(`Fetching GeckoTerminal data for ${tokenAddresses.length} tokens`);
      console.log('Token addresses:', addressesParam);
      
      const response = await geckoTerminalApi.get(`/networks/base/tokens/multi/${addressesParam}`);
      
      console.log('GeckoTerminal API Response:', JSON.stringify(response.data, null, 2));
      
      if (response.data && response.data.data) {
        const result = {};
        response.data.data.forEach(token => {
          const attributes = token.attributes;
          const address = token.id.split('_')[1].toLowerCase();
          
          // Get the first pool address if available
          const poolAddress = token.relationships?.top_pools?.data?.[0]?.id?.split('_')[1] || null;
          
          result[address] = {
            price_usd: parseFloat(attributes.price_usd || 0),
            volume_usd_24h: parseFloat(attributes.volume_usd?.h24 || 0),
            total_supply: parseFloat(attributes.total_supply || 0),
            decimals: parseInt(attributes.decimals || 18),
            pool_address: poolAddress
          };
        });
        return result;
      }
      return {};
    } catch (error) {
      console.error('Error fetching GeckoTerminal data:', error.response?.data || error.message);
      return {};
    }
  }

  async processBatch(batch) {
    try {
      console.log(`Processing batch of ${batch.length} tokens`);

      // Fetch GeckoTerminal data for the entire batch
      const tokenAddresses = batch.map(token => token.contractAddress);
      const geckoTerminalData = await this.fetchGeckoTerminalData(tokenAddresses);

      for (const token of batch) {
        try {
          // Get token contract
          const tokenContract = new ethers.Contract(
            token.contractAddress,
            ['function totalSupply() view returns (uint256)'],
            this.wsProvider
          );

          // Fetch total supply
          const totalSupply = await tokenContract.totalSupply();
          
          // Get GeckoTerminal data for this token
          const tokenData = geckoTerminalData[token.contractAddress.toLowerCase()] || {};
          
          // Update token with new data
          token.total_supply = Number(totalSupply);
          token.price_usd = tokenData.price_usd || 0;
          token.volume_usd_24h = tokenData.volume_usd_24h || 0;
          token.decimals = tokenData.decimals || 18;
          token.pool_address = tokenData.pool_address || null;
          token.last_updated = new Date();

          // Save the token to trigger market cap calculation
          await token.save();

          console.log(`Updated token ${token.symbol}: 
            Price=$${token.price_usd}, 
            Supply=${token.total_supply}, 
            Volume=$${token.volume_usd_24h}, 
            Market Cap=$${token.market_cap_usd},
            Pool=${token.pool_address}`);
        } catch (error) {
          console.error(`Error processing token ${token.symbol}:`, error);
        }
      }
    } catch (error) {
      console.error('Error processing batch:', error);
    }
  }
}

// Singleton instance
let processorInstance = null;

async function initializeBatchProcessing() {
  if (!processorInstance) {
    processorInstance = new TokenBatchProcessor();
    await processorInstance.initialize();
  }
  return processorInstance;
}

module.exports = {
  initializeBatchProcessing
}; 