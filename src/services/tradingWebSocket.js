// src/services/tradingWebSocket.js - MODIFIED: Twitter check disabled for testing
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
        this.connectionId = Math.random().toString(36).substring(7);
        
        // 🔥 TESTING MODE: Disable Twitter checks
        this.disableTwitterCheck = config.disableTwitterCheck !== undefined ? config.disableTwitterCheck : false;
        
        this.botMode = config.botMode || process.env.BOT_MODE || 'both';
        
        this.httpClient = axios.create({
            timeout: 5000,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Connection': 'keep-alive'
            },
            keepAlive: true
        });

        this.metadataCache = new Map();
        
        this.messageStats = {
            received: 0,
            processed: 0,
            creations: 0,
            migrations: 0,
            qualified: 0,
            skipped: 0,
            errors: 0
        };
        
        setInterval(() => this.cleanupCache(), 60000);
    }

    connect() {
        logger.info(`[${this.connectionId}] Connecting to PumpPortal for trading signals...`);
        logger.info(`[${this.connectionId}] 🎯 Bot Mode: ${this.botMode.toUpperCase()}`);
        
        // 🔥 TESTING: Log Twitter check status
        if (this.disableTwitterCheck) {
            logger.info(`[${this.connectionId}] 🚫 TESTING MODE: Twitter checks DISABLED - Will trade ALL tokens!`);
        } else {
            logger.info(`[${this.connectionId}] 🐦 Twitter checks ENABLED - Min likes: ${this.minLikes}`);
        }
        
        this.ws = new WebSocket('wss://pumpportal.fun/api/data');
        
        this.ws.on('open', () => {
            logger.info(`[${this.connectionId}] 🔗 Connected to PumpPortal`);
            this.isConnected = true;
            this.subscribeBasedOnMode();
        });

        this.ws.on('message', async (data) => {
            this.messageStats.received++;
            
            try {
                const message = JSON.parse(data.toString());
                
                if (message.message && message.message.includes('Successfully subscribed')) {
                    logger.info(`[${this.connectionId}] ✅ ${message.message}`);
                    return;
                }
                
                if (message.txType === 'create' && message.mint) {
                    if (this.shouldProcessEventType('creation')) {
                        this.messageStats.creations++;
                        logger.info(`[${this.connectionId}] 🪙 New token: ${message.symbol} - ${message.mint}`);
                        await this.processToken(message, 'creation');
                    } else {
                        logger.debug(`[${this.connectionId}] ⏭️ Ignoring creation (mode: ${this.botMode}): ${message.symbol}`);
                    }
                }
                else if (message.txType === 'migrate' && message.mint) {
                    if (this.shouldProcessEventType('migration')) {
                        this.messageStats.migrations++;
                        logger.info(`[${this.connectionId}] 🔄 Migration: ${message.mint} (pool: ${message.pool || 'unknown'})`);
                        await this.processToken(message, 'migration');
                    } else {
                        logger.debug(`[${this.connectionId}] ⏭️ Ignoring migration (mode: ${this.botMode}): ${message.mint}`);
                    }
                }
                else if (message.txType === 'migration' && message.mint) {
                    if (this.shouldProcessEventType('migration')) {
                        this.messageStats.migrations++;
                        logger.info(`[${this.connectionId}] 🔄 Migration (legacy): ${message.mint}`);
                        await this.processToken(message, 'migration');
                    } else {
                        logger.debug(`[${this.connectionId}] ⏭️ Ignoring legacy migration (mode: ${this.botMode}): ${message.mint}`);
                    }
                }
                else if (message.mint) {
                    logger.debug(`[${this.connectionId}] ❓ Unknown event: ${message.txType || 'NO_TYPE'} for ${message.mint}`);
                }
                
            } catch (error) {
                this.messageStats.errors++;
                logger.error(`[${this.connectionId}] WebSocket parse error:`, error);
            }
        });

        this.ws.on('error', (error) => {
            logger.error(`[${this.connectionId}] WebSocket error:`, error);
        });

        this.ws.on('close', (code, reason) => {
            logger.warn(`[${this.connectionId}] WebSocket closed (${code}: ${reason}), reconnecting in 5s...`);
            this.isConnected = false;
            setTimeout(() => this.connect(), 5000);
        });
    }

    subscribeBasedOnMode() {
        switch (this.botMode) {
            case 'creation':
                this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
                logger.info(`[${this.connectionId}] ✅ Subscribed to CREATION events only`);
                break;
            
            case 'migration':
                this.ws.send(JSON.stringify({ method: 'subscribeMigration' }));
                logger.info(`[${this.connectionId}] ✅ Subscribed to MIGRATION events only`);
                break;
            
            case 'both':
            default:
                this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
                this.ws.send(JSON.stringify({ method: 'subscribeMigration' }));
                logger.info(`[${this.connectionId}] ✅ Subscribed to BOTH creation and migration events`);
                break;
        }
    }

    shouldProcessEventType(eventType) {
        switch (this.botMode) {
            case 'creation':
                return eventType === 'creation';
            case 'migration':
                return eventType === 'migration';
            case 'both':
                return true;
            default:
                logger.warn(`[${this.connectionId}] Unknown bot mode: ${this.botMode}, defaulting to 'both'`);
                return true;
        }
    }

    async processToken(tokenData, eventType = 'creation') {
        this.messageStats.processed++;
        
        try {
            const tokenSymbol = tokenData.symbol || tokenData.mint?.substring(0, 8) || 'UNKNOWN';
            const processingStart = Date.now();
            
            logger.info(`[${this.connectionId}] 🔍 PROCESSING: ${tokenSymbol} (${eventType})`);
            
            // 🔥 TESTING MODE: Skip Twitter check if disabled
            if (this.disableTwitterCheck) {
                logger.info(`[${this.connectionId}] 🚫 TESTING: Skipping Twitter check for ${tokenSymbol} (${eventType})`);
                
                // Emit qualified token immediately without Twitter check
                this.messageStats.qualified++;
                const totalTime = Date.now() - processingStart;
                
                logger.info(`[${this.connectionId}] ✅ QUALIFIED (NO TWITTER CHECK): ${tokenSymbol} (${eventType}) - ${totalTime}ms total`);
                
                const qualifiedData = {
                    eventType: eventType,
                    token: {
                        address: tokenData.mint,
                        symbol: tokenData.symbol || 'UNKNOWN',
                        name: tokenData.name || 'Unknown Token'
                    },
                    twitter: {
                        likes: 999999, // Fake high number to pass any downstream checks
                        url: 'TESTING_MODE_NO_TWITTER_CHECK'
                    },
                    migration: eventType === 'migration' ? {
                        pool: tokenData.pool || 'unknown',
                        signature: tokenData.signature
                    } : undefined,
                    performance: {
                        processingTime: totalTime,
                        likesCheckTime: 0
                    }
                };
                
                this.emit('qualifiedToken', qualifiedData);
                return;
            }
            
            // 🔥 ORIGINAL TWITTER CHECK CODE (when testing mode is disabled)
            const twitterUrl = await this.extractTwitterUrlWithIPFS(tokenData);
            if (!twitterUrl) {
                this.messageStats.skipped++;
                logger.info(`[${this.connectionId}] ⏭️ SKIPPED: ${tokenSymbol} (${eventType}) - No Twitter URL found`);
                return;
            }

            logger.info(`[${this.connectionId}] 🐦 CHECKING: ${tokenSymbol} (${eventType}) - Twitter: ${twitterUrl}`);

            const likesStart = Date.now();
            const likes = await this.checkLikes(twitterUrl);
            const likesTime = Date.now() - likesStart;
            
            if (!likes || likes < this.minLikes) {
                this.messageStats.skipped++;
                logger.info(`[${this.connectionId}] ⏭️ SKIPPED: ${tokenSymbol} (${eventType}) - ${likes} likes < ${this.minLikes} required (${likesTime}ms)`);
                return;
            }

            this.messageStats.qualified++;
            const totalTime = Date.now() - processingStart;
            
            logger.info(`[${this.connectionId}] ✅ QUALIFIED: ${tokenSymbol} (${eventType}) - ${likes} likes ≥ ${this.minLikes} required (${totalTime}ms total)`);
            
            const qualifiedData = {
                eventType: eventType,
                token: {
                    address: tokenData.mint,
                    symbol: tokenData.symbol || 'UNKNOWN',
                    name: tokenData.name || 'Unknown Token'
                },
                twitter: {
                    likes: likes,
                    url: twitterUrl
                },
                migration: eventType === 'migration' ? {
                    pool: tokenData.pool || 'unknown',
                    signature: tokenData.signature
                } : undefined,
                performance: {
                    processingTime: totalTime,
                    likesCheckTime: likesTime
                }
            };
            
            this.emit('qualifiedToken', qualifiedData);

        } catch (error) {
            this.messageStats.errors++;
            logger.error(`[${this.connectionId}] ❌ Error processing ${tokenData.symbol || tokenData.mint}:`, error);
        }
    }

    // 🔥 TESTING METHOD: Enable/disable Twitter checks at runtime
    setTwitterCheckEnabled(enabled) {
        this.disableTwitterCheck = !enabled;
        if (enabled) {
            logger.info(`[${this.connectionId}] 🐦 Twitter checks ENABLED - Min likes: ${this.minLikes}`);
        } else {
            logger.info(`[${this.connectionId}] 🚫 Twitter checks DISABLED - Trading ALL tokens!`);
        }
    }

    // Rest of the methods remain unchanged...
    async extractTwitterUrlWithIPFS(tokenData) {
        const tokenAddress = tokenData.mint;
        
        const directUrl = this.extractDirectTwitterUrl(tokenData);
        if (directUrl) {
            logger.debug(`[${this.connectionId}] ✅ Twitter URL found in WebSocket message: ${directUrl}`);
            return directUrl;
        }

        const ipfsUrl = await this.fetchIPFSMetadata(tokenAddress, tokenData.uri);
        if (ipfsUrl) {
            logger.debug(`[${this.connectionId}] ✅ Twitter URL found in IPFS metadata: ${ipfsUrl}`);
            return ipfsUrl;
        }

        logger.debug(`[${this.connectionId}] ❌ No Twitter URL found anywhere for ${tokenAddress}`);
        return null;
    }

    extractDirectTwitterUrl(tokenData) {
        const fieldsToCheck = ['twitter', 'description', 'website'];
        
        for (const field of fieldsToCheck) {
            if (tokenData[field]) {
                const url = this.findTwitterStatusUrl(tokenData[field]);
                if (url) {
                    logger.debug(`[${this.connectionId}] Found Twitter URL in field '${field}': ${url}`);
                    return url;
                }
            }
        }
        
        return null;
    }

    async fetchIPFSMetadata(tokenAddress, uriFromMessage = null) {
        try {
            if (this.metadataCache.has(tokenAddress)) {
                const cached = this.metadataCache.get(tokenAddress);
                logger.debug(`[${this.connectionId}] 📁 Using cached metadata for ${tokenAddress}`);
                return cached.twitterUrl;
            }

            let metadataUri = uriFromMessage;
            
            if (!metadataUri) {
                metadataUri = await this.getMetadataURI(tokenAddress);
            }
            
            if (!metadataUri) {
                logger.debug(`[${this.connectionId}] ❌ No metadata URI found for ${tokenAddress}`);
                return null;
            }

            if (metadataUri.startsWith('ipfs://')) {
                metadataUri = metadataUri.replace('ipfs://', 'https://ipfs.io/ipfs/');
            } else if (metadataUri.startsWith('ar://')) {
                metadataUri = metadataUri.replace('ar://', 'https://arweave.net/');
            }

            logger.debug(`[${this.connectionId}] 📁 Fetching IPFS metadata: ${metadataUri}`);
            
            const response = await this.httpClient.get(metadataUri);
            const metadata = response.data;
            
            const twitterUrl = this.extractTwitterFromMetadata(metadata);
            
            this.metadataCache.set(tokenAddress, {
                metadata: metadata,
                twitterUrl: twitterUrl,
                timestamp: Date.now()
            });
            
            logger.debug(`[${this.connectionId}] 📁 Metadata cached for ${tokenAddress}, Twitter URL: ${twitterUrl || 'not found'}`);
            return twitterUrl;
            
        } catch (error) {
            logger.debug(`[${this.connectionId}] ❌ IPFS metadata fetch failed for ${tokenAddress}: ${error.message}`);
            this.metadataCache.set(tokenAddress, {
                metadata: null,
                twitterUrl: null,
                timestamp: Date.now()
            });
            return null;
        }
    }

    async getMetadataURI(tokenAddress) {
        try {
            if (!process.env.HELIUS_RPC_URL) {
                logger.debug(`[${this.connectionId}] ❌ No HELIUS_RPC_URL configured`);
                return null;
            }
            
            const response = await this.httpClient.post(process.env.HELIUS_RPC_URL, {
                jsonrpc: '2.0',
                id: 'metadata-uri',
                method: 'getAsset',
                params: { id: tokenAddress }
            });
            
            const uri = response.data?.result?.content?.json_uri;
            logger.debug(`[${this.connectionId}] 📁 Metadata URI from Helius: ${uri || 'not found'}`);
            return uri;
            
        } catch (error) {
            logger.debug(`[${this.connectionId}] ❌ Helius metadata URI fetch failed: ${error.message}`);
            return null;
        }
    }

    extractTwitterFromMetadata(metadata) {
        if (!metadata || typeof metadata !== 'object') {
            return null;
        }
        
        const fieldsToCheck = [
            'twitter',
            'website', 
            'external_url',
            'description',
            'socials.twitter',
            'links.twitter'
        ];
        
        for (const field of fieldsToCheck) {
            const value = this.getNestedValue(metadata, field);
            if (value) {
                const url = this.findTwitterStatusUrl(value);
                if (url) {
                    logger.debug(`[${this.connectionId}] Found Twitter URL in metadata field '${field}': ${url}`);
                    return url;
                }
            }
        }
        
        if (metadata.attributes && Array.isArray(metadata.attributes)) {
            for (const attr of metadata.attributes) {
                if (attr.trait_type && attr.trait_type.toLowerCase().includes('twitter') && attr.value) {
                    const url = this.findTwitterStatusUrl(attr.value);
                    if (url) {
                        logger.debug(`[${this.connectionId}] Found Twitter URL in metadata attribute '${attr.trait_type}': ${url}`);
                        return url;
                    }
                }
            }
        }
        
        return null;
    }

    getNestedValue(obj, path) {
        return path.split('.').reduce((current, key) => {
            return current && current[key] !== undefined ? current[key] : null;
        }, obj);
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
            logger.debug(`[${this.connectionId}] Twitter check failed: ${error.message}`);
            return 0;
        }
    }

    extractTweetId(url) {
        const match = url.match(/status\/(\d+)/);
        return match ? match[1] : null;
    }

    cleanupCache() {
        const now = Date.now();
        const maxAge = 300000;
        const sizeBefore = this.metadataCache.size;
        
        for (const [key, value] of this.metadataCache.entries()) {
            if (now - value.timestamp > maxAge) {
                this.metadataCache.delete(key);
            }
        }
        
        const sizeAfter = this.metadataCache.size;
        if (sizeBefore > sizeAfter) {
            logger.debug(`[${this.connectionId}] 🧹 Cache cleanup: ${sizeBefore} → ${sizeAfter} entries`);
        }
    }

    getStats() {
        return {
            connectionId: this.connectionId,
            isConnected: this.isConnected,
            botMode: this.botMode,
            twitterCheckEnabled: !this.disableTwitterCheck, // 🔥 NEW STAT
            messageStats: this.messageStats,
            cacheSize: this.metadataCache.size,
            minLikes: this.minLikes,
            qualificationRate: this.messageStats.processed > 0 ? 
                (this.messageStats.qualified / this.messageStats.processed * 100).toFixed(1) + '%' : '0%'
        };
    }

    getStatsString() {
        const stats = this.getStats();
        const twitterStatus = stats.twitterCheckEnabled ? `Twitter: ${this.minLikes}+ likes` : 'Twitter: DISABLED';
        return `📊 Trading Bot Stats (${stats.botMode.toUpperCase()} mode, ${twitterStatus}): ${stats.messageStats.received} received | ${stats.messageStats.processed} processed | ${stats.messageStats.creations} creations | ${stats.messageStats.migrations} migrations | ${stats.messageStats.qualified} qualified | ${stats.messageStats.skipped} skipped | ${stats.messageStats.errors} errors | Qualification rate: ${stats.qualificationRate}`;
    }

    disconnect() {
        logger.info(`[${this.connectionId}] Disconnecting trading WebSocket...`);
        
        if (this.ws) {
            this.ws.close();
            this.isConnected = false;
        }
        
        this.metadataCache.clear();
        logger.info(`[${this.connectionId}] Final stats: ${this.getStatsString()}`);
    }
}

module.exports = TradingWebSocket;