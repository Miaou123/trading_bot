// src/app.js - Fixed to use Enhanced PositionManager with Fast Price Updates
require('dotenv').config();
const logger = require('./utils/logger');
const TradingBot = require('./bot/tradingBot');
const WebhookListener = require('./listeners/webhookListener');
const PositionManager = require('./bot/positionManager'); // Enhanced version

class SimplifiedTradingApp {
    constructor() {
        this.config = {
            tradingMode: process.env.TRADING_MODE || 'paper',
            tradingEnabled: process.env.TRADING_ENABLED === 'true',
            initialInvestment: parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.1,
            maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 5,
            
            // 🔥 ENHANCED: Fast price update configuration
            fastUpdateInterval: 500,     // 500ms for critical positions
            normalUpdateInterval: 1000, // 1s for normal positions
            slowUpdateInterval: 5000,   // 5s for stable positions
            
            // Webhook configuration
            webhookPort: parseInt(process.env.WEBHOOK_PORT) || 3001,
            webhookApiKey: process.env.TRADING_BOT_API_KEY || 'your-secret-key',
            
            // Simplified qualification thresholds
            minTwitterLikes: parseInt(process.env.MIN_TWITTER_LIKES) || 100,
            minTwitterViews: parseInt(process.env.MIN_TWITTER_VIEWS) || 50000
        };

        this.tradingBot = null;
        this.webhookListener = null;
        this.positionManager = null;
        this.isRunning = false;
        this.startTime = null;
        
        // Performance metrics
        this.metrics = {
            alertsReceived: 0,
            alertsQualified: 0,
            alertsSkipped: 0,
            tradesExecuted: 0,
            profitableTrades: 0,
            totalPnL: 0,
            uptime: 0,
            averageAlertProcessingTime: 0
        };

        this.setupShutdownHandlers();
    }

