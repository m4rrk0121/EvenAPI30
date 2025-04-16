// services/tokenDataService.js
const { ethers } = require('ethers');
const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const Token = require('../models/Token');
const TokenPrice = require('../models/TokenPrice');

class TokenPriceTracker {
  constructor() {
    this.wsProvider = null;
    this.tokens = [];
    this.wethPriceUsd = null;
    
    // Base network constants
    this.WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
    this.USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    this.UNISWAP_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
  }

  async initialize() {
    try {
      // Connect to database
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('MongoDB Connected');
  
      // Setup change stream for new tokens
      await this.setupChangeStream();
  
      // Load tokens from v2 collection
      this.tokens = await Token.find({});
      console.log(`Loaded ${this.tokens.length} tokens`);
  
      // Connect WebSocket
      this.wsProvider = new ethers.WebSocketProvider(process.env.WS_RPC_URL);
  
      // Retrieve initial WETH price
      await this.retrieveInitialWethPrice();
  
      // Track WETH price 
      await this.trackWethPrice();
  
      // Start tracking token prices
      this.trackTokenPrices();
  
    } catch (error) {
      console.error('Initialization Error:', error);
      this.reconnect();
    }
  }

  async setupChangeStream() {
    try {
      // Watch for new tokens being added to collection
      const tokenChangeStream = Token.watch([], {
        fullDocument: 'updateLookup'
      });

      tokenChangeStream.on('change', async (change) => {
        try {
          // Only handle new token insertions
          if (change.operationType === 'insert') {
            const newToken = change.fullDocument;
            console.log(`New token detected: ${newToken.symbol}`);
            
            // Find pool and setup subscription
            const pool = await this.findTokenPool(newToken.contractAddress);
            if (pool) {
              this.subscribeToPool(pool, newToken);
              console.log(`Successfully subscribed to pool for new token: ${newToken.symbol}`);
            } else {
              console.log(`No pool found for new token: ${newToken.symbol}`);
            }
          }
        } catch (error) {
          console.error('Error processing new token:', error);
        }
      });

      console.log('Token change stream setup successfully');
    } catch (error) {
      console.error('Error setting up token change stream:', error);
      // Try to reconnect
      setTimeout(() => this.setupChangeStream(), 5000);
    }
  }

  async retrieveInitialWethPrice() {
    try {
      const poolAddress = await this.findWethUsdcPool();
      if (!poolAddress) {
        console.error('Cannot retrieve initial WETH price: No pool found');
        return;
      }
  
      const poolABI = [
        "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
        "function token0() view returns (address)",
        "function token1() view returns (address)"
      ];
  
      const poolContract = new ethers.Contract(poolAddress, poolABI, this.wsProvider);
      
      // Get both tokens to verify the direction
      const [token0, token1, slot0] = await Promise.all([
        poolContract.token0(),
        poolContract.token1(),
        poolContract.slot0()
      ]);
  
      const sqrtPriceX96 = slot0[0];
      
      console.log('Pool token details:', {
        token0,
        token1,
        WETH_ADDRESS: this.WETH_ADDRESS,
        USDC_ADDRESS: this.USDC_ADDRESS
      });
  
      console.log(`Retrieved sqrtPriceX96: ${sqrtPriceX96}`);
  
      // Calculate price
      const price = this.calculateWethPrice(sqrtPriceX96);
      
      console.log(`Calculated initial WETH price: $${price}`);
  
      if (price > 0) {
        this.wethPriceUsd = price;
        
        // Store WETH price in Token collection
        await Token.findOneAndUpdate(
          { contractAddress: this.WETH_ADDRESS },
          {
            $set: {
              price_usd: price,
              last_updated: new Date()
            }
          }
        );
  
        console.log(`Initial WETH Price: $${price}`);
      } else {
        console.error('Calculated WETH price is zero or invalid');
      }
    } catch (error) {
      console.error('Detailed error retrieving initial WETH price:', error);
    }
  }

  async reconnect() {
    console.log('Reconnecting...');
    setTimeout(() => this.initialize(), 5000);
  }

