// src/app.js - Ultra-Fast Webhook-Only Trading Bot
require('dotenv').config();
const logger = require('./utils/logger');
const TradingBot = require('./bot/tradingBot');
const WebhookListener = require('./listeners/webhookListener'); // ⚡ ULTRA-FAST webhook alerts
const PositionManager = require('./bot/positionManager');
const RiskManager = require('./bot/riskManager');

class PumpTradingApp {
    constructor() {
        this.config = {
            tradingMode: process.env.TRADING_MODE || 'paper',
            tradingEnabled: process.env.TRADING_ENABLED === 'true',
            initialInvestment: parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.1,
            maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 5,
            positionCheckInterval: parseInt(process.env.POSITION_CHECK_INTERVAL) || 30000,
            
            // ⚡ Webhook configuration (ONLY source of alerts)
            webhookPort: parseInt(process.env.WEBHOOK_PORT) || 3001,
            webhookApiKey: process.env.TRADING_BOT_API_KEY || 'your-secret-key'
        };

        this.tradingBot = null;
        this.webhookListener = null; // ⚡ ONLY alert source
        this.positionManager = null;
        this.riskManager = null;
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
            logger.info('🚀 Starting Ultra-Fast Webhook Trading Bot...');
            logger.info(`📊 Mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`💰 Initial Investment: ${this.config.initialInvestment} SOL`);
            logger.info(`⚡ Alert Source: WEBHOOK ONLY (5-20ms latency)`);
            this.startTime = Date.now();

            // Validate configuration
            await this.validateConfiguration();

            // Initialize components
            await this.initializeComponents();

            // Start monitoring
            this.startPositionMonitoring();

            this.isRunning = true;
            logger.info('✅ Ultra-fast trading bot started successfully');
            
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

        // Required environment variables
        const required = [
            'SOLANA_RPC_URL',
            'PRIVATE_KEY'
        ];

        for (const env of required) {
            if (!process.env[env]) {
                throw new Error(`Missing required environment variable: ${env}`);
            }
        }

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
        logger.info('🔧 Initializing trading components...');

        // Initialize Risk Manager first
        this.riskManager = new RiskManager({
            maxConcurrentPositions: this.config.maxConcurrentPositions,
            maxDailyLosses: parseFloat(process.env.MAX_DAILY_LOSSES_SOL) || 1.0,
            blacklistBundleDetected: process.env.BLACKLIST_BUNDLE_DETECTED === 'true',
            blacklistHighRisk: process.env.BLACKLIST_HIGH_RISK === 'true'
        });

        // Initialize Position Manager
        this.positionManager = new PositionManager({
            tradingMode: this.config.tradingMode,
            riskManager: this.riskManager
        });

        // Initialize Trading Bot
        this.tradingBot = new TradingBot({
            tradingMode: this.config.tradingMode,
            positionManager: this.positionManager,
            riskManager: this.riskManager,
            initialInvestment: this.config.initialInvestment
        });

        // ⚡ Initialize Ultra-Fast Webhook Listener (ONLY alert source)
        logger.info('⚡ Initializing ultra-fast webhook listener...');
        this.webhookListener = new WebhookListener({
            port: this.config.webhookPort,
            apiKey: this.config.webhookApiKey,
            enableCors: true,
            rateLimit: 50, // 50 requests/minute is plenty for ~1 alert/hour
            logRequests: process.env.NODE_ENV === 'development'
        });

        // Setup event handlers
        this.setupEventHandlers();

        // Start webhook server
        await this.webhookListener.start();

        logger.info('✅ All components initialized');
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

        // ⚡ Webhook Listener Events (ONLY alert source)
        this.webhookListener.on('alertReceived', (alert) => {
            this.metrics.alertsReceived++;
            logger.info(`⚡ Alert received: ${alert.token.symbol} (${alert.confidence || 'UNKNOWN'}) - ${alert.twitter.likes} likes, ${alert.twitter.views} views`);
        });

        this.webhookListener.on('qualifiedAlert', async (alert) => {
            this.metrics.alertsQualified++;
            logger.info(`🚀 QUALIFIED: ${alert.token.symbol} - ${alert.twitter.likes} likes, ${alert.analysis.riskLevel} risk`);
            
            // ⚡ Process immediately through trading bot
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
        this.riskManager.on('error', this.handleError.bind(this));
    }

    // Helper methods for alert qualification (duplicated from webhook listener for metrics)
    isQualifiedAlert(alert) {
        const minLikes = parseInt(process.env.MIN_TWITTER_LIKES) || 100;
        const minViews = parseInt(process.env.MIN_TWITTER_VIEWS) || 50000;
        
        if (alert.twitter.likes < minLikes) return false;
        if (alert.twitter.views > 0 && alert.twitter.views < minViews) return false;
        if (process.env.BLACKLIST_BUNDLE_DETECTED === 'true' && alert.analysis.bundleDetected) return false;
        if (process.env.BLACKLIST_HIGH_RISK === 'true' && alert.analysis.riskLevel === 'HIGH') return false;
        
        return true;
    }

    getSkipReason(alert) {
        const minLikes = parseInt(process.env.MIN_TWITTER_LIKES) || 100;
        const minViews = parseInt(process.env.MIN_TWITTER_VIEWS) || 50000;
        
        if (alert.twitter.likes < minLikes) return `Likes too low: ${alert.twitter.likes} < ${minLikes}`;
        if (alert.twitter.views > 0 && alert.twitter.views < minViews) return `Views too low: ${alert.twitter.views} < ${minViews}`;
        if (alert.analysis.bundleDetected && process.env.BLACKLIST_BUNDLE_DETECTED === 'true') return 'Bundle detected';
        if (alert.analysis.riskLevel === 'HIGH' && process.env.BLACKLIST_HIGH_RISK === 'true') return 'High risk';
        return 'Unknown reason';
    }

    logIntegrationStatus() {
        logger.info('📡 Ultra-Fast Alert Integration:');
        logger.info(`   ⚡ WEBHOOK ONLY: Port ${this.config.webhookPort} (5-20ms latency)`);
        logger.info(`   📡 Endpoint: http://localhost:${this.config.webhookPort}/webhook/alert`);
        logger.info(`   🎯 Strategy: Maximum speed, no fallbacks needed`);
        logger.info(`   📊 Expected: ~1 alert per hour`);
    }

    startPositionMonitoring() {
        setInterval(async () => {
            try {
                await this.positionManager.updateAllPositions();
            } catch (error) {
                logger.error('Error updating positions:', error);
            }
        }, this.config.positionCheckInterval);

        logger.info(`📊 Position monitoring started (${this.config.positionCheckInterval / 1000}s intervals)`);
    }

    handleError(error) {
        logger.error('Trading bot error:', error);
        
        // Handle critical errors
        if (this.isCriticalError(error)) {
            logger.error('🚨 Critical error detected, stopping trading operations');
            this.tradingBot.pauseTrading();
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
        
        return {
            isRunning: this.isRunning,
            mode: this.config.tradingMode,
            uptime: this.formatUptime(uptime),
            
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
            tradingEnabled: this.tradingBot ? this.tradingBot.isTradingEnabled() : false,
            
            webhook: {
                enabled: true,
                listening: webhookStats.isListening || false,
                port: this.config.webhookPort,
                alertsProcessed: webhookStats.alertsProcessed || 0,
                successRate: webhookStats.successRate || '0%',
                averageLatency: Math.round(webhookStats.avgProcessingTime || 0) + 'ms',
                fastestAlert: webhookStats.fastestAlert || 0,
                slowestAlert: webhookStats.slowestAlert || 0
            }
        };
    }

    getDetailedStats() {
        const status = this.getStatus();
        const webhookStats = this.webhookListener ? this.webhookListener.getStats() : {};
        
        return {
            ...status,
            detailedWebhookStats: webhookStats,
            riskManagerStats: this.riskManager ? this.riskManager.getStats() : {},
            positionManagerStats: this.positionManager ? this.positionManager.getPerformanceStats() : {}
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

        logger.info('🛑 Shutting down ultra-fast trading bot...');
        
        try {
            // Pause trading first
            if (this.tradingBot) {
                this.tradingBot.pauseTrading();
            }

            // Save current positions
            if (this.positionManager) {
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
            
            if (this.tradingBot) {
                await this.tradingBot.stop();
            }

            logger.info('🛑 Ultra-fast trading bot stopped');
            
        } catch (error) {
            logger.error('Error stopping trading bot:', error);
            throw error;
        }
    }
}

// Export for use as module
module.exports = PumpTradingApp;

// Run as standalone application if called directly
if (require.main === module) {
    const app = new PumpTradingApp();
    
    app.start().catch(error => {
        logger.error('Failed to start ultra-fast trading bot:', error);
        process.exit(1);
    });
}