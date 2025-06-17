// src/app.js - Trading bot with Twitter testing mode
require('dotenv').config();
const logger = require('./utils/logger');
const TradingWebSocket = require('./services/tradingWebSocket');
const TradingBot = require('./bot/tradingBot');
const PositionManager = require('./bot/positionManager');

class TradingApp {
    constructor() {
        this.botMode = process.env.BOT_MODE || 'both';
        
        // 🔥 TESTING MODE: Disable Twitter checks
        this.disableTwitterCheck = process.env.DISABLE_TWITTER_CHECK === 'true' || false;
        
        this.config = {
            tradingMode: process.env.TRADING_MODE || 'paper',
            initialInvestment: parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.01,
            minTwitterLikes: parseInt(process.env.MIN_TWITTER_LIKES) || 100,
            maxPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 10
        };

        this.positionManager = new PositionManager({
            tradingMode: this.config.tradingMode,
            maxPositions: this.config.maxPositions 
        });

        this.tradingBot = new TradingBot({
            tradingMode: this.config.tradingMode,
            positionManager: this.positionManager,
            initialInvestment: this.config.initialInvestment
        });

        // 🔥 PASS TWITTER TESTING MODE TO WEBSOCKET
        this.webSocket = new TradingWebSocket({
            minLikes: this.config.minTwitterLikes,
            botMode: this.botMode,
            disableTwitterCheck: this.disableTwitterCheck // Pass testing mode
        });

        this.isRunning = false;
        this.setupEventHandlers();
        this.setupShutdownHandlers();
    }

    setupEventHandlers() {
        this.webSocket.on('qualifiedToken', async (tokenData) => {
            const eventType = tokenData.eventType || 'creation';
            
            if (!this.shouldProcessEvent(eventType)) {
                logger.info(`⏭️ SKIPPED: ${tokenData.token.symbol} (${eventType}) - Bot mode: ${this.botMode}`);
                return;
            }
            
            // 🔥 LOG TESTING MODE STATUS
            const twitterStatus = this.disableTwitterCheck ? 
                'NO TWITTER CHECK' : `${tokenData.twitter.likes} likes`;
            
            logger.info(`💰 PROCESSING: ${tokenData.token.symbol} (${eventType}) - ${twitterStatus}`);
            
            try {
                await this.tradingBot.processAlert({
                    token: tokenData.token,
                    twitter: tokenData.twitter,
                    confidence: 'MEDIUM',
                    migration: tokenData.migration
                });
            } catch (error) {
                logger.error(`Error processing token ${tokenData.token.symbol}:`, error);
            }
        });

        this.tradingBot.on('tradeExecuted', (tradeData) => {
            logger.info(`🎯 Trade executed: ${tradeData.type} ${tradeData.symbol}`);
        });
    }

    shouldProcessEvent(eventType) {
        switch (this.botMode) {
            case 'creation':
                return eventType === 'creation';
            case 'migration':  
                return eventType === 'migration';
            case 'both':
                return true;
            default:
                logger.warn(`Unknown bot mode: ${this.botMode}, defaulting to 'both'`);
                return true;
        }
    }

    async start() {
        if (this.isRunning) return;

        try {
            logger.info('🚀 Starting trading bot...');
            logger.info(`📊 Mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`🎯 Bot Mode: ${this.botMode.toUpperCase()}`);
            
            // 🔥 LOG TESTING MODE STATUS
            if (this.disableTwitterCheck) {
                logger.info('🚫 TESTING MODE: Twitter checks DISABLED - Will trade ALL tokens!');
                logger.warn('⚠️  This is for TESTING only - all migration tokens will be traded!');
            } else {
                logger.info(`🐦 Twitter checks ENABLED - Min likes: ${this.config.minTwitterLikes}`);
            }
            
            this.logModeConfiguration();

            await this.tradingBot.initialize();
            this.webSocket.connect();

            this.isRunning = true;
            logger.info('✅ Trading bot started');

        } catch (error) {
            logger.error('❌ Failed to start:', error);
            throw error;
        }
    }

    logModeConfiguration() {
        switch (this.botMode) {
            case 'creation':
                logger.info('🆕 CREATION MODE: Only processing new token creations');
                break;
            case 'migration':
                logger.info('🔄 MIGRATION MODE: Only processing token migrations');
                break;
            case 'both':
                logger.info('🔄🆕 BOTH MODE: Processing creations and migrations');
                break;
            default:
                logger.warn(`⚠️ Unknown mode: ${this.botMode}`);
        }
    }

    // 🔥 NEW: Toggle Twitter check at runtime
    toggleTwitterCheck(enabled) {
        this.disableTwitterCheck = !enabled;
        this.webSocket.setTwitterCheckEnabled(enabled);
        
        if (enabled) {
            logger.info('🐦 Twitter checks ENABLED');
        } else {
            logger.warn('🚫 Twitter checks DISABLED - Trading ALL tokens!');
        }
    }

    async stop() {
        if (!this.isRunning) return;

        logger.info('🛑 Stopping trading bot...');
        
        this.webSocket.disconnect();
        await this.tradingBot.stop();
        await this.positionManager.savePositions();
        
        this.isRunning = false;
        logger.info('✅ Trading bot stopped');
    }

    setupShutdownHandlers() {
        ['SIGTERM', 'SIGINT'].forEach(signal => {
            process.on(signal, () => {
                logger.info(`Received ${signal}, shutting down...`);
                this.stop().then(() => process.exit(0));
            });
        });
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            mode: this.config.tradingMode,
            botMode: this.botMode,
            twitterCheckEnabled: !this.disableTwitterCheck, // 🔥 NEW STATUS
            minLikes: this.config.minTwitterLikes,
            maxPositions: this.config.maxPositions,
            positions: this.positionManager.getActivePositionsCount(),
            connected: this.webSocket.isConnected
        };
    }
}

module.exports = TradingApp;

// Run if called directly
if (require.main === module) {
    const app = new TradingApp();
    app.start().catch(error => {
        logger.error('Failed to start trading bot:', error);
        process.exit(1);
    });
}