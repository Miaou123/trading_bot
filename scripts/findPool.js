// Optimized Pool Discovery - Based on Benchmark Results
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

class OptimizedPoolDiscovery {
    constructor(heliusRpcUrl) {
        this.heliusRpcUrl = heliusRpcUrl;
        this.connection = new Connection(heliusRpcUrl, 'confirmed');
        this.cache = new Map();
        this.cacheTimeout = 300000; // 5 minutes
        
        // Fixed API endpoints
        this.apis = {
            dexscreener: 'https://api.dexscreener.com/latest/dex',
            jupiter: 'https://price.jup.ag/v6', // Fixed URL
            geckoterminal: 'https://api.geckoterminal.com/api/v2/networks/solana'
        };
        
        // Program IDs with correct PumpSwap
        this.programs = {
            PUMPFUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
            PUMPSWAP: '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
            RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
        };
    }

    // 🏆 PRIMARY METHOD: DexScreener (158ms, 100% success)
    async getPoolFromDexScreener(tokenAddress) {
        try {
            const response = await axios.get(`${this.apis.dexscreener}/tokens/${tokenAddress}`, {
                timeout: 2000, // Reduced timeout for speed
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)',
                    'Accept': 'application/json'
                }
            });

            const data = response.data;
            if (!data.pairs || data.pairs.length === 0) {
                throw new Error('No pairs found');
            }

            // Find Solana pairs and prefer PumpSwap/PumpFun
            const solanaPairs = data.pairs.filter(pair => pair.chainId === 'solana');
            if (solanaPairs.length === 0) {
                throw new Error('No Solana pairs found');
            }

            // Priority: PumpSwap > PumpFun > Raydium > Others
            const priorityOrder = ['pumpswap', 'pumpfun', 'raydium'];
            let selectedPair = null;

            for (const priority of priorityOrder) {
                selectedPair = solanaPairs.find(pair => 
                    pair.dexId?.toLowerCase().includes(priority) ||
                    pair.labels?.some(label => label.toLowerCase().includes(priority))
                );
                if (selectedPair) break;
            }

            // Fallback to first available pair
            selectedPair = selectedPair || solanaPairs[0];

