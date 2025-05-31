// src/services/tradingWebSocket.js - Updated with creation/migration support
const WebSocket = require('ws');
const EventEmitter = require('events');
const axios = require('axios');
const logger = require('../utils/logger');

class TradingWebSocket extends EventEmitter {
    constructor(config = {}) {
        super();
        this.ws = null;
        this.isConnected = false;
        this.minLikes = config.minLikes || parseInt(process.env.MIN_TWITTER_LIKES) || 100;
        
        this.httpClient = axios.create({
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
    }

    connect() {
        this.ws = new WebSocket('wss://pumpportal.fun/api/data');
        
        this.ws.on('open', () => {
            logger.info('🔗 Connected to PumpPortal');
            this.isConnected = true;
            
            // Subscribe to both creation and migration events
            this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
            this.ws.send(JSON.stringify({ method: 'subscribeMigration' }));
            
            logger.info('✅ Subscribed to creation and migration events');
        });

        this.ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                
                // Skip subscription confirmations
                if (message.message && message.message.includes('Successfully subscribed')) {
                    logger.info(`✅ ${message.message}`);
                    return;
                }
                
                // Handle creation events
                if (message.txType === 'create' && message.mint) {
                    logger.info(`🪙 New token: ${message.symbol} - ${message.mint}`);
                    await this.processToken(message, 'creation');
                }
                // Handle migration events  
                else if (message.txType === 'migration' && message.mint) {
                    logger.info(`🔄 Migration: ${message.mint}`);
                    await this.processToken(message, 'migration');
                }
                // Log unknown events
                else if (message.mint) {
                    logger.debug(`❓ Unknown event: ${message.txType || 'NO_TYPE'} for ${message.mint}`);
                }
                
            } catch (error) {
                logger.error('WebSocket parse error:', error);
            }
        });

        this.ws.on('close', () => {
            logger.warn('WebSocket closed, reconnecting...');
            this.isConnected = false;
            setTimeout(() => this.connect(), 5000);
        });
    }

    async processToken(tokenData, eventType = 'creation') {
        try {
            const tokenSymbol = tokenData.symbol || tokenData.mint?.substring(0, 8) || 'UNKNOWN';
            
            // Extract Twitter URL
            const twitterUrl = this.extractTwitterUrl(tokenData);
            if (!twitterUrl) {
                logger.info(`⏭️ SKIPPED: ${tokenSymbol} (${eventType}) - No Twitter URL found`);
                return;
            }

            logger.info(`🐦 CHECKING: ${tokenSymbol} (${eventType}) - Twitter: ${twitterUrl}`);

            // Check likes
            const likes = await this.checkLikes(twitterUrl);
            
            if (!likes || likes < this.minLikes) {
                logger.info(`⏭️ SKIPPED: ${tokenSymbol} (${eventType}) - ${likes} likes < ${this.minLikes} required`);
                return;
            }

            // Qualified - emit for trading
            logger.info(`✅ QUALIFIED: ${tokenSymbol} (${eventType}) - ${likes} likes ≥ ${this.minLikes} required`);
            
            this.emit('qualifiedToken', {
                eventType: eventType,
                token: {
                    address: tokenData.mint,
                    symbol: tokenData.symbol || 'UNKNOWN',
                    name: tokenData.name || 'Unknown Token'
                },
                twitter: {
                    likes: likes,
                    url: twitterUrl
                }
            });

        } catch (error) {
            logger.error(`❌ Error processing ${tokenData.symbol || tokenData.mint}:`, error);
        }
    }

    extractTwitterUrl(tokenData) {
        // Check direct fields
        if (tokenData.twitter) {
            const url = this.findTwitterStatusUrl(tokenData.twitter);
            if (url) return url;
        }

        // For migrations, we might not have Twitter URL immediately
        // This is where you'd add metadata fetching if needed
        return null;
    }

    findTwitterStatusUrl(text) {
        if (!text || typeof text !== 'string') return null;
        
        const match = text.match(/https?:\/\/(www\.)?(twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/\d+/);
        return match ? match[0] : null;
    }

    async checkLikes(twitterUrl) {
        try {
            const tweetId = this.extractTweetId(twitterUrl);
            if (!tweetId) return 0;

            const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=a`;
            const response = await this.httpClient.get(url, {
                headers: {
                    'Referer': 'https://platform.twitter.com/',
                    'Origin': 'https://platform.twitter.com'
                }
            });

            const likes = parseInt(response.data.favorite_count || response.data.favoriteCount || response.data.like_count) || 0;
            return likes;

        } catch (error) {
            logger.debug(`Twitter check failed: ${error.message}`);
            return 0;
        }
    }

    extractTweetId(url) {
        const match = url.match(/status\/(\d+)/);
        return match ? match[1] : null;
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.isConnected = false;
        }
    }
}

module.exports = TradingWebSocket;