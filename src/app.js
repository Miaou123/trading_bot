// src/app.js - Trading bot with MigrationMonitor for pool detection
require('dotenv').config();
const logger = require('./utils/logger');
const MigrationMonitor = require('./services/migrationMonitor'); // Changed from tradingWebSocket
const TradingBot = require('./bot/tradingBot');
const PositionManager = require('./bot/positionManager');

class TradingApp {
    constructor() {
        // 🔥 BOT MODE CONFIGURATION - Only migration mode supported with MigrationMonitor
        this.botMode = 'migration'; // MigrationMonitor only supports migrations
        
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

        // 🔥 REPLACED: Use MigrationMonitor for direct pool monitoring
        this.migrationMonitor = new MigrationMonitor({
            minLikes: this.config.minTwitterLikes
        });

        this.isRunning = false;
        this.setupEventHandlers();
        this.setupShutdownHandlers();
    }

    setupEventHandlers() {
        // Handle qualified tokens from MigrationMonitor
        this.migrationMonitor.on('qualifiedToken', async (tokenData) => {
            const eventType = tokenData.eventType || 'migration';
            
            logger.info(`💰 PROCESSING: ${tokenData.token.symbol} (${eventType}) - ${tokenData.twitter.likes} likes`);
            
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

    async start() {
        if (this.isRunning) return;

        try {
            logger.info('🚀 Starting trading bot with MigrationMonitor...');
            logger.info(`📊 Mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`🎯 Bot Mode: MIGRATION (pool monitoring)`);
            logger.info(`🐦 Min Twitter likes: ${this.config.minTwitterLikes}`);
            
            // Log what events will be processed
            this.logModeConfiguration();

            await this.tradingBot.initialize();
            
            // 🔥 CHANGED: Start MigrationMonitor instead of WebSocket
            const monitoringStarted = await this.migrationMonitor.startMonitoring();
            if (!monitoringStarted) {
                throw new Error('Failed to start migration monitoring');
            }

            this.isRunning = true;
            logger.info('✅ Trading bot started with MigrationMonitor');

        } catch (error) {
            logger.error('❌ Failed to start:', error);
            throw error;
        }
    }

    logModeConfiguration() {
        logger.info('🔄 MIGRATION MODE: Direct PumpSwap pool monitoring via Helius');
        logger.info('📡 Method: Solana program account change subscription');
        logger.info('🎯 Target: New PumpSwap pool creation events');
    }

    async stop() {
        if (!this.isRunning) return;

        logger.info('🛑 Stopping trading bot...');
        
        // 🔥 CHANGED: Stop MigrationMonitor instead of WebSocket
        await this.migrationMonitor.stopMonitoring();
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
        const migrationStats = this.migrationMonitor.getStats();
        
        return {
            isRunning: this.isRunning,
            mode: this.config.tradingMode,
            botMode: 'migration',
            minLikes: this.config.minTwitterLikes,
            maxPositions: this.config.maxPositions,
            positions: this.positionManager.getActivePositionsCount(),
            
            // Migration monitor stats
            monitoring: {
                isActive: migrationStats.isMonitoring,
                poolsDetected: migrationStats.stats.poolsDetected,
                migrationsProcessed: migrationStats.stats.migrationsProcessed,
                migrationsQualified: migrationStats.stats.migrationsQualified,
                qualificationRate: migrationStats.qualificationRate,
                subscriptionId: migrationStats.subscriptionId
            }
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