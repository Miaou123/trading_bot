// src/listeners/webhookListener.js - Simplified version (likes/views only)
const express = require('express');
const EventEmitter = require('events');
const logger = require('../utils/logger');

class WebhookListener extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            port: config.port || process.env.WEBHOOK_PORT || 3001,
            apiKey: config.apiKey || process.env.TRADING_BOT_API_KEY || 'your-secret-key',
            enableCors: config.enableCors !== false,
            rateLimit: config.rateLimit || 100,
            enableHealthCheck: config.enableHealthCheck !== false,
            logRequests: config.logRequests !== false,
            ...config
        };

        this.app = express();
        this.server = null;
        this.isListening = false;
        
        // Statistics
        this.stats = {
            requestsReceived: 0,
            alertsProcessed: 0,
            alertsQualified: 0,
            alertsSkipped: 0,
            errors: 0,
            startTime: Date.now(),
            lastAlert: null,
            fastestAlert: Infinity,
            slowestAlert: 0,
            totalProcessingTime: 0
        };

        // Rate limiting
        this.requestCount = 0;
        this.lastReset = Date.now();
        
        this.setupExpress();
        this.setupRoutes();
    }

    setupExpress() {
        // Trust proxy for correct IP addresses
        this.app.set('trust proxy', true);

        // Body parsing middleware
        this.app.use(express.json({ 
            limit: '1mb',
            verify: (req, res, buf) => {
                req.rawBody = buf;
            }
        }));
        this.app.use(express.urlencoded({ extended: true, limit: '1mb' }));

        // CORS middleware
        if (this.config.enableCors) {
            this.app.use((req, res, next) => {
                res.header('Access-Control-Allow-Origin', '*');
                res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key, X-Source, X-Version');
                res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                
                if (req.method === 'OPTIONS') {
                    return res.status(200).end();
                }
                next();
            });
        }

        // Rate limiting middleware
        this.app.use((req, res, next) => {
            const now = Date.now();
            
            if (now - this.lastReset > 60000) {
                this.requestCount = 0;
                this.lastReset = now;
            }
            
            this.requestCount++;
            
            if (this.requestCount > this.config.rateLimit) {
                logger.warn(`Rate limit exceeded from ${req.ip}`);
                return res.status(429).json({ 
                    error: 'Rate limit exceeded',
                    limit: this.config.rateLimit,
                    window: '1 minute'
                });
            }
            
            next();
        });

        // Request logging middleware (only for non-health endpoints)
        if (this.config.logRequests) {
            this.app.use((req, res, next) => {
                if (req.path !== '/health') {
                    const start = Date.now();
                    const originalSend = res.send;
                    
                    res.send = function(body) {
                        const duration = Date.now() - start;
                        logger.debug(`${req.method} ${req.path} ${res.statusCode} ${duration}ms from ${req.ip}`);
                        originalSend.call(this, body);
                    };
                }
                next();
            });
        }

        // Error handling middleware
        this.app.use((error, req, res, next) => {
            this.stats.errors++;
            logger.error('Express middleware error:', error);
            
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: 'Internal server error',
                    timestamp: new Date().toISOString()
                });
            }
        });
    }

    setupRoutes() {
        // Health check endpoint (no auth required)
        this.app.get('/health', (req, res) => {
            const uptime = Date.now() - this.stats.startTime;
            const avgProcessingTime = this.stats.alertsProcessed > 0 ? 
                (this.stats.totalProcessingTime / this.stats.alertsProcessed).toFixed(2) : 0;
            
            res.json({
                status: 'healthy',
                service: 'webhook-listener',
                version: '1.0.0',
                timestamp: new Date().toISOString(),
                uptime: this.formatUptime(uptime),
                stats: {
                    ...this.stats,
                    uptime,
                    avgProcessingTime: `${avgProcessingTime}ms`,
                    fastestAlert: this.stats.fastestAlert === Infinity ? 0 : this.stats.fastestAlert,
                    requestsPerMinute: this.requestCount,
                    successRate: this.stats.requestsReceived > 0 ? 
                        ((this.stats.alertsProcessed / this.stats.requestsReceived) * 100).toFixed(1) + '%' : '0%'
                }
            });
        });

        // Status endpoint
        this.app.get('/status', (req, res) => {
            const uptime = Date.now() - this.stats.startTime;
            
            res.json({
                service: 'pump-trading-bot-webhook',
                version: '1.0.0',
                status: 'active',
                uptime: this.formatUptime(uptime),
                webhook: {
                    listening: this.isListening,
                    port: this.config.port,
                    rateLimit: this.config.rateLimit,
                    corsEnabled: this.config.enableCors
                },
                stats: {
                    ...this.stats,
                    uptime,
                    fastestAlert: this.stats.fastestAlert === Infinity ? 0 : this.stats.fastestAlert,
                    avgProcessingTime: this.stats.alertsProcessed > 0 ? 
                        (this.stats.totalProcessingTime / this.stats.alertsProcessed).toFixed(2) + 'ms' : '0ms',
                    successRate: this.stats.requestsReceived > 0 ? 
                        ((this.stats.alertsProcessed / this.stats.requestsReceived) * 100).toFixed(1) + '%' : '0%',
                    qualificationRate: this.stats.alertsProcessed > 0 ? 
                        ((this.stats.alertsQualified / this.stats.alertsProcessed) * 100).toFixed(1) + '%' : '0%'
                }
            });
        });

        // API key middleware for webhook endpoints
        this.app.use('/webhook', (req, res, next) => {
            const apiKey = req.headers['x-api-key'];
            
            if (!apiKey) {
                logger.warn(`Missing API key from ${req.ip} for ${req.path}`);
                return res.status(401).json({ 
                    error: 'API key required',
                    hint: 'Include X-API-Key header'
                });
            }
            
            if (apiKey !== this.config.apiKey) {
                logger.warn(`Invalid API key from ${req.ip}: ${apiKey.substring(0, 8)}...`);
                return res.status(401).json({ 
                    error: 'Invalid API key'
                });
            }
            
            req.authenticated = true;
            next();
        });

        // Main webhook endpoint for token alerts
        this.app.post('/webhook/alert', async (req, res) => {
            const requestStart = Date.now();
            this.stats.requestsReceived++;
            
            try {
                const alert = req.body;
                const source = req.headers['x-source'] || 'unknown';
                
                logger.debug(`📨 Webhook alert received from ${source}`);
                
                // Quick validation
                const validation = this.validateAlert(alert);
                if (!validation.valid) {
                    logger.warn(`❌ Invalid alert from ${req.ip}: ${validation.error}`);
                    return res.status(400).json({ 
                        error: 'Invalid alert format',
                        details: validation.error
                    });
                }

                // Process alert
                const processingStart = Date.now();
                const result = await this.processAlert(alert, {
                    source,
                    ip: req.ip,
                    receivedAt: requestStart
                });
                const processingTime = Date.now() - processingStart;
                
                // Update statistics
                this.updateStats(processingTime);
                
                const totalTime = Date.now() - requestStart;
                
                // Send success response
                res.json({
                    success: true,
                    processingTime: `${processingTime}ms`,
                    totalTime: `${totalTime}ms`,
                    qualified: result.qualified,
                    action: result.action,
                    timestamp: new Date().toISOString()
                });

                logger.info(`⚡ Alert processed: ${alert.token.symbol} in ${totalTime}ms (${result.action})`);

            } catch (error) {
                this.stats.errors++;
                const totalTime = Date.now() - requestStart;
                
                logger.error(`❌ Webhook processing error (${totalTime}ms):`, error);
                
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false,
                        error: error.message,
                        totalTime: `${totalTime}ms`,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        });

        // Test endpoint
        this.app.post('/webhook/test', (req, res) => {
            const testAlert = {
                source: 'test',
                timestamp: Date.now(),
                token: {
                    address: 'TEST_' + Date.now(),
                    symbol: 'TEST',
                    name: 'Test Token'
                },
                twitter: {
                    likes: Math.floor(Math.random() * 1000) + 100,
                    views: Math.floor(Math.random() * 1000000) + 50000,
                    url: 'https://twitter.com/test'
                },
                analysis: {
                    bundleDetected: Math.random() > 0.7
                }
            };

            this.processAlert(testAlert, { source: 'test' });
            
            res.json({
                success: true,
                message: 'Test alert triggered',
                alert: testAlert
            });

            logger.info(`🧪 Test alert processed: ${testAlert.token.symbol}`);
        });

        // Catch-all for undefined routes
        this.app.use('*', (req, res) => {
            res.status(404).json({
                error: 'Endpoint not found',
                path: req.originalUrl,
                available: [
                    'GET /health',
                    'GET /status', 
                    'POST /webhook/alert',
                    'POST /webhook/test'
                ]
            });
        });
    }

    validateAlert(alert) {
        if (!alert || typeof alert !== 'object') {
            return { valid: false, error: 'Alert must be an object' };
        }

        // Required fields
        const required = [
            'token.address',
            'token.symbol', 
            'twitter.likes'
        ];

        for (const field of required) {
            const keys = field.split('.');
            let obj = alert;
            
            for (const key of keys) {
                if (!obj || obj[key] === undefined) {
                    return { valid: false, error: `Missing required field: ${field}` };
                }
                obj = obj[key];
            }
        }

        return { valid: true };
    }

    async processAlert(alert, metadata = {}) {
        try {
            this.stats.alertsProcessed++;
            
            const enhancedAlert = {
                ...alert,
                metadata: {
                    receivedAt: Date.now(),
                    source: metadata.source || 'webhook',
                    ip: metadata.ip,
                    ...metadata
                }
            };

            this.stats.lastAlert = {
                symbol: alert.token.symbol,
                timestamp: Date.now(),
                qualified: false
            };

            this.emit('alertReceived', enhancedAlert);

            const qualified = this.isQualifiedAlert(enhancedAlert);
            this.stats.lastAlert.qualified = qualified;

            if (qualified) {
                this.stats.alertsQualified++;
                this.emit('qualifiedAlert', enhancedAlert);
                
                logger.info(`✅ QUALIFIED: ${alert.token.symbol} - ${alert.twitter.likes} likes, ${alert.twitter.views || 0} views`);
                return { qualified: true, action: 'FORWARDED_TO_TRADING_BOT' };
            } else {
                this.stats.alertsSkipped++;
                const reason = this.getSkipReason(enhancedAlert);
                
                logger.debug(`⏭️ SKIPPED: ${alert.token.symbol} - ${reason}`);
                return { qualified: false, action: 'SKIPPED', reason };
            }

        } catch (error) {
            logger.error(`Error processing alert:`, error);
            throw error;
        }
    }

    // 🚀 SIMPLIFIED: Only check likes and views
    isQualifiedAlert(alert) {
        const minLikes = parseInt(process.env.MIN_TWITTER_LIKES) || 100;
        const minViews = parseInt(process.env.MIN_TWITTER_VIEWS) || 50000;
        
        // Simple qualification: just likes and views
        if (alert.twitter.likes < minLikes) return false;
        if (alert.twitter.views > 0 && alert.twitter.views < minViews) return false;
        
        return true;
    }

    // 🚀 SIMPLIFIED: Only check likes and views for skip reason
    getSkipReason(alert) {
        const minLikes = parseInt(process.env.MIN_TWITTER_LIKES) || 100;
        const minViews = parseInt(process.env.MIN_TWITTER_VIEWS) || 50000;
        
        if (alert.twitter.likes < minLikes) return `Likes too low: ${alert.twitter.likes} < ${minLikes}`;
        if (alert.twitter.views > 0 && alert.twitter.views < minViews) return `Views too low: ${alert.twitter.views} < ${minViews}`;
        return 'Unknown reason';
    }

    updateStats(processingTime) {
        this.stats.totalProcessingTime += processingTime;
        this.stats.fastestAlert = Math.min(this.stats.fastestAlert, processingTime);
        this.stats.slowestAlert = Math.max(this.stats.slowestAlert, processingTime);
    }

    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    async start() {
        if (this.isListening) {
            logger.warn('Webhook listener already running');
            return;
        }

        return new Promise((resolve, reject) => {
            this.server = this.app.listen(this.config.port, (error) => {
                if (error) {
                    logger.error(`❌ Failed to start webhook server:`, error);
                    reject(error);
                } else {
                    this.isListening = true;
                    this.stats.startTime = Date.now();
                    
                    logger.info(`🚀 Webhook server listening on port ${this.config.port}`);
                    logger.info(`📡 Alert endpoint: http://localhost:${this.config.port}/webhook/alert`);
                    logger.info(`❤️ Health check: http://localhost:${this.config.port}/health`);
                    logger.info(`🎯 SIMPLIFIED: Only checking likes/views (no risk scoring)`);
                    
                    resolve();
                }
            });

            this.server.on('error', (error) => {
                logger.error('Webhook server error:', error);
                this.emit('error', error);
            });
        });
    }

    async stop() {
        if (!this.isListening || !this.server) {
            return;
        }

        return new Promise((resolve) => {
            this.server.close(() => {
                this.isListening = false;
                logger.info('🛑 Webhook server stopped');
                resolve();
            });
        });
    }

    getStats() {
        const uptime = Date.now() - this.stats.startTime;
        
        return {
            ...this.stats,
            uptime,
            isListening: this.isListening,
            port: this.config.port,
            fastestAlert: this.stats.fastestAlert === Infinity ? 0 : this.stats.fastestAlert,
            avgProcessingTime: this.stats.alertsProcessed > 0 ? 
                (this.stats.totalProcessingTime / this.stats.alertsProcessed) : 0,
            successRate: this.stats.requestsReceived > 0 ? 
                (this.stats.alertsProcessed / this.stats.requestsReceived * 100) : 0,
            qualificationRate: this.stats.alertsProcessed > 0 ? 
                (this.stats.alertsQualified / this.stats.alertsProcessed * 100) : 0
        };
    }
}

module.exports = WebhookListener;