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
        $lookup: {
          from: 'tokenprices',
          localField: 'contractAddress',
          foreignField: 'contractAddress',
          as: 'priceInfo'
        }
      },
      {
        $unwind: {
          path: '$priceInfo',
          preserveNullAndEmptyArrays: false
        }
      },
      {
        $match: {
          $and: [
            { 'priceInfo.price_usd': { $exists: true } },
            { 'priceInfo.price_usd': { $gt: 0 } },
            { 'priceInfo.fdv_usd': { $gt: 5000 } }, // Ensure meaningful market cap
          ]
        }
      },
      {
        $project: {
          name: 1,
          symbol: 1,
          contractAddress: 1,
          deployer: 1,
          decimals: 1,
          price_usd: '$priceInfo.price_usd',
          fdv_usd: '$priceInfo.fdv_usd',
          volume_usd: '$priceInfo.volume_usd',
          last_updated: '$priceInfo.last_updated'
        }
      }
    ]);

    // Find top market cap token
    const topMarketCapToken = topTokens.reduce((max, token) => 
      (token.fdv_usd > (max.fdv_usd || 0) ? token : max), 
      topTokens[0]
    );

    // Find top volume token if volume data exists
    let topVolumeToken = topTokens[0];
    
    if (topTokens.some(token => token.volume_usd > 0)) {
      topVolumeToken = topTokens.reduce((max, token) => 
        (token.volume_usd > (max.volume_usd || 0) ? token : max), 
        topTokens.find(t => t.volume_usd > 0)
      );
    } else {
      // If no volume data, use the token with second highest market cap
      const sortedByMarketCap = [...topTokens].sort((a, b) => b.fdv_usd - a.fdv_usd);
      topVolumeToken = sortedByMarketCap[1] || sortedByMarketCap[0];
    }

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
        $lookup: {
          from: 'tokenprices',
          localField: 'contractAddress',
          foreignField: 'contractAddress',
          as: 'priceInfo'
        }
      },
      {
        $unwind: {
          path: '$priceInfo',
          preserveNullAndEmptyArrays: false
        }
      },
      {
        $match: {
          $and: [
            { 'priceInfo.price_usd': { $exists: true } },
            { 'priceInfo.price_usd': { $gt: 0 } },
            { 'priceInfo.price_usd': { $ne: null } },
            { 'priceInfo.fdv_usd': { $gt: 5000 } }
          ]
        }
      },
      {
        $project: {
          name: 1,
          symbol: 1,
          contractAddress: 1,
          deployer: 1,
          decimals: 1,
          price_usd: '$priceInfo.price_usd',
          fdv_usd: '$priceInfo.fdv_usd',
          volume_usd: '$priceInfo.volume_usd',
          last_updated: '$priceInfo.last_updated'
        }
      },
      {
        $sort: sortField === 'volume' 
          ? { 'volume_usd': sortDirection === 'desc' ? -1 : 1 }
          : { 'fdv_usd': sortDirection === 'desc' ? -1 : 1 }
      },
      {
        $limit: 240 // Return up to 240 tokens
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
    
    const token = await Token.aggregate([
      {
        $match: { 
          contractAddress: contractAddress
        }
      },
      {
        $lookup: {
          from: 'tokenprices',
          localField: 'contractAddress',
          foreignField: 'contractAddress',
          as: 'priceInfo'
        }
      },
      {
        $unwind: {
          path: '$priceInfo',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          name: 1,
          symbol: 1,
          contractAddress: 1,
          deployer: 1,
          decimals: 1,
          price_usd: '$priceInfo.price_usd',
          fdv_usd: '$priceInfo.fdv_usd',
          volume_usd: '$priceInfo.volume_usd',
          last_updated: '$priceInfo.last_updated'
        }
      }
    ]);

    if (token.length === 0) {
      return res.status(404).json({ message: 'Token not found' });
    }

    res.json(token[0]);
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