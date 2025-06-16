// src/services/tradingWebSocket.js - Direct PumpSwap pool monitoring via Helius (replaces old WebSocket)
const EventEmitter = require('events');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const logger = require('../utils/logger');
const bs58 = require('bs58');

class TradingWebSocket extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.connection = new Connection(
            process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        this.minLikes = config.minLikes || parseInt(process.env.MIN_TWITTER_LIKES) || 100;
        this.connectionId = Math.random().toString(36).substring(7);
        
        // PumpSwap program constants
        this.PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
        this.POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188]; // Pool account discriminator
        
        this.httpClient = axios.create({
            timeout: 5000,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Connection': 'keep-alive'
            },
            keepAlive: true
        });

        // IPFS metadata cache
        this.metadataCache = new Map();
        
        // Track discovered pools to avoid duplicates
        this.knownPools = new Set();
        
        // Stats tracking
        this.stats = {
            poolsDetected: 0,
            migrationsProcessed: 0,
            migrationsQualified: 0,
            migrationsSkipped: 0,
            errors: 0
        };
        
        this.isMonitoring = false;
        
        // Clean up cache periodically
        setInterval(() => this.cleanupCache(), 60000);
    }

    async startMonitoring() {
        try {
            logger.info(`[${this.connectionId}] 🚀 Starting PumpSwap pool monitoring via Helius...`);
            logger.info(`[${this.connectionId}] 🎯 Minimum likes threshold: ${this.minLikes}`);
            
            // Monitor PumpSwap program for new pool accounts
            const subscriptionId = this.connection.onProgramAccountChange(
                this.PUMPSWAP_PROGRAM_ID,
                async (accountInfo, context) => {
                    await this.handleNewPoolAccount(accountInfo, context);
                },
                'confirmed',
                [
                    {
                        memcmp: {
                            offset: 0,
                            bytes: bs58.encode(Buffer.from(this.POOL_DISCRIMINATOR))
                        }
                    }
                ]
            );
            
            this.subscriptionId = subscriptionId;
            this.isMonitoring = true;
            
            logger.info(`[${this.connectionId}] ✅ Monitoring started - subscription ID: ${subscriptionId}`);
            logger.info(`[${this.connectionId}] 🔍 Watching for new PumpSwap pools...`);
            
            return true;
            
        } catch (error) {
            logger.error(`[${this.connectionId}] ❌ Failed to start monitoring:`, error);
            return false;
        }
    }

    async handleNewPoolAccount(accountInfo, context) {
        try {
            const poolAddress = accountInfo.accountId.toString();
            
            // Skip if we've already processed this pool
            if (this.knownPools.has(poolAddress)) {
                return;
            }
            
            this.knownPools.add(poolAddress);
            this.stats.poolsDetected++;
            
            logger.info(`[${this.connectionId}] 🔄 NEW PUMPSWAP POOL DETECTED: ${poolAddress}`);
            
            // Parse pool data to extract token mint
            const tokenMint = await this.extractTokenMintFromPool(accountInfo.accountInfo.data);
            if (!tokenMint) {
                logger.warn(`[${this.connectionId}] ❌ Could not extract token mint from pool ${poolAddress}`);
                this.stats.errors++;
                return;
            }
            
            logger.info(`[${this.connectionId}] 🪙 Token migrated: ${tokenMint} → Pool: ${poolAddress}`);
            
            // Process the migration
            await this.processMigration(tokenMint, poolAddress);
            
        } catch (error) {
            this.stats.errors++;
            logger.error(`[${this.connectionId}] ❌ Error handling new pool:`, error);
        }
    }

    async extractTokenMintFromPool(poolData) {
        try {
            // Pool account structure (from your IDL):
            // pool_bump(1) + index(2) + creator(32) + base_mint(32) + quote_mint(32) + ...
            const baseMintOffset = 8 + 1 + 2 + 32; // Skip discriminator + pool_bump + index + creator
            const baseMintBytes = poolData.slice(baseMintOffset, baseMintOffset + 32);
            const tokenMint = new PublicKey(baseMintBytes);
            
            return tokenMint.toString();
        } catch (error) {
            logger.error(`[${this.connectionId}] ❌ Error extracting token mint:`, error);
            return null;
        }
    }

    async processMigration(tokenMint, poolAddress) {
        this.stats.migrationsProcessed++;
        
        try {
            const processingStart = Date.now();
            
            logger.info(`[${this.connectionId}] 🔍 PROCESSING MIGRATION: ${tokenMint.slice(0, 8)}...`);
            
            // Get token metadata to find Twitter URL
            const twitterUrl = await this.getTokenTwitterUrl(tokenMint);
            if (!twitterUrl) {
                this.stats.migrationsSkipped++;
                logger.info(`[${this.connectionId}] ⏭️ SKIPPED: ${tokenMint.slice(0, 8)}... - No Twitter URL found`);
                return;
            }

            logger.info(`[${this.connectionId}] 🐦 CHECKING TWITTER: ${tokenMint.slice(0, 8)}... - ${twitterUrl}`);

            // Check Twitter likes
            const likesStart = Date.now();
            const likes = await this.checkLikes(twitterUrl);
            const likesTime = Date.now() - likesStart;
            
            if (!likes || likes < this.minLikes) {
                this.stats.migrationsSkipped++;
                logger.info(`[${this.connectionId}] ⏭️ SKIPPED: ${tokenMint.slice(0, 8)}... - ${likes} likes < ${this.minLikes} required (${likesTime}ms)`);
                return;
            }

            // 🚀 QUALIFIED MIGRATION - emit for trading
            this.stats.migrationsQualified++;
            const totalTime = Date.now() - processingStart;
            
            logger.info(`[${this.connectionId}] ✅ QUALIFIED MIGRATION: ${tokenMint.slice(0, 8)}... - ${likes} likes ≥ ${this.minLikes} required (${totalTime}ms total)`);
            
            // Get additional token info
            const tokenInfo = await this.getTokenInfo(tokenMint);
            
            const migrationData = {
                eventType: 'migration',
                token: {
                    address: tokenMint,
                    symbol: tokenInfo.symbol || 'UNKNOWN',
                    name: tokenInfo.name || 'Unknown Token'
                },
                twitter: {
                    likes: likes,
                    url: twitterUrl
                },
                migration: {
                    pool: poolAddress,
                    timestamp: Date.now()
                },
                performance: {
                    processingTime: totalTime,
                    likesCheckTime: likesTime
                }
            };
            
            this.emit('qualifiedToken', migrationData);

        } catch (error) {
            this.stats.errors++;
            logger.error(`[${this.connectionId}] ❌ Error processing migration ${tokenMint}:`, error);
        }
    }

    async getTokenTwitterUrl(tokenMint) {
        try {
            // Get metadata URI from Helius
            const metadataUri = await this.getMetadataURI(tokenMint);
            if (!metadataUri) {
                logger.debug(`[${this.connectionId}] ❌ No metadata URI found for ${tokenMint}`);
                return null;
            }

            // Fetch and parse metadata
            const twitterUrl = await this.fetchMetadataAndExtractTwitter(tokenMint, metadataUri);
            return twitterUrl;
            
        } catch (error) {
            logger.debug(`[${this.connectionId}] ❌ Error getting Twitter URL for ${tokenMint}:`, error.message);
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

    async fetchMetadataAndExtractTwitter(tokenAddress, metadataUri) {
        try {
            // Check cache first
            if (this.metadataCache.has(tokenAddress)) {
                const cached = this.metadataCache.get(tokenAddress);
                logger.debug(`[${this.connectionId}] 📁 Using cached metadata for ${tokenAddress}`);
                return cached.twitterUrl;
            }

            // Convert IPFS URIs to HTTP
            if (metadataUri.startsWith('ipfs://')) {
                metadataUri = metadataUri.replace('ipfs://', 'https://ipfs.io/ipfs/');
            } else if (metadataUri.startsWith('ar://')) {
                metadataUri = metadataUri.replace('ar://', 'https://arweave.net/');
            }

            logger.debug(`[${this.connectionId}] 📁 Fetching metadata: ${metadataUri}`);
            
            // Fetch metadata
            const response = await this.httpClient.get(metadataUri);
            const metadata = response.data;
            
            // Extract Twitter URL
            const twitterUrl = this.extractTwitterFromMetadata(metadata);
            
            // Cache result
            this.metadataCache.set(tokenAddress, {
                metadata: metadata,
                twitterUrl: twitterUrl,
                timestamp: Date.now()
            });
            
            logger.debug(`[${this.connectionId}] 📁 Metadata cached, Twitter URL: ${twitterUrl || 'not found'}`);
            return twitterUrl;
            
        } catch (error) {
            logger.debug(`[${this.connectionId}] ❌ Metadata fetch failed for ${tokenAddress}: ${error.message}`);
            // Cache negative result
            this.metadataCache.set(tokenAddress, {
                metadata: null,
                twitterUrl: null,
                timestamp: Date.now()
            });
            return null;
        }
    }

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
                if (url) {
                    logger.debug(`[${this.connectionId}] Found Twitter URL in metadata field '${field}': ${url}`);
                    return url;
                }
            }
        }
        
        // Check attributes array
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

    async getTokenInfo(tokenMint) {
        try {
            // Try to get token info from Helius
            const response = await this.httpClient.post(process.env.HELIUS_RPC_URL, {
                jsonrpc: '2.0',
                id: 'token-info',
                method: 'getAsset',
                params: { id: tokenMint }
            });
            
            const result = response.data?.result;
            if (result) {
                return {
                    symbol: result.content?.metadata?.symbol || 'UNKNOWN',
                    name: result.content?.metadata?.name || 'Unknown Token'
                };
            }
            
            return { symbol: 'UNKNOWN', name: 'Unknown Token' };
            
        } catch (error) {
            logger.debug(`[${this.connectionId}] Error getting token info: ${error.message}`);
            return { symbol: 'UNKNOWN', name: 'Unknown Token' };
        }
    }

    cleanupCache() {
        const now = Date.now();
        const maxAge = 300000; // 5 minutes
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
            isMonitoring: this.isMonitoring,
            subscriptionId: this.subscriptionId,
            stats: this.stats,
            cacheSize: this.metadataCache.size,
            knownPoolsCount: this.knownPools.size,
            minLikes: this.minLikes,
            qualificationRate: this.stats.migrationsProcessed > 0 ? 
                (this.stats.migrationsQualified / this.stats.migrationsProcessed * 100).toFixed(1) + '%' : '0%'
        };
    }

    getStatsString() {
        const stats = this.getStats();
        return `📊 Migration Monitor: ${stats.stats.poolsDetected} pools detected | ${stats.stats.migrationsProcessed} processed | ${stats.stats.migrationsQualified} qualified | ${stats.stats.migrationsSkipped} skipped | Qualification rate: ${stats.qualificationRate}`;
    }

    async stopMonitoring() {
        try {
            if (this.subscriptionId && this.isMonitoring) {
                await this.connection.removeAccountChangeListener(this.subscriptionId);
                logger.info(`[${this.connectionId}] 🛑 Monitoring stopped - unsubscribed from ${this.subscriptionId}`);
            }
            
            this.isMonitoring = false;
            this.metadataCache.clear();
            this.knownPools.clear();
            
            logger.info(`[${this.connectionId}] Final stats: ${this.getStatsString()}`);
            
        } catch (error) {
            logger.error(`[${this.connectionId}] Error stopping monitoring:`, error);
        }
    }
}

module.exports = TradingWebSocket;