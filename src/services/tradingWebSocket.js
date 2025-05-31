// src/services/tradingWebSocket.js - Updated with IPFS metadata support
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
            timeout: 5000, // 5 second timeout for IPFS
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Connection': 'keep-alive'
            },
            keepAlive: true
        });

        // IPFS metadata cache to avoid repeated fetches
        this.metadataCache = new Map();
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
            
            // Extract Twitter URL with IPFS fallback
            const twitterUrl = await this.extractTwitterUrlWithIPFS(tokenData);
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

    // 🔥 NEW: Extract Twitter URL with IPFS metadata fallback
    async extractTwitterUrlWithIPFS(tokenData) {
        const tokenAddress = tokenData.mint;
        
        // Step 1: Check direct fields in WebSocket message
        const directUrl = this.extractDirectTwitterUrl(tokenData);
        if (directUrl) {
            logger.debug(`✅ Twitter URL found in WebSocket message`);
            return directUrl;
        }

        // Step 2: Fetch IPFS metadata if available
        const ipfsUrl = await this.fetchIPFSMetadata(tokenAddress, tokenData.uri);
        if (ipfsUrl) {
            logger.debug(`✅ Twitter URL found in IPFS metadata`);
            return ipfsUrl;
        }

        logger.debug(`❌ No Twitter URL found anywhere for ${tokenAddress}`);
        return null;
    }

    // Extract Twitter URL from direct WebSocket fields
    extractDirectTwitterUrl(tokenData) {
        const fieldsToCheck = ['twitter', 'description', 'website'];
        
        for (const field of fieldsToCheck) {
            if (tokenData[field]) {
                const url = this.findTwitterStatusUrl(tokenData[field]);
                if (url) return url;
            }
        }
        
        return null;
    }

    // 🔥 NEW: Fetch IPFS metadata and extract Twitter URL
    async fetchIPFSMetadata(tokenAddress, uriFromMessage = null) {
        try {
            // Check cache first
            if (this.metadataCache.has(tokenAddress)) {
                const cached = this.metadataCache.get(tokenAddress);
                logger.debug(`📁 Using cached metadata for ${tokenAddress}`);
                return cached.twitterUrl;
            }

            let metadataUri = uriFromMessage;
            
            // If no URI in message, get it from Helius
            if (!metadataUri) {
                metadataUri = await this.getMetadataURI(tokenAddress);
            }
            
            if (!metadataUri) {
                logger.debug(`❌ No metadata URI found for ${tokenAddress}`);
                return null;
            }

            logger.debug(`📁 Fetching IPFS metadata: ${metadataUri}`);
            
            // Fetch metadata from IPFS
            const response = await this.httpClient.get(metadataUri);
            const metadata = response.data;
            
            // Extract Twitter URL from metadata
            const twitterUrl = this.extractTwitterFromMetadata(metadata);
            
            // Cache result (even if null)
            this.metadataCache.set(tokenAddress, {
                metadata: metadata,
                twitterUrl: twitterUrl,
                timestamp: Date.now()
            });
            
            return twitterUrl;
            
        } catch (error) {
            logger.debug(`❌ IPFS metadata fetch failed for ${tokenAddress}: ${error.message}`);
            return null;
        }
    }

    // Get metadata URI from Helius API
    async getMetadataURI(tokenAddress) {
        try {
            if (!process.env.HELIUS_RPC_URL) {
                return null;
            }
            
            const response = await this.httpClient.post(process.env.HELIUS_RPC_URL, {
                jsonrpc: '2.0',
                id: 'metadata-uri',
                method: 'getAsset',
                params: { id: tokenAddress }
            });
            
            const uri = response.data?.result?.content?.json_uri;
            logger.debug(`📁 Metadata URI from Helius: ${uri}`);
            return uri;
            
        } catch (error) {
            logger.debug(`❌ Helius metadata URI fetch failed: ${error.message}`);
            return null;
        }
    }

    // Extract Twitter URL from IPFS metadata
    extractTwitterFromMetadata(metadata) {
        if (!metadata || typeof metadata !== 'object') {
            return null;
        }
        
        // Check common fields where Twitter URL might be stored
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
                if (url) return url;
            }
        }
        
        // Check attributes array
        if (metadata.attributes && Array.isArray(metadata.attributes)) {
            for (const attr of metadata.attributes) {
                if (attr.trait_type && attr.trait_type.toLowerCase().includes('twitter') && attr.value) {
                    const url = this.findTwitterStatusUrl(attr.value);
                    if (url) return url;
                }
            }
        }
        
        return null;
    }

    // Helper: Get nested object value
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
            logger.debug(`Twitter check failed: ${error.message}`);
            return 0;
        }
    }

    extractTweetId(url) {
        const match = url.match(/status\/(\d+)/);
        return match ? match[1] : null;
    }

    // Clean up cache periodically
    cleanupCache() {
        const now = Date.now();
        const maxAge = 300000; // 5 minutes
        
        for (const [key, value] of this.metadataCache.entries()) {
            if (now - value.timestamp > maxAge) {
                this.metadataCache.delete(key);
            }
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.isConnected = false;
        }
        
        // Clean up cache
        this.metadataCache.clear();
    }
}

module.exports = TradingWebSocket;