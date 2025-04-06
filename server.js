const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const tokenDataService = require('./services/tokenDataService');

const app = express();
const PORT = process.env.PORT || 4002;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Database connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    // Initialize data fetching service after DB connection
    tokenDataService.initializeDataFetching();
  })
  .catch(err => console.error('MongoDB connection error:', err));

// Routes
app.use('/api', require('./routes/tokenRoutes'));

// Production setup
if (process.env.NODE_ENV === 'production') {
  // Serve static files from React build directory
  app.use(express.static(path.join(__dirname, '../frontend/build')));

  // Handle React routing, return all requests to React app
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown - Updated for Mongoose 8+
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  await new Promise(resolve => server.close(resolve));
  console.log('HTTP server closed');
  
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
});

module.exports = app;