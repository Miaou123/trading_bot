// src/app.js - Complete Trading App with Holder Concentration Checks
require('dotenv').config();
const logger = require('./utils/logger');
const TradingWebSocket = require('./services/tradingWebSocket');
const TradingBot = require('./bot/tradingBot');
const PositionManager = require('./bot/positionManager');

class TradingApp {
    constructor() {
        this.botMode = process.env.BOT_MODE || 'both';
        this.disableTwitterCheck = process.env.DISABLE_TWITTER_CHECK === 'true' || false;
        
        this.config = {
            tradingMode: process.env.TRADING_MODE || 'paper',
            initialInvestment: parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.01,
            minTwitterLikes: parseInt(process.env.MIN_TWITTER_LIKES) || 100,
            maxPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 10,
            
            // 🔥 NEW: Holder concentration check configuration
            enableHolderCheck: process.env.ENABLE_HOLDER_CHECKS !== 'false',
            holderConcentrationThreshold: parseInt(process.env.HOLDER_CONCENTRATION_THRESHOLD) || 70,
            skipChecksInPaperMode: process.env.SKIP_CHECKS_IN_PAPER_MODE === 'true'
        };

        this.positionManager = new PositionManager({
            tradingMode: this.config.tradingMode,
            maxPositions: this.config.maxPositions 
        });

        // 🔥 UPDATED: Pass holder check configuration to trading bot
        this.tradingBot = new TradingBot({
            tradingMode: this.config.tradingMode,
            positionManager: this.positionManager,
            initialInvestment: this.config.initialInvestment,
            enableHolderCheck: this.config.enableHolderCheck,
            holderConcentrationThreshold: this.config.holderConcentrationThreshold,
            skipChecksInPaperMode: this.config.skipChecksInPaperMode
        });

        this.webSocket = new TradingWebSocket({
            minLikes: this.config.minTwitterLikes,
            botMode: this.botMode,
            disableTwitterCheck: this.disableTwitterCheck
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
            if (tradeData.validation) {
                logger.info(`📊 Holder concentration was: ${tradeData.validation.holderCheck.concentration?.toFixed(1)}%`);
            }
        });

        // 🔥 NEW: Listen for blocked trades due to holder concentration
        this.tradingBot.on('tradeBlocked', (blockData) => {
            logger.warn(`🚫 Trade blocked: ${blockData.symbol} - ${blockData.reason}`);
            if (blockData.holderConcentration) {
                logger.warn(`📊 Holder concentration: ${blockData.holderConcentration.toFixed(1)}%`);
            }
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
            
            // 🔥 NEW: Log holder check configuration
            if (this.config.enableHolderCheck) {
                logger.info(`🔍 Holder checks ENABLED - Max concentration: ${this.config.holderConcentrationThreshold}%`);
                if (this.config.skipChecksInPaperMode && this.config.tradingMode === 'paper') {
                    logger.info(`📝 Holder checks SKIPPED in paper mode`);
                }
            } else {
                logger.warn(`⚠️ Holder checks DISABLED - Trading without concentration validation!`);
            }
            
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

    // 🔥 NEW: Runtime configuration methods
    updateHolderCheckSettings(settings) {
        this.tradingBot.updateHolderCheckSettings(settings);
        
        // Update local config
        if (settings.enabled !== undefined) {
            this.config.enableHolderCheck = settings.enabled;
        }
        if (settings.threshold !== undefined) {
            this.config.holderConcentrationThreshold = settings.threshold;
        }
        if (settings.skipInPaperMode !== undefined) {
            this.config.skipChecksInPaperMode = settings.skipInPaperMode;
        }
    }

    getHolderCheckStatus() {
        return this.tradingBot.getPreTradeCheckStatus();
    }

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
        const baseStatus = {
            isRunning: this.isRunning,
            mode: this.config.tradingMode,
            botMode: this.botMode,
            twitterCheckEnabled: !this.disableTwitterCheck,
            minLikes: this.config.minTwitterLikes,
            maxPositions: this.config.maxPositions,
            positions: this.positionManager.getActivePositionsCount(),
            connected: this.webSocket.isConnected
        };

        // 🔥 NEW: Add holder check status
        const holderCheckStatus = this.getHolderCheckStatus();
        
        return {
            ...baseStatus,
            holderChecks: {
                enabled: holderCheckStatus.enableHolderCheck,
                threshold: holderCheckStatus.holderConcentrationThreshold,
                skipInPaperMode: holderCheckStatus.skipChecksInPaperMode
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