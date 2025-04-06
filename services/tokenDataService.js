// services/tokenDataService.js
const axios = require('axios');
const cron = require('node-cron');
const Token = require('../models/Token');
const TokenPrice = require('../models/TokenPrice');
require('dotenv').config();

// Create a configured axios instance for API calls
const geckoTerminalApi = axios.create({
  baseURL: 'https://api.geckoterminal.com/api/v2',
  timeout: 30000,
  headers: {
    'Accept': 'application/json'
  }
});

// Track API usage
let apiCallsThisMinute = 0;
let apiCallReset = null;

// Reset API call counter every minute
function setupApiCallTracking() {
  apiCallReset = setInterval(() => {
    apiCallsThisMinute = 0;
    console.log('API call counter reset');
  }, 60000);
}

// Function to fetch price data for a batch of tokens
async function fetchPriceData(addresses) {
  try {
    // Track API usage
    apiCallsThisMinute++;
    console.log(`API call ${apiCallsThisMinute}/30 this minute`);
    
    // Format addresses for GeckoTerminal (comma-separated, URL encoded)
    const addressesParam = addresses.map(addr => addr.toLowerCase()).join('%2C');
    
    console.log(`Fetching price data for ${addresses.length} tokens from GeckoTerminal`);
    
    // Make the API call to GeckoTerminal
    try {
      const response = await geckoTerminalApi.get(`/networks/base/tokens/multi/${addressesParam}`);
      
      // Format the response to match our API format
      const result = { tokens: {} };
      
      if (response.data && response.data.data) {
        response.data.data.forEach(token => {
          const attributes = token.attributes;
          const address = token.id.split('_')[1].toLowerCase();
          
          result.tokens[address] = {
            price_usd: parseFloat(attributes.price_usd || 0),
            fdv_usd: parseFloat(attributes.fdv_usd || 0),
            volume_usd: parseFloat(attributes.volume_usd?.h24 || 0),
            last_updated: new Date(),
            name: attributes.name,
            symbol: attributes.symbol,
            total_reserve_in_usd: parseFloat(attributes.total_reserve_in_usd || 0),
            total_supply: parseFloat(attributes.total_supply || 0),
          };
        });
      }
      
      console.log(`Got price data for ${Object.keys(result.tokens).length} tokens`);
      return result;
    } catch (apiError) {
      console.error('GeckoTerminal API error:', apiError.message);
      return { tokens: {} };
    }
  } catch (error) {
    console.error('Error in price data function:', error.message);
    return { tokens: {} };
  }
}

// Function to update token prices in a rotating fashion
async function updateTokenPrices() {
  // Check if we're approaching the API rate limit
  if (apiCallsThisMinute >= 29) {
    console.log('API rate limit reached, skipping update');
    return;
  }
  
  try {
    // Get all tokens from the database
    const allTokens = await Token.find({}, 'contractAddress');
    
    if (allTokens.length === 0) {
      console.log('No tokens found in database');
      return;
    }
    
    console.log(`Found ${allTokens.length} tokens in the database`);
    
    // Get tokens ordered by their last update time (oldest first)
    const oldestUpdatedTokens = await TokenPrice.find({})
      .sort({ last_updated: 1 })
      .limit(300) // Get the 300 oldest updated tokens
      .select('contractAddress');
    
    // Create a list of token addresses to update
    // If we have price records, use those to find oldest updated tokens
    // Otherwise, just use the tokens from the Token collection
    const tokenAddresses = oldestUpdatedTokens.length > 0
      ? oldestUpdatedTokens.map(t => t.contractAddress)
      : allTokens.map(t => t.contractAddress);
    
    // Calculate how many we can update with remaining API calls
    // Each call can handle up to 30 tokens
    const BATCH_SIZE = 30;
    const remainingCalls = 30 - apiCallsThisMinute;
    const maxTokens = remainingCalls * BATCH_SIZE;
    
    // Limit to the number of tokens we can process with remaining API calls
    const tokensToProcess = tokenAddresses.slice(0, maxTokens);
    
    console.log(`Updating ${tokensToProcess.length} tokens (oldest updated first)`);
    
    // Process in batches of 30 (API limit per call)
    for (let i = 0; i < tokensToProcess.length; i += BATCH_SIZE) {
      // Safety check to make sure we don't exceed API rate limit
      if (apiCallsThisMinute >= 29) {
        console.log('API rate limit reached during batch processing, stopping');
        break;
      }
      
      const batchAddresses = tokensToProcess.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(tokensToProcess.length / BATCH_SIZE);
      
      console.log(`Processing batch ${batchNumber}/${totalBatches} (${batchAddresses.length} tokens)`);
      
      try {
        // Fetch price data for this batch
        const priceData = await fetchPriceData(batchAddresses);
        
        if (priceData && priceData.tokens && Object.keys(priceData.tokens).length > 0) {
          // Prepare bulk operations for database update
          const operations = [];
          
          for (const [address, data] of Object.entries(priceData.tokens)) {
            operations.push({
              updateOne: {
                filter: { contractAddress: address },
                update: { 
                  $set: {
                    ...data,
                    last_updated: new Date()
                  }
                },
                upsert: true
              }
            });
          }
          
          // Execute bulk update
          if (operations.length > 0) {
            const result = await TokenPrice.bulkWrite(operations);
            console.log(`Updated price data for ${operations.length} tokens`);
          }
        }
      } catch (error) {
        console.error(`Error processing batch ${batchNumber}:`, error);
      }
      
      // Small delay between batches to prevent hammering the API
      if (i + BATCH_SIZE < tokensToProcess.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    console.log('Token update cycle completed');
  } catch (error) {
    console.error('Error updating token prices:', error);
  }
}

// Initialize data fetching
async function initializeDataFetching() {
  console.log('Initializing token price service...');
  
  // Setup API call tracking
  setupApiCallTracking();
  
  // Run initial update
  await updateTokenPrices();
  
  // Setup scheduled job - update tokens every 2 seconds
  // This will naturally cycle through all tokens over time
  cron.schedule('*/2 * * * * *', updateTokenPrices);
  
  console.log('Token price service initialized with equal priority for all tokens');
}

// Clean up when shutting down
function shutdown() {
  if (apiCallReset) {
    clearInterval(apiCallReset);
  }
  console.log('Token price service shutdown complete');
}

module.exports = {
  updateTokenPrices,
  initializeDataFetching,
  shutdown
};