// src/app.js - Trading bot with creation/migration modes
require('dotenv').config();
const logger = require('./utils/logger');
const MigrationMonitor = require('./services/migrationMonitor');
const TradingBot = require('./bot/tradingBot');
const PositionManager = require('./bot/positionManager');

class TradingApp {
    constructor() {
        // 🔥 BOT MODE CONFIGURATION
        this.botMode = process.env.BOT_MODE || 'migration'; // 'creation', 'migration', 'both'
        
        this.config = {
            tradingMode: process.env.TRADING_MODE || 'paper',
            initialInvestment: parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.01,
            minTwitterLikes: parseInt(process.env.MIN_TWITTER_LIKES) || 1,
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

        // 🔥 USE MIGRATION MONITOR FOR POOL MONITORING
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
            
            // This check is now redundant since we're only monitoring migrations
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
                    confidence: 'MEDIUM',
                    migration: tokenData.migration,
                    eventType: eventType
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
                logger.warn(`Unknown bot mode: ${this.botMode}, defaulting to 'migration'`);
                return eventType === 'migration';
        }
    }

    async start() {
        if (this.isRunning) return;

        try {
            logger.info('🚀 Starting trading bot with MigrationMonitor...');
            logger.info(`📊 Mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`🎯 Bot Mode: ${this.botMode.toUpperCase()} (pool monitoring)`);
            logger.info(`🐦 Min Twitter likes: ${this.config.minTwitterLikes}`);
            
            // Log what events will be processed
            this.logModeConfiguration();

            await this.tradingBot.initialize();
            
            // Start migration monitoring
            await this.migrationMonitor.startMonitoring();

            this.isRunning = true;
            logger.info('✅ Trading bot started');

            // Log stats periodically
            this.startStatsLogging();

        } catch (error) {
            logger.error('❌ Failed to start:', error);
            throw error;
        }
    }

    logModeConfiguration() {
        switch (this.botMode) {
            case 'creation':
                logger.info('🆕 CREATION MODE: Only processing new token creations (Note: Using migration monitor - no creation events will be detected)');
                logger.warn('⚠️ WARNING: Bot mode is set to "creation" but only migration monitoring is available');
                break;
            case 'migration':
                logger.info('🔄 MIGRATION MODE: Direct PumpSwap pool monitoring via Helius');
                logger.info('📡 Method: Solana program account change subscription');
                logger.info('🎯 Target: New PumpSwap pool creation events');
                break;
            case 'both':
                logger.info('🔄 BOTH MODE: Processing creations and migrations (Note: Only migrations will be detected)');
                logger.warn('⚠️ WARNING: Bot mode is set to "both" but only migration monitoring is available');
                break;
            default:
                logger.warn(`⚠️ Unknown mode: ${this.botMode}, defaulting to migration monitoring`);
        }
    }

    startStatsLogging() {
        // Log stats every 2 minutes
        setInterval(() => {
            if (this.isRunning) {
                const migrationStats = this.migrationMonitor.getStatsString();
                const botStats = this.tradingBot.getStats();
                const positionStats = this.positionManager.getPerformanceStats();
                
                logger.info('📊 === BOT STATS ===');
                logger.info(`Migration: ${migrationStats}`);
                logger.info(`Trading: ${botStats.tradesExecuted} trades (${botStats.liveTrades} live, ${botStats.paperTrades} paper)`);
                logger.info(`Positions: ${positionStats.activePositions} active, ${positionStats.totalRealizedPnL} realized PnL`);
                logger.info(`Performance: Win rate ${positionStats.winRate}, ${positionStats.totalUnrealizedPnL} unrealized PnL`);
            }
        }, 120000); // Every 2 minutes
    }

    async stop() {
        if (!this.isRunning) return;

        logger.info('🛑 Stopping trading bot...');
        
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
            botMode: this.botMode,
            minLikes: this.config.minTwitterLikes,
            maxPositions: this.config.maxPositions,
            positions: this.positionManager.getActivePositionsCount(),
            migrationMonitor: {
                isMonitoring: migrationStats.isMonitoring,
                poolsDetected: migrationStats.stats.poolsDetected,
                migrationsQualified: migrationStats.stats.migrationsQualified,
                qualificationRate: migrationStats.qualificationRate
            }
        };
    }

    // 🔥 NEW: Get detailed status for debugging
    getDetailedStatus() {
        return {
            ...this.getStatus(),
            tradingBotStats: this.tradingBot.getStats(),
            positionManagerStats: this.positionManager.getPerformanceStats(),
            migrationMonitorStats: this.migrationMonitor.getStats()
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