  async findWethUsdcPool() {
    try {
      const factoryABI = ["function getPool(address,address,uint24) view returns (address)"];
      const factory = new ethers.Contract(this.UNISWAP_FACTORY, factoryABI, this.wsProvider);
  
      console.log(`Finding pool for WETH (${this.WETH_ADDRESS}) and USDC (${this.USDC_ADDRESS})`);
  
      const feeTiers = [500, 3000, 10000];
      for (const fee of feeTiers) {
        console.log(`Trying fee tier: ${fee}`);
        const poolAddress = await factory.getPool(this.WETH_ADDRESS, this.USDC_ADDRESS, fee);
        
        console.log(`Pool address for fee ${fee}: ${poolAddress}`);
        
        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
          console.log(`Found WETH/USDC pool: ${poolAddress}`);
          return poolAddress;
        }
      }
      
      console.error('No WETH/USDC pool found across all fee tiers');
      return null;
    } catch (error) {
      console.error('Error finding WETH/USDC pool:', error);
      return null;
    }
  }

  async trackWethPrice() {
    const poolAddress = await this.findWethUsdcPool();
    if (!poolAddress) {
      console.error('No WETH/USDC pool found');
      return;
    }

    const poolABI = [
      "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
    ];

    const poolContract = new ethers.Contract(poolAddress, poolABI, this.wsProvider);

    poolContract.on('Swap', async (sender, recipient, amount0, amount1, sqrtPriceX96) => {
      try {
        // Calculate WETH price using new method
        const price = this.calculateWethPriceFromSwap(sqrtPriceX96);
        
        if (price > 0) {
          this.wethPriceUsd = price;
          
          // Update WETH price in Token collection
          await Token.findOneAndUpdate(
            { contractAddress: this.WETH_ADDRESS },
            {
              $set: {
                price_usd: price,
                last_updated: new Date()
              }
            }
          );
  
          console.log(`WETH Price from Swap: $${price}`);
        }
      } catch (error) {
        console.error('WETH price tracking error:', error);
      }
    });
  }

  async trackTokenPrices() {
    for (const token of this.tokens) {
      try {
        const pool = await this.findTokenPool(token.contractAddress);
        if (pool) {
          this.subscribeToPool(pool, token);
        }
      } catch (error) {
        console.error(`Error tracking ${token.symbol}:`, error);
      }
    }
  }

  async findTokenPool(tokenAddress) {
    try {
      const factoryABI = ["function getPool(address,address,uint24) view returns (address)"];
      const factory = new ethers.Contract(this.UNISWAP_FACTORY, factoryABI, this.wsProvider);

      // Try different fee tiers
      const feeTiers = [500, 3000, 10000];
      for (const fee of feeTiers) {
        const poolAddress = await factory.getPool(tokenAddress, this.WETH_ADDRESS, fee);
        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
          return poolAddress;
        }
      }
      return null;
    } catch (error) {
      console.error(`Pool finding error for ${tokenAddress}:`, error);
      return null;
    }
  }

  subscribeToPool(poolAddress, token) {
    try {
      const poolABI = [
        "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
      ];

      const poolContract = new ethers.Contract(poolAddress, poolABI, this.wsProvider);

      poolContract.on('Swap', async (sender, recipient, amount0, amount1, sqrtPriceX96) => {
        try {
          // Calculate token price
          const price = await this.calculateTokenPriceInUsd(poolContract, token);
          
          if (price > 0) {
            // Update token with new price and last trade time
            await Token.findOneAndUpdate(
              { contractAddress: token.contractAddress },
              {
                $set: {
                  price_usd: price,
                  last_updated: new Date(),
                  last_trade: new Date()
                }
              }
            );
            
            console.log(`Updated ${token.symbol} price: $${price} (Last trade: ${new Date()})`);
          }
        } catch (error) {
          console.error(`Error processing swap for ${token.symbol}:`, error);
        }
      });

      console.log(`Subscribed to pool ${poolAddress} for ${token.symbol}`);
    } catch (error) {
      console.error(`Error subscribing to pool for ${token.symbol}:`, error);
    }
  }

  // Fix for calculateWethPrice function
  calculateWethPrice(sqrtPriceX96) {
    try {
      // Convert sqrtPriceX96 to BigInt
      const sqrtPriceBigInt = BigInt(sqrtPriceX96.toString());
      
      // Base constants for calculation
      const Q96 = BigInt(2) ** BigInt(96);
      
      // Calculate price = (sqrtPrice/2^96)^2 * (10^12)
      // We multiply by 10^12 to account for decimals difference between USDC (6) and WETH (18)
      const price = Number((sqrtPriceBigInt * sqrtPriceBigInt * BigInt(10**12)) / (Q96 * Q96));
      
      console.log('Detailed WETH price calculation:', {
        sqrtPriceX96: sqrtPriceX96.toString(),
        sqrtPriceBigInt: sqrtPriceBigInt.toString(),
        calculatedPrice: price
      });
      
      // Sanity check the price
      if (isNaN(price) || price <= 0 || price > 1000000) {
        console.error('Invalid price calculation', {
          sqrtPriceX96: sqrtPriceX96.toString(),
          calculatedPrice: price
        });
        return 0;
      }
      
      return price;
    } catch (error) {
      console.error('WETH price calculation error:', error);
      return 0;
    }
  }
    
  calculateWethPriceFromSwap(sqrtPriceX96) {
    try {
      // Convert to BigInt for precise calculation
      const sqrtPriceBigInt = BigInt(sqrtPriceX96.toString());
      const Q96 = BigInt(2) ** BigInt(96);
      
      // Calculate price = (sqrtPrice/2^96)^2 * (10^12)
      // Use same formula as initial price calculation for consistency
      const price = Number((sqrtPriceBigInt * sqrtPriceBigInt * BigInt(10**12)) / (Q96 * Q96));
      
      // Add sanity checks
      if (isNaN(price) || price <= 0 || price > 1000000) {
        console.error('Invalid swap price calculation', {
          sqrtPriceX96: sqrtPriceX96.toString(),
          calculatedPrice: price
        });
        return 0;
      }
      
      return price;
    } catch (error) {
      console.error('Swap event price calculation error:', error);
      return 0;
    }
  }

  async calculateTokenPriceInUsd(poolContract, token) {
    try {
      if (!this.wethPriceUsd) {
        console.log(`WETH price not available for ${token.symbol}`);
        return 0;
      }
  
      const [token0, token1, slot0] = await Promise.all([
        poolContract.token0(),
        poolContract.token1(),
        poolContract.slot0()
      ]);
  
      const isToken0Weth = token0.toLowerCase() === this.WETH_ADDRESS.toLowerCase();
      const isToken1Weth = token1.toLowerCase() === this.WETH_ADDRESS.toLowerCase();
  
      if (!isToken0Weth && !isToken1Weth) {
        console.log(`Neither token is WETH for ${token.symbol}`);
        return 0;
      }
  
      const sqrtPriceX96 = BigInt(slot0[0].toString());
      
      // Use much larger adjustment for tiny numbers
      const squared = sqrtPriceX96 * sqrtPriceX96;
      const denominator = BigInt(2) ** BigInt(192);
      const adjustment = BigInt(10) ** BigInt(36); // Increased precision for tiny numbers
      
      const adjustedPrice = (squared * adjustment) / denominator;
      const rawPrice = Number(adjustedPrice) / Number(adjustment);
  
      let priceInWeth;
      if (isToken0Weth) {
        priceInWeth = 1 / rawPrice;
      } else {
        priceInWeth = rawPrice;
      }
  
      const priceUsd = priceInWeth * this.wethPriceUsd;
  
      // Adjust sanity checks for tiny numbers
      if (isNaN(priceUsd) || priceUsd < 0 || priceUsd > 1000000) {
        console.log(`Invalid price for ${token.symbol}: $${priceUsd}`);
        return 0;
      }

      // Get total supply
      const tokenContract = new ethers.Contract(
        token.contractAddress,
        ['function totalSupply() view returns (uint256)'],
        this.wsProvider
      );
      const totalSupply = await tokenContract.totalSupply();

      // Update token in database
      const updatedToken = await Token.findOne({ contractAddress: token.contractAddress.toLowerCase() });
      if (updatedToken) {
        updatedToken.price_usd = priceUsd;
        updatedToken.total_supply = Number(totalSupply);
        updatedToken.last_updated = new Date();
        updatedToken.blockNumber = await this.wsProvider.getBlockNumber();
        
        // Save to trigger pre-save middleware for market cap calculation
        await updatedToken.save();

        console.log(`Updated token ${token.symbol}: 
            Price=$${priceUsd}, 
            Supply=${totalSupply}, 
            Volume=$${updatedToken.volume_usd_24h}, 
            Market Cap=$${updatedToken.market_cap_usd},
            Pool=${poolContract.address}`);
      }
  
      return priceUsd;
    } catch (error) {
      console.error(`Price calculation error for ${token.symbol}:`, error);
      return 0;
    }
  }

  async updateTokenPrice(tokenAddress, price, volume) {
    try {
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function totalSupply() view returns (uint256)'],
        this.wsProvider
      );

      const totalSupply = await tokenContract.totalSupply();
      
      // Find the token first
      const token = await Token.findOne({ contractAddress: tokenAddress.toLowerCase() });
      if (!token) {
        console.error(`Token not found: ${tokenAddress}`);
        return;
      }

      // Update the token fields
      token.price_usd = price;
      token.total_supply = Number(totalSupply);
      token.volume_usd_24h = volume || 0;
      token.last_updated = new Date();

      // Save the token to trigger the pre-save middleware for market cap calculation
      await token.save();

      console.log(`Updated price for token ${tokenAddress}: $${price}, Market Cap: $${token.market_cap_usd}`);
    } catch (error) {
      console.error(`Error updating token ${tokenAddress}:`, error);
    }
  }
}

// Singleton instance of the tracker
let trackerInstance = null;

async function initializeDataFetching() {
  if (!trackerInstance) {
    trackerInstance = new TokenPriceTracker();
    await trackerInstance.initialize();
  }
  return trackerInstance;
}

module.exports = {
  initializeDataFetching,
  subscribeToToken: async (contractAddress) => {
    if (!trackerInstance) {
      await initializeDataFetching();
    }
    // Placeholder for individual token subscription logic
    return true;
  }
};