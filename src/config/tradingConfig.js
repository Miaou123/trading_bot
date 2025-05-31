// src/config/tradingConfig.js - Complete trading bot configuration
require('dotenv').config();

const tradingConfig = {
    // Core Trading Settings
    trading: {
        mode: process.env.TRADING_MODE || 'paper', // 'paper' or 'live'
        enabled: process.env.TRADING_ENABLED === 'true',
        initialInvestment: parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.1,
        maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 5,
        positionCheckInterval: parseInt(process.env.POSITION_CHECK_INTERVAL) || 30000, // 30 seconds
        priceUpdateInterval: parseInt(process.env.PRICE_UPDATE_INTERVAL) || 1000, // 1 second for precision
    },

    // Risk Management Settings
    risk: {
        maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 5,
        maxDailyLosses: parseFloat(process.env.MAX_DAILY_LOSSES_SOL) || 1.0,
        maxSinglePositionSize: parseFloat(process.env.MAX_SINGLE_POSITION_SOL) || 0.5,
        blacklistBundleDetected: process.env.BLACKLIST_BUNDLE_DETECTED === 'true',
        blacklistHighRisk: process.env.BLACKLIST_HIGH_RISK === 'true',
        emergencyStopLoss: parseFloat(process.env.EMERGENCY_STOP_LOSS_PERCENTAGE) || 80,
        minLiquidity: parseFloat(process.env.MIN_LIQUIDITY_SOL) || 10,
        maxPositionAge: parseInt(process.env.MAX_POSITION_AGE_HOURS) || 24
    },

    // Trading Strategy Settings
    strategy: {
        stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE) || 50,
        takeProfitLevels: [
            {
                percentage: parseFloat(process.env.TAKE_PROFIT_1_PERCENTAGE) || 100, // 2x
                sellPercentage: parseFloat(process.env.TAKE_PROFIT_1_SELL_PERCENTAGE) || 50 // Sell 50%
            },
            {
                percentage: parseFloat(process.env.TAKE_PROFIT_2_PERCENTAGE) || 300, // 4x  
                sellPercentage: parseFloat(process.env.TAKE_PROFIT_2_SELL_PERCENTAGE) || 25 // Sell 25%
            },
            {
                percentage: parseFloat(process.env.TAKE_PROFIT_3_PERCENTAGE) || 900, // 10x
                sellPercentage: parseFloat(process.env.TAKE_PROFIT_3_SELL_PERCENTAGE) || 100 // Sell rest
            }
        ],
        slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 5, // 5%
    },

    // Alert Filtering Settings
    filters: {
        minTwitterLikes: parseInt(process.env.MIN_TWITTER_LIKES) || 100,
        minTwitterViews: parseInt(process.env.MIN_TWITTER_VIEWS) || 50000,
        blacklistBundleDetected: process.env.BLACKLIST_BUNDLE_DETECTED === 'true',
        blacklistHighRisk: process.env.BLACKLIST_HIGH_RISK === 'true',
        minMarketCap: parseFloat(process.env.MIN_MARKET_CAP) || 0,
        maxMarketCap: parseFloat(process.env.MAX_MARKET_CAP) || 0,
        minLiquidity: parseFloat(process.env.MIN_LIQUIDITY) || 0
    },

    // Blockchain Settings
    blockchain: {
        rpcUrl: process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL,
        commitment: process.env.SOLANA_COMMITMENT || 'confirmed',
        timeout: parseInt(process.env.RPC_TIMEOUT) || 30000,
        retries: parseInt(process.env.RPC_RETRIES) || 3
    },

    // Wallet Configuration
    wallet: {
        privateKey: process.env.PRIVATE_KEY,
        // Add support for private key file as alternative
        privateKeyFile: process.env.PRIVATE_KEY_FILE
    },

    // Webhook Settings
    webhook: {
        port: parseInt(process.env.WEBHOOK_PORT) || 3001,
        apiKey: process.env.TRADING_BOT_API_KEY || 'your-secret-key',
        enableCors: process.env.WEBHOOK_ENABLE_CORS !== 'false',
        rateLimit: parseInt(process.env.WEBHOOK_RATE_LIMIT) || 50,
        logRequests: process.env.WEBHOOK_LOG_REQUESTS === 'true'
    },

    // Telegram Bot Settings (for notifications)
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        tradingResultsChannel: process.env.TRADING_RESULTS_CHANNEL_ID,
        enableNotifications: process.env.ENABLE_TELEGRAM_NOTIFICATIONS === 'true'
    },

    // Position Management
    positions: {
        saveFile: process.env.POSITIONS_FILE || './data/positions.json',
        backupInterval: parseInt(process.env.POSITIONS_BACKUP_INTERVAL) || 300000, // 5 minutes
        maxHistoryEntries: parseInt(process.env.MAX_POSITION_HISTORY) || 1000
    },

    // Logging
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        enableFileLogging: process.env.ENABLE_FILE_LOGGING !== 'false',
        enableConsoleLogging: process.env.ENABLE_CONSOLE_LOGGING !== 'false',
        maxFileSize: process.env.MAX_LOG_FILE_SIZE || '10m',
        maxFiles: parseInt(process.env.MAX_LOG_FILES) || 5
    },

    // Performance & Monitoring
    monitoring: {
        enableHealthCheck: process.env.ENABLE_HEALTH_CHECK !== 'false',
        healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 60000,
        enableMetrics: process.env.ENABLE_METRICS !== 'false',
        metricsPort: parseInt(process.env.METRICS_PORT) || 3002
    },

    // Development Settings
    development: {
        isDevelopment: process.env.NODE_ENV === 'development',
        enableDebugLogs: process.env.ENABLE_DEBUG_LOGS === 'true',
        mockPrices: process.env.MOCK_PRICES === 'true',
        simulateNetworkDelay: process.env.SIMULATE_NETWORK_DELAY === 'true'
    }
};

