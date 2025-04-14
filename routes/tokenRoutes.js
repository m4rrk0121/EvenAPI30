const express = require('express');
const router = express.Router();
const Token = require('../models/Token');
const TokenPrice = require('../models/TokenPrice');
const tokenDataService = require('../services/tokenDataService');

// Route to get global top tokens
router.get('/global-top-tokens', async (req, res) => {
  try {
    const topTokens = await Token.aggregate([
      {
        $match: {
          $and: [
            { price_usd: { $exists: true } },
            { price_usd: { $gt: 0 } },
            { market_cap_usd: { $gt: 5000 } } // Ensure meaningful market cap
          ]
        }
      },
      {
        $sort: { market_cap_usd: -1 }
      },
      {
        $limit: 100
      }
    ]);

    // Find top market cap token
    const topMarketCapToken = topTokens[0];

    // Find top volume token
    const topVolumeToken = topTokens.reduce((max, token) => 
      (token.volume_usd_24h > (max.volume_usd_24h || 0) ? token : max), 
      topTokens[0]
    );

    console.log('Top Market Cap Token:', topMarketCapToken?.symbol);
    console.log('Top Volume Token:', topVolumeToken?.symbol);

    // Ensure we have active subscriptions for these tokens
    if (topMarketCapToken) {
      tokenDataService.subscribeToToken(topMarketCapToken.contractAddress);
    }
    
    if (topVolumeToken && topVolumeToken.contractAddress !== topMarketCapToken?.contractAddress) {
      tokenDataService.subscribeToToken(topVolumeToken.contractAddress);
    }

    res.json({
      topMarketCapToken,
      topVolumeToken
    });
  } catch (error) {
    console.error('Error fetching global top tokens:', error);
    res.status(500).json({
      message: 'Error fetching global top tokens',
      error: error.message
    });
  }
});

// Fetch tokens with price data
router.get('/tokens', async (req, res) => {
  try {
    const sortField = req.query.sort || 'marketCap';
    const sortDirection = req.query.direction || 'desc';
    const page = parseInt(req.query.page) || 1;
    const limit = 15;
    const skip = (page - 1) * limit;

    const tokens = await Token.aggregate([
      {
        $match: {
          $and: [
            { price_usd: { $exists: true } },
            { price_usd: { $gt: 0 } },
            { market_cap_usd: { $gt: 5000 } }
          ]
        }
      },
      {
        $sort: sortField === 'volume' 
          ? { 'volume_usd_24h': sortDirection === 'desc' ? -1 : 1 }
          : { 'market_cap_usd': sortDirection === 'desc' ? -1 : 1 }
      },
      {
        $limit: 240
      }
    ]);

    // Get page of tokens to return
    const tokensPage = tokens.slice(skip, skip + limit);
    
    // Ensure we have active subscriptions for displayed tokens
    for (const token of tokensPage) {
      tokenDataService.subscribeToToken(token.contractAddress);
    }

    res.json({
      tokens: tokensPage,
      totalTokens: tokens.length,
      currentPage: page,
      totalPages: Math.ceil(tokens.length / limit)
    });
  } catch (error) {
    console.error('Error fetching tokens:', error);
    res.status(500).json({
      message: 'Error fetching tokens',
      error: error.message
    });
  }
});

// Additional route for getting a specific token by contract address
router.get('/tokens/:contractAddress', async (req, res) => {
  try {
    const contractAddress = req.params.contractAddress.toLowerCase();
    
    // Ensure we have an active subscription for this token
    tokenDataService.subscribeToToken(contractAddress);
    
    const token = await Token.findOne({ contractAddress });
    
    if (!token) {
      return res.status(404).json({ message: 'Token not found' });
    }

    res.json(token);
  } catch (error) {
    console.error('Error fetching token:', error);
    res.status(500).json({ 
      message: 'Error fetching token', 
      error: error.message 
    });
  }
});

// New route to get WebSocket subscription status
router.get('/websocket-status', async (req, res) => {
  try {
    // Get count of tokens with price data
    const tokensWithPrice = await TokenPrice.countDocuments({
      'price_usd': { $gt: 0 }
    });
    
    // Get count of all tokens
    const allTokens = await Token.countDocuments({});
    
    res.json({
      status: 'active',
      tokensWithPrice,
      totalTokens: allTokens,
      coverage: `${((tokensWithPrice / allTokens) * 100).toFixed(2)}%`,
      message: 'WebSocket-based blockchain connection is active and monitoring Uniswap pools'
    });
  } catch (error) {
    console.error('Error getting WebSocket status:', error);
    res.status(500).json({ 
      message: 'Error getting WebSocket status', 
      error: error.message 
    });
  }
});

module.exports = router;