            return {
                poolAddress: selectedPair.pairAddress,
                poolType: selectedPair.dexId,
                source: 'dexscreener',
                priceUsd: selectedPair.priceUsd,
                liquidity: selectedPair.liquidity?.usd,
                volume24h: selectedPair.volume?.h24,
                migrated: selectedPair.dexId !== 'pumpfun'
            };

        } catch (error) {
            throw new Error(`DexScreener failed: ${error.message}`);
        }
    }

    // 🥈 BACKUP METHOD: GeckoTerminal (357ms, 100% success)
    async getPoolFromGeckoTerminal(tokenAddress) {
        try {
            const response = await axios.get(`${this.apis.geckoterminal}/tokens/${tokenAddress}/pools`, {
                timeout: 2000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)'
                }
            });

            const pools = response.data?.data;
            if (!pools || pools.length === 0) {
                throw new Error('No pools found');
            }

            // Find the most liquid pool
            const bestPool = pools.reduce((best, current) => {
                const currentLiquidity = parseFloat(current.attributes?.reserve_in_usd || 0);
                const bestLiquidity = parseFloat(best.attributes?.reserve_in_usd || 0);
                return currentLiquidity > bestLiquidity ? current : best;
            });

            return {
                poolAddress: bestPool.attributes.address,
                poolType: bestPool.attributes.dex_id,
                source: 'geckoterminal',
                marketCapUsd: bestPool.attributes.market_cap_usd,
                liquidityUsd: bestPool.attributes.reserve_in_usd,
                migrated: bestPool.attributes.dex_id !== 'pumpfun'
            };

        } catch (error) {
            throw new Error(`GeckoTerminal failed: ${error.message}`);
        }
    }

    // 🔧 FIXED: Jupiter API (with correct endpoint)
    async getPoolFromJupiter(tokenAddress) {
        try {
            const response = await axios.get(`${this.apis.jupiter}/price`, {
                params: {
                    ids: tokenAddress
                },
                timeout: 1000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)'
                }
            });

            const data = response.data?.data;
            if (!data || !data[tokenAddress]) {
                throw new Error('No price data');
            }

            // Jupiter doesn't provide pool addresses directly, but we can derive info
            return {
                poolAddress: 'jupiter_aggregated',
                poolType: 'jupiter_aggregated',
                source: 'jupiter',
                price: data[tokenAddress].price,
                migrated: false // Jupiter aggregates across all DEXs
            };

        } catch (error) {
            throw new Error(`Jupiter failed: ${error.message}`);
        }
    }

    // 🔧 FIXED: Helius Program Accounts (with better filtering)
    async getPoolFromProgramAccounts(tokenAddress) {
        try {
            // Search PumpSwap first, then PumpFun
            const programsToSearch = [
                { program: this.programs.PUMPSWAP, type: 'pumpswap' },
                { program: this.programs.PUMPFUN, type: 'pumpfun' }
            ];

            for (const { program, type } of programsToSearch) {
                try {
                    const response = await axios.post(this.heliusRpcUrl, {
                        jsonrpc: '2.0',
                        id: 'program-search',
                        method: 'getProgramAccounts',
                        params: [
                            program,
                            {
                                encoding: 'base64',
                                filters: [
                                    {
                                        memcmp: {
                                            offset: 8,
                                            bytes: tokenAddress
                                        }
                                    }
                                ]
                            }
                        ]
                    }, {
                        timeout: 3000,
                        headers: { 'Content-Type': 'application/json' }
                    });

                    const accounts = response.data?.result;
                    if (accounts && accounts.length > 0) {
                        return {
                            poolAddress: accounts[0].pubkey,
                            poolType: type,
                            source: 'helius_program_accounts',
                            programId: program,
                            accountsFound: accounts.length,
                            migrated: type === 'pumpswap'
                        };
                    }
                } catch (error) {
                    console.debug(`${type} search failed:`, error.message);
                }
            }

            throw new Error('No pools found in program accounts');

        } catch (error) {
            throw new Error(`Program accounts search failed: ${error.message}`);
        }
    }

    // 🚀 MAIN METHOD: Waterfall with caching
    async getPoolAddress(tokenAddress, priority = 'normal') {
        // Check cache first
        const cacheKey = `pool_${tokenAddress}`;
        const cached = this.cache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
            return cached.data;
        }

        const methods = this.getMethodsByPriority(priority);
        let lastError = null;

        for (const { name, method, timeout } of methods) {
            try {
                console.debug(`🔍 Trying ${name} for ${tokenAddress}...`);
                const startTime = Date.now();
                
                const result = await this.withTimeout(method(tokenAddress), timeout);
                const duration = Date.now() - startTime;
                
                if (result && result.poolAddress) {
                    console.debug(`✅ ${name} success in ${duration}ms`);
                    
                    // Cache successful result
                    this.cache.set(cacheKey, {
                        data: result,
                        timestamp: Date.now()
                    });
                    
                    return result;
                }
                
            } catch (error) {
                console.debug(`❌ ${name} failed: ${error.message}`);
                lastError = error;
            }
        }

        throw new Error(`All pool discovery methods failed. Last error: ${lastError?.message}`);
    }

    // 🎯 Method priority based on benchmark results
    getMethodsByPriority(priority) {
        const allMethods = [
            { 
                name: 'DexScreener', 
                method: this.getPoolFromDexScreener.bind(this), 
                timeout: 2000 
            },
            { 
                name: 'GeckoTerminal', 
                method: this.getPoolFromGeckoTerminal.bind(this), 
                timeout: 2000 
            },
            { 
                name: 'Jupiter', 
                method: this.getPoolFromJupiter.bind(this), 
                timeout: 1000 
            },
            { 
                name: 'Helius Program Accounts', 
                method: this.getPoolFromProgramAccounts.bind(this), 
                timeout: 3000 
            }
        ];

        switch (priority) {
            case 'critical':
                // Only fastest and most reliable
                return allMethods.slice(0, 2);
            
            case 'fast':
                // Skip slow methods
                return allMethods.slice(0, 3);
            
            case 'comprehensive':
                // Use all methods
                return allMethods;
            
            default: // 'normal'
                // Best balance
                return allMethods.slice(0, 3);
        }
    }

    // Helper: Timeout wrapper
    async withTimeout(promise, timeout) {
        return Promise.race([
            promise,
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
            )
        ]);
    }

    // 🧹 Cache management
    clearCache() {
        this.cache.clear();
    }

    getCacheStats() {
        return {
            size: this.cache.size,
            entries: Array.from(this.cache.keys())
        };
    }

    // 📊 Get pool info with metadata
    async getPoolWithMetadata(tokenAddress, priority = 'normal') {
        try {
            const poolInfo = await this.getPoolAddress(tokenAddress, priority);
            
            // Add useful metadata
            return {
                ...poolInfo,
                tokenAddress,
                timestamp: Date.now(),
                ttl: this.cacheTimeout,
                priority: priority,
                canTrade: poolInfo.poolAddress !== 'jupiter_aggregated', // Jupiter is just pricing
                needsSwapRoute: poolInfo.migrated, // If migrated, might need different swap logic
                confidence: this.calculateConfidence(poolInfo)
            };
            
        } catch (error) {
            throw error;
        }
    }

    // 📈 Calculate confidence score
    calculateConfidence(poolInfo) {
        let score = 50; // Base score
        
        // Source reliability (based on benchmark)
        switch (poolInfo.source) {
            case 'dexscreener': score += 40; break;
            case 'geckoterminal': score += 35; break;
            case 'helius_program_accounts': score += 30; break;
            case 'jupiter': score += 20; break;
            default: score += 10; break;
        }
        
        // Pool type reliability
        if (poolInfo.poolType === 'pumpswap' || poolInfo.poolType === 'pumpfun') {
            score += 10; // Known good types
        }
        
        return Math.min(100, score);
    }
}

module.exports = OptimizedPoolDiscovery;