    async start() {
        if (this.isRunning) {
            logger.warn('Trading bot is already running');
            return;
        }

        try {
            logger.info('🚀 Starting Enhanced Trading Bot...');
            logger.info(`📊 Mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`💰 Initial Investment: ${this.config.initialInvestment} SOL`);
            logger.info(`🎯 SIMPLIFIED: Only checking likes (${this.config.minTwitterLikes}+) and views (${this.config.minTwitterViews}+)`);
            logger.info(`⚡ ENHANCED: Fast price updates enabled!`);
            this.startTime = Date.now();

            // Validate configuration
            await this.validateConfiguration();

            // Initialize components
            await this.initializeComponents();

            this.isRunning = true;
            logger.info('✅ Enhanced trading bot started successfully');
            
            if (this.config.tradingMode === 'paper') {
                logger.info('📝 Running in PAPER TRADING mode - no real trades will be executed');
            } else {
                logger.info('💰 Running in LIVE TRADING mode - real money at risk!');
            }

            this.logIntegrationStatus();

        } catch (error) {
            logger.error('❌ Failed to start trading bot:', error);
            await this.stop();
            throw error;
        }
    }

    async validateConfiguration() {
        logger.info('🔍 Validating configuration...');

        // Webhook validation
        if (!this.config.webhookApiKey || this.config.webhookApiKey === 'your-secret-key') {
            logger.warn('⚠️ Using default webhook API key - please set TRADING_BOT_API_KEY for security');
        }

        // Validate trading parameters
        if (this.config.initialInvestment <= 0) {
            throw new Error('INITIAL_INVESTMENT_SOL must be greater than 0');
        }

        if (this.config.maxConcurrentPositions <= 0 || this.config.maxConcurrentPositions > 20) {
            throw new Error('MAX_CONCURRENT_POSITIONS must be between 1 and 20');
        }

        logger.info('✅ Configuration validation passed');
    }

    async initializeComponents() {
        logger.info('🔧 Initializing enhanced trading components...');

        // 🔥 ENHANCED: Initialize Position Manager with fast price updates
        this.positionManager = new PositionManager({
            tradingMode: this.config.tradingMode,
            maxPositions: this.config.maxConcurrentPositions,
            // Fast price update configuration
            fastUpdateInterval: this.config.fastUpdateInterval,
            normalUpdateInterval: this.config.normalUpdateInterval,
            slowUpdateInterval: this.config.slowUpdateInterval,
            batchUpdateSize: 10,
            maxConcurrentBatches: 3,
            criticalDistanceThreshold: 0.05, // 5% from stop/take profit
            normalDistanceThreshold: 0.15    // 15% from stop/take profit
        });

        // Initialize Trading Bot
        this.tradingBot = new TradingBot({
            tradingMode: this.config.tradingMode,
            positionManager: this.positionManager,
            initialInvestment: this.config.initialInvestment
        });

        // 🔥 CRITICAL: Connect PositionManager to TradingBot for price discovery
        this.positionManager.setTradingBot(this.tradingBot);
        logger.info('🔗 PositionManager connected to TradingBot for fast price updates');

        // Initialize Webhook Listener
        logger.info('⚡ Initializing webhook listener...');
        this.webhookListener = new WebhookListener({
            port: this.config.webhookPort,
            apiKey: this.config.webhookApiKey,
            enableCors: true,
            rateLimit: 50,
            logRequests: process.env.NODE_ENV === 'development'
        });

        // Setup event handlers
        this.setupEventHandlers();

        // Start webhook server
        await this.webhookListener.start();

        logger.info('✅ All enhanced components initialized');
    }

    setupEventHandlers() {
        // Trading Bot Events
        this.tradingBot.on('tradeExecuted', (tradeData) => {
            this.metrics.tradesExecuted++;
            logger.info(`💰 Trade executed: ${tradeData.type} ${tradeData.amount} ${tradeData.symbol}`);
        });

        this.tradingBot.on('positionClosed', (positionData) => {
            if (positionData.pnl > 0) {
                this.metrics.profitableTrades++;
            }
            this.metrics.totalPnL += positionData.pnl;
            logger.info(`📊 Position closed: ${positionData.symbol} PnL: ${positionData.pnl} SOL`);
        });

        // 🔥 ENHANCED: Position Manager Events
        this.positionManager.on('positionAdded', (position) => {
            logger.info(`📈 Position added to fast price monitoring: ${position.symbol}`);
        });

        this.positionManager.on('positionClosed', (position) => {
            logger.info(`📉 Position removed from fast price monitoring: ${position.symbol}`);
        });

        // Webhook Listener Events
        this.webhookListener.on('alertReceived', (alert) => {
            this.metrics.alertsReceived++;
            logger.info(`⚡ Alert received: ${alert.token.symbol} - ${alert.twitter.likes} likes, ${alert.twitter.views || 0} views`);
        });

        this.webhookListener.on('qualifiedAlert', async (alert) => {
            this.metrics.alertsQualified++;
            logger.info(`🚀 QUALIFIED: ${alert.token.symbol} - ${alert.twitter.likes} likes, ${alert.twitter.views || 0} views`);
            logger.info(`💰 Proceeding with purchase (no risk checks)`);
            
            // Process immediately through trading bot
            try {
                const processingStart = Date.now();
                await this.tradingBot.processAlert(alert);
                const processingTime = Date.now() - processingStart;
                
                // Update average processing time
                if (this.metrics.alertsQualified > 1) {
                    this.metrics.averageAlertProcessingTime = 
                        (this.metrics.averageAlertProcessingTime + processingTime) / 2;
                } else {
                    this.metrics.averageAlertProcessingTime = processingTime;
                }
                
                logger.info(`⚡ Alert processed in ${processingTime}ms (avg: ${Math.round(this.metrics.averageAlertProcessingTime)}ms)`);
                
            } catch (error) {
                logger.error(`❌ Error processing alert for ${alert.token.symbol}:`, error);
            }
        });

        // Handle alerts that don't qualify
        this.webhookListener.on('alertReceived', (alert) => {
            // Check if it was qualified (will be handled by qualifiedAlert event)
            if (!this.isQualifiedAlert(alert)) {
                this.metrics.alertsSkipped++;
                const reason = this.getSkipReason(alert);
                logger.info(`⏭️ SKIPPED: ${alert.token.symbol} - ${reason}`);
            }
        });

        this.webhookListener.on('error', (error) => {
            logger.error('⚡ Webhook listener error:', error);
            this.handleError(error);
        });

        // Error handling for other components
        this.tradingBot.on('error', this.handleError.bind(this));
        this.positionManager.on('error', this.handleError.bind(this));
    }

    // Helper methods for alert qualification
    isQualifiedAlert(alert) {
        if (alert.twitter.likes < this.config.minTwitterLikes) return false;
        if (alert.twitter.views > 0 && alert.twitter.views < this.config.minTwitterViews) return false;
        return true;
    }

    getSkipReason(alert) {
        if (alert.twitter.likes < this.config.minTwitterLikes) {
            return `Likes too low: ${alert.twitter.likes} < ${this.config.minTwitterLikes}`;
        }
        if (alert.twitter.views > 0 && alert.twitter.views < this.config.minTwitterViews) {
            return `Views too low: ${alert.twitter.views} < ${this.config.minTwitterViews}`;
        }
        return 'Unknown reason';
    }

    logIntegrationStatus() {
        logger.info('📡 Enhanced Alert Integration:');
        logger.info(`   ⚡ WEBHOOK: Port ${this.config.webhookPort} (5-20ms latency)`);
        logger.info(`   📡 Endpoint: http://localhost:${this.config.webhookPort}/webhook/alert`);
        logger.info(`   🎯 Strategy: Buy all tokens with ${this.config.minTwitterLikes}+ likes and ${this.config.minTwitterViews}+ views`);
        logger.info(`   🚀 FAST PRICE UPDATES: Critical=500ms, Normal=1s, Stable=5s`);
        logger.info(`   📊 Expected: Multiple alerts per hour, each potentially triggering trades`);
        logger.info(`   🚫 NO RISK FILTERING: Bundle detection, whale analysis, etc. are IGNORED`);
        
        // Log price update system status
        if (this.positionManager) {
            const stats = this.positionManager.getPerformanceStats();
            if (stats.queueSizes) {
                logger.info(`   📊 Position Queues: Critical=${stats.queueSizes.critical}, Normal=${stats.queueSizes.normal}, Slow=${stats.queueSizes.slow}`);
            }
        }
    }

    // 🔥 REMOVED: Old position monitoring (now handled by enhanced PositionManager)
    // The enhanced PositionManager automatically starts its own fast price update system

    handleError(error) {
        logger.error('Trading bot error:', error);
        
        // Handle critical errors
        if (this.isCriticalError(error)) {
            logger.error('🚨 Critical error detected, stopping trading operations');
            if (this.tradingBot && typeof this.tradingBot.pauseTrading === 'function') {
                this.tradingBot.pauseTrading();
            }
        }
    }

    isCriticalError(error) {
        const criticalPatterns = [
            /insufficient.*funds/i,
            /private.*key/i,
            /connection.*refused/i,
            /unauthorized/i,
            /EADDRINUSE/i // Port already in use
        ];
        
        const errorMessage = error.message || error.toString();
        return criticalPatterns.some(pattern => pattern.test(errorMessage));
    }

    getStatus() {
        const uptime = Date.now() - this.startTime;
        const webhookStats = this.webhookListener ? this.webhookListener.getStats() : {};
        const positionStats = this.positionManager ? this.positionManager.getPerformanceStats() : {};
        
        return {
            isRunning: this.isRunning,
            mode: this.config.tradingMode,
            uptime: this.formatUptime(uptime),
            simplified: true,
            enhanced: true, // 🔥 NEW
            fastPriceUpdates: true, // 🔥 NEW
            riskAssessment: false,
            
            metrics: {
                ...this.metrics,
                uptime: uptime,
                winRate: this.metrics.tradesExecuted > 0 ? 
                    ((this.metrics.profitableTrades / this.metrics.tradesExecuted) * 100).toFixed(1) + '%' : '0%',
                qualificationRate: this.metrics.alertsReceived > 0 ?
                    ((this.metrics.alertsQualified / this.metrics.alertsReceived) * 100).toFixed(1) + '%' : '0%',
                averageProcessingTime: Math.round(this.metrics.averageAlertProcessingTime) + 'ms'
            },
            
            positions: this.positionManager ? this.positionManager.getActivePositionsCount() : 0,
            tradingEnabled: this.tradingBot ? (this.tradingBot.isTradingEnabledStatus ? this.tradingBot.isTradingEnabledStatus() : true) : false,
            
            // 🔥 ENHANCED: Position management stats
            positionManagement: positionStats.queueSizes ? {
                criticalPositions: positionStats.queueSizes.critical,
                normalPositions: positionStats.queueSizes.normal,
                slowPositions: positionStats.queueSizes.slow,
                totalInQueues: positionStats.queueSizes.total,
                priceUpdateStats: positionStats.priceUpdateStats
            } : { status: 'initializing' },
            
            webhook: {
                enabled: true,
                listening: webhookStats.isListening || false,
                port: this.config.webhookPort,
                alertsProcessed: webhookStats.alertsProcessed || 0,
                successRate: webhookStats.successRate || '0%',
                averageLatency: Math.round(webhookStats.avgProcessingTime || 0) + 'ms'
            },
            
            qualification: {
                minLikes: this.config.minTwitterLikes,
                minViews: this.config.minTwitterViews,
                riskFiltering: false,
                bundleFiltering: false,
                whaleFiltering: false
            },
            
            // 🔥 NEW: Fast price update configuration
            priceUpdates: {
                criticalInterval: this.config.fastUpdateInterval + 'ms',
                normalInterval: this.config.normalUpdateInterval + 'ms',
                slowInterval: this.config.slowUpdateInterval + 'ms',
                batchProcessing: true,
                manualPriceCalculation: true
            }
        };
    }

    formatUptime(uptime) {
        const seconds = Math.floor(uptime / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    setupShutdownHandlers() {
        const signals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
        
        // Only set up handlers once
        if (this._shutdownHandlersSet) return;
        this._shutdownHandlersSet = true;
        
        signals.forEach(signal => {
            process.on(signal, () => {
                logger.info(`Received ${signal}, starting graceful shutdown...`);
                this.handleShutdown();
            });
        });

        process.on('uncaughtException', (error) => {
            logger.error('Uncaught Exception:', error);
            this.handleShutdown(1);
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection:', reason);
            this.handleShutdown(1);
        });
    }

    async handleShutdown(exitCode = 0) {
        if (!this.isRunning) {
            process.exit(exitCode);
            return;
        }

        logger.info('🛑 Shutting down enhanced trading bot...');
        
        try {
            // Pause trading first
            if (this.tradingBot && typeof this.tradingBot.pauseTrading === 'function') {
                this.tradingBot.pauseTrading();
            }

            // Save current positions
            if (this.positionManager && typeof this.positionManager.savePositions === 'function') {
                await this.positionManager.savePositions();
            }

            await this.stop();
            
            logger.info('✅ Graceful shutdown completed');
            process.exit(exitCode);
            
        } catch (error) {
            logger.error('❌ Error during shutdown:', error);
            process.exit(1);
        }
    }

    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;
        
        try {
            // Stop webhook listener
            if (this.webhookListener) {
                await this.webhookListener.stop();
            }
            
            if (this.tradingBot && typeof this.tradingBot.stop === 'function') {
                await this.tradingBot.stop();
            }

            logger.info('🛑 Enhanced trading bot stopped');
            
        } catch (error) {
            logger.error('Error stopping trading bot:', error);
            throw error;
        }
    }
}

// Export for use as module
module.exports = SimplifiedTradingApp;

// Run as standalone application if called directly
if (require.main === module) {
    const app = new SimplifiedTradingApp();
    
    app.start().catch(error => {
        logger.error('Failed to start enhanced trading bot:', error);
        process.exit(1);
    });
}