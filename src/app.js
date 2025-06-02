// src/app.js - Trading bot with creation/migration modes
require('dotenv').config();
const logger = require('./utils/logger');
const TradingWebSocket = require('./services/tradingWebSocket');
const TradingBot = require('./bot/tradingBot');
const PositionManager = require('./bot/positionManager');

class TradingApp {
    constructor() {
        // 🔥 BOT MODE CONFIGURATION
        this.botMode = process.env.BOT_MODE || 'both'; // 'creation', 'migration', 'both'
        
        this.config = {
            tradingMode: process.env.TRADING_MODE || 'paper',
            initialInvestment: parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.1,
            minTwitterLikes: parseInt(process.env.MIN_TWITTER_LIKES) || 100
        };

        this.positionManager = new PositionManager({
            tradingMode: this.config.tradingMode,
            maxPositions: 5
        });

        this.tradingBot = new TradingBot({
            tradingMode: this.config.tradingMode,
            positionManager: this.positionManager,
            initialInvestment: this.config.initialInvestment
        });

        // 🔥 PASS BOT MODE TO WEBSOCKET
        this.webSocket = new TradingWebSocket({
            minLikes: this.config.minTwitterLikes,
            botMode: this.botMode // Pass the bot mode
        });

        this.isRunning = false;
        this.setupEventHandlers();
        this.setupShutdownHandlers();
    }

    setupEventHandlers() {
        // Handle qualified tokens from WebSocket
        this.webSocket.on('qualifiedToken', async (tokenData) => {
            const eventType = tokenData.eventType || 'creation';
            
            // This check is now redundant since WebSocket filters at subscription level
            // But keeping it as a safety net
            if (!this.shouldProcessEvent(eventType)) {
                logger.info(`⏭️ SKIPPED: ${tokenData.token.symbol} (${eventType}) - Bot mode: ${this.botMode}`);
                return;
            }
            
            logger.info(`💰 PROCESSING: ${tokenData.token.symbol} (${eventType}) - ${tokenData.twitter.likes} likes`);
            
            try {
                await this.tradingBot.processAlert({
                    token: tokenData.token,
                    twitter: tokenData.twitter,
                    confidence: 'MEDIUM'
                });
            } catch (error) {
                logger.error(`Error processing token ${tokenData.token.symbol}:`, error);
            }
        });

        this.tradingBot.on('tradeExecuted', (tradeData) => {
            logger.info(`🎯 Trade executed: ${tradeData.type} ${tradeData.symbol}`);
        });
    }

    // 🔥 MODE CHECKING LOGIC
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
            logger.info(`🐦 Min Twitter likes: ${this.config.minTwitterLikes}`);
            
            // Log what events will be processed
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
            minLikes: this.config.minTwitterLikes,
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