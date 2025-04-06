const express = require('express');
const router = express.Router();
const Token = require('../models/Token');
const TokenPrice = require('../models/TokenPrice');

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
            { 'priceInfo.volume_usd': { $gt: 0 } } // Ensure meaningful volume
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

    // Find top volume token
    const topVolumeToken = topTokens.reduce((max, token) => 
      (token.volume_usd > (max.volume_usd || 0) ? token : max), 
      topTokens[0]
    );

    console.log('Top Market Cap Token:', topMarketCapToken);
    console.log('Top Volume Token:', topVolumeToken);

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

    res.json({
      tokens: tokens.slice(skip, skip + limit), // Slice for current page
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
    const token = await Token.aggregate([
      {
        $match: { 
          contractAddress: req.params.contractAddress.toLowerCase() 
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

module.exports = router;