// Configuration validation
function validateConfig() {
    const errors = [];
    const warnings = [];

    // Required settings
    if (!tradingConfig.blockchain.rpcUrl) {
        errors.push('SOLANA_RPC_URL or HELIUS_RPC_URL is required');
    }

    if (!tradingConfig.wallet.privateKey && !tradingConfig.wallet.privateKeyFile) {
        errors.push('PRIVATE_KEY or PRIVATE_KEY_FILE is required');
    }

    // Validate numerical ranges
    if (tradingConfig.trading.initialInvestment <= 0) {
        errors.push('INITIAL_INVESTMENT_SOL must be greater than 0');
    }

    if (tradingConfig.trading.maxConcurrentPositions <= 0 || tradingConfig.trading.maxConcurrentPositions > 50) {
        warnings.push('MAX_CONCURRENT_POSITIONS should be between 1 and 50');
    }

    if (tradingConfig.risk.maxDailyLosses <= 0) {
        warnings.push('MAX_DAILY_LOSSES_SOL should be greater than 0');
    }

    if (tradingConfig.strategy.slippageTolerance < 0.1 || tradingConfig.strategy.slippageTolerance > 50) {
        warnings.push('SLIPPAGE_TOLERANCE should be between 0.1% and 50%');
    }

    // Validate take profit levels
    const tpLevels = tradingConfig.strategy.takeProfitLevels;
    for (let i = 0; i < tpLevels.length - 1; i++) {
        if (tpLevels[i].percentage >= tpLevels[i + 1].percentage) {
            warnings.push(`Take profit level ${i + 1} should be less than level ${i + 2}`);
        }
    }

    // Security warnings
    if (tradingConfig.webhook.apiKey === 'your-secret-key') {
        warnings.push('Using default webhook API key - please set TRADING_BOT_API_KEY for security');
    }

    if (tradingConfig.trading.mode === 'live' && tradingConfig.development.isDevelopment) {
        warnings.push('Running in LIVE trading mode with development environment');
    }

    return { errors, warnings };
}

// Helper functions
function getConfigForComponent(component) {
    switch (component) {
        case 'trading':
            return tradingConfig.trading;
        case 'risk':
            return tradingConfig.risk;
        case 'strategy':
            return tradingConfig.strategy;
        case 'filters':
            return tradingConfig.filters;
        case 'webhook':
            return tradingConfig.webhook;
        case 'positions':
            return tradingConfig.positions;
        default:
            return tradingConfig;
    }
}

function isTradingEnabled() {
    return tradingConfig.trading.enabled && 
           tradingConfig.trading.mode !== 'disabled' &&
           (tradingConfig.blockchain.rpcUrl && tradingConfig.wallet.privateKey);
}

function isDevelopmentMode() {
    return tradingConfig.development.isDevelopment;
}

function isPaperTradingMode() {
    return tradingConfig.trading.mode === 'paper';
}

function isLiveTradingMode() {
    return tradingConfig.trading.mode === 'live' && tradingConfig.trading.enabled;
}

// Export configuration and helpers
module.exports = {
    // Main config object
    config: tradingConfig,
    
    // Component-specific configs
    tradingConfig: tradingConfig.trading,
    riskConfig: tradingConfig.risk,
    strategyConfig: tradingConfig.strategy,
    filtersConfig: tradingConfig.filters,
    webhookConfig: tradingConfig.webhook,
    telegramConfig: tradingConfig.telegram,
    blockchainConfig: tradingConfig.blockchain,
    positionsConfig: tradingConfig.positions,
    
    // Helper functions
    validateConfig,
    getConfigForComponent,
    isTradingEnabled,
    isDevelopmentMode,
    isPaperTradingMode,
    isLiveTradingMode,
    
    // Quick access to common settings
    TRADING_MODE: tradingConfig.trading.mode,
    INITIAL_INVESTMENT: tradingConfig.trading.initialInvestment,
    MAX_POSITIONS: tradingConfig.trading.maxConcurrentPositions,
    STOP_LOSS: tradingConfig.strategy.stopLossPercentage,
    SLIPPAGE: tradingConfig.strategy.slippageTolerance
};