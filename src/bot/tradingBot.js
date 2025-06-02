// src/bot/tradingBot.js - SIMPLE: Auto pool discovery + debugPrice method + Jupiter fallback
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { AccountLayout } = require('@solana/spl-token');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');

class TradingBot extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            tradingMode: config.tradingMode || process.env.TRADING_MODE || 'paper',
            initialInvestment: parseFloat(config.initialInvestment || process.env.INITIAL_INVESTMENT_SOL) || 0.01,
            stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE) || 50,
            slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 5,
            rpcUrl: process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com',
            privateKey: process.env.PRIVATE_KEY,
            takeProfitLevels: [
                { percentage: 100, sellPercentage: 50 },  // 2x - sell 50%
                { percentage: 300, sellPercentage: 25 },  // 4x - sell 25%
                { percentage: 900, sellPercentage: 100 }  // 10x - sell rest
            ]
        };

        this.positionManager = config.positionManager;
        this.connection = new Connection(this.config.rpcUrl, 'confirmed');
        
        // Jupiter API configuration
        this.JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
        this.SOL_MINT = 'So11111111111111111111111111111111111111112';
        
        // 🚀 OPTIMIZED: Persistent HTTP connections with keep-alive
        this.httpClient = axios.create({
            timeout: 5000,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)',
                'Connection': 'keep-alive',
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate, br'
            },
            // HTTP Keep-Alive agents for persistent connections
            httpAgent: new http.Agent({ 
                keepAlive: true,
                maxSockets: 10,           // Max concurrent connections
                maxFreeSockets: 5,        // Keep 5 connections open
                keepAliveMsecs: 30000,    // Keep alive for 30 seconds
                timeout: 5000
            }),
            httpsAgent: new https.Agent({ 
                keepAlive: true,
                maxSockets: 10,
                maxFreeSockets: 5,
                keepAliveMsecs: 30000,
                timeout: 5000,
                rejectUnauthorized: true
            })
        });
        
        // Initialize wallet for live trading
        this.wallet = null;
        if (this.config.tradingMode === 'live' && this.config.privateKey) {
            this.wallet = this.initializeWallet();
        }
        
        // Price caching
        this.priceCache = new Map();
        this.priceCacheTimeout = 3000; // 3 seconds
        
        // Initialize PumpSwap SDK
        this.pumpAmmSdk = null;
        this.initializePumpSDK();
        
        // Statistics
        this.stats = {
            alertsProcessed: 0,
            tradesExecuted: 0,
            buyOrders: 0,
            sellOrders: 0,
            totalPnL: 0,
            manualPrices: 0,
            jupiterPrices: 0,
            priceFailures: 0,
            poolsFound: 0,
            poolsNotFound: 0,
            httpRequests: 0,
            httpKeepAliveUsed: 0,
            errors: 0
        };

        this.isTradingEnabled = true;
        this.isInitialized = false;
        
        logger.info('🚀 HTTP Keep-Alive connections initialized for faster API calls');
    }

    initializeWallet() {
        try {
            let secretKey;
            const privateKeyString = this.config.privateKey.trim();
            
            if (privateKeyString.startsWith('[')) {
                secretKey = new Uint8Array(JSON.parse(privateKeyString));
            } else {
                secretKey = bs58.decode(privateKeyString);
            }
            
            const wallet = Keypair.fromSecretKey(secretKey);
            logger.info(`💼 Wallet: ${wallet.publicKey.toString()}`);
            return wallet;
        } catch (error) {
            logger.error('❌ Wallet init failed:', error);
            throw error;
        }
    }

    async initializePumpSDK() {
        try {
            const { PumpAmmSdk } = require('@pump-fun/pump-swap-sdk');
            this.pumpAmmSdk = new PumpAmmSdk(this.connection);
            logger.info('✅ PumpSwap SDK initialized');
        } catch (error) {
            logger.warn('⚠️ PumpSwap SDK not available:', error.message);
            this.pumpAmmSdk = null;
        }
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing simple trading bot...');
            logger.info(`💰 Trading mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`🎯 Price System: Auto Pool Discovery + Manual Calculation + Jupiter Fallback`);
            logger.info(`🚀 HTTP: Keep-Alive connections for faster API calls`);
            
            const blockHeight = await this.connection.getBlockHeight();
            logger.info(`📡 Connected to Solana (block: ${blockHeight})`);

            if (this.wallet) {
                const balance = await this.connection.getBalance(this.wallet.publicKey);
                logger.info(`💰 Wallet balance: ${(balance / 1e9).toFixed(4)} SOL`);
            }

            this.isInitialized = true;
            logger.info('✅ Simple trading bot initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize:', error);
            throw error;
        }
    }

    // 🔍 STEP 1: Find pool address using DexScreener API with persistent connections
    async findPoolAddress(tokenAddress) {
        try {
            const startTime = Date.now();
            logger.debug(`🔍 Finding pool for token ${tokenAddress} (keep-alive)...`);
            
            this.stats.httpRequests++;
            
            // Use persistent HTTP client for faster requests
            const response = await this.httpClient.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
            
            // Check if keep-alive was used (connection reused)
            const isKeepAlive = response.request?.connection?.reusedSocket;
            if (isKeepAlive) {
                this.stats.httpKeepAliveUsed++;
                logger.debug('🔗 Keep-alive connection reused');
            }
            
            const duration = Date.now() - startTime;
            
            if (response.data && response.data.pairs && response.data.pairs.length > 0) {
                // Find SOL pairs only
                const solPairs = response.data.pairs.filter(pair => 
                    pair.quoteToken && 
                    (pair.quoteToken.symbol === 'SOL' || pair.quoteToken.symbol === 'WSOL')
                );
                
                if (solPairs.length > 0) {
                    // Get the most liquid pair
                    const bestPair = solPairs.sort((a, b) => {
                        const liquidityA = parseFloat(a.liquidity?.usd || '0');
                        const liquidityB = parseFloat(b.liquidity?.usd || '0');
                        return liquidityB - liquidityA;
                    })[0];
                    
                    this.stats.poolsFound++;
                    logger.debug(`✅ Pool found: ${bestPair.pairAddress} (${duration}ms, ${bestPair.dexId}, ${bestPair.liquidity?.usd || 'N/A'})`);
                    return bestPair.pairAddress;
                }
            }
            
            this.stats.poolsNotFound++;
            logger.debug(`❌ No SOL pool found for ${tokenAddress} (${duration}ms)`);
            return null;
            
        } catch (error) {
            this.stats.poolsNotFound++;
            logger.debug(`❌ Pool discovery failed: ${error.message}`);
            return null;
        }
    }

    // 🔧 STEP 2: Calculate price using debugPrice method (WORKING!)
    async calculatePriceFromPool(tokenAddress, poolAddress) {
        try {
            if (!this.pumpAmmSdk) {
                throw new Error('PumpSwap SDK not available');
            }

            logger.debug(`🔧 Calculating price using pool ${poolAddress}...`);

            // Fetch pool data
            const pool = await this.pumpAmmSdk.fetchPool(new PublicKey(poolAddress));
            if (!pool) {
                throw new Error('Pool not found');
            }

            // Get token account data from Solana RPC
            const [baseAccountInfo, quoteAccountInfo] = await Promise.all([
                this.connection.getAccountInfo(pool.poolBaseTokenAccount),
                this.connection.getAccountInfo(pool.poolQuoteTokenAccount)
            ]);
            
            if (!baseAccountInfo || !quoteAccountInfo) {
                throw new Error('Token account data not found');
            }

            // Parse token amounts using SPL Token layout
            const baseTokenData = AccountLayout.decode(baseAccountInfo.data);
            const quoteTokenData = AccountLayout.decode(quoteAccountInfo.data);
            
            // Convert to readable amounts (exactly like debugPrice.js)
            const baseAmount = parseFloat(baseTokenData.amount.toString()) / Math.pow(10, 6); // Token: 6 decimals
            const quoteAmount = parseFloat(quoteTokenData.amount.toString()) / Math.pow(10, 9); // SOL: 9 decimals
            
            if (baseAmount <= 0 || quoteAmount <= 0) {
                throw new Error(`Invalid pool reserves: ${baseAmount} tokens, ${quoteAmount} SOL`);
            }

            // Calculate price (exactly like debugPrice.js)
            const price = quoteAmount / baseAmount;
            
            this.stats.manualPrices++;
            logger.debug(`✅ Manual price: ${price.toFixed(12)} SOL (${baseAmount.toFixed(2)} tokens, ${quoteAmount.toFixed(6)} SOL)`);
            
            return price;

        } catch (error) {
            logger.debug(`❌ Manual price calculation failed: ${error.message}`);
            return null;
        }
    }

    // 🪐 STEP 3: Jupiter fallback price with persistent connections
    async getJupiterPrice(tokenAddress) {
        try {
            logger.debug(`🪐 Getting Jupiter fallback price for ${tokenAddress}...`);
            
            const testAmount = 1000000; // 0.001 SOL
            
            this.stats.httpRequests++;
            
            // Use persistent HTTP client for Jupiter API too
            const quote = await this.httpClient.get(`${this.JUPITER_API_URL}/quote`, {
                params: {
                    inputMint: this.SOL_MINT,
                    outputMint: tokenAddress,
                    amount: testAmount,
                    slippageBps: 50
                }
            });

            if (!quote.data || !quote.data.outAmount) {
                throw new Error('No Jupiter quote received');
            }

            const tokensReceived = parseFloat(quote.data.outAmount) / Math.pow(10, 6); // Assume 6 decimals
            const price = (testAmount / 1e9) / tokensReceived;

            this.stats.jupiterPrices++;
            logger.debug(`✅ Jupiter price: ${price.toFixed(12)} SOL`);
            
            return price;

        } catch (error) {
            logger.debug(`❌ Jupiter price failed: ${error.message}`);
            return null;
        }
    }

    // 🧠 MAIN: Smart price fetching with auto pool discovery
    async getTokenPrice(tokenAddress, forceRefresh = false) {
        try {
            const now = Date.now();
            
            // Check cache first
            if (!forceRefresh && this.priceCache.has(tokenAddress)) {
                const cached = this.priceCache.get(tokenAddress);
                if (now - cached.timestamp < this.priceCacheTimeout) {
                    return cached.price;
                }
            }

            logger.debug(`💰 Getting price for ${tokenAddress}...`);
            let price = null;
            let source = 'unknown';

            // METHOD 1: Auto discover pool + manual calculation (FAST!)
            const poolAddress = await this.findPoolAddress(tokenAddress);
            if (poolAddress) {
                price = await this.calculatePriceFromPool(tokenAddress, poolAddress);
                if (price) {
                    source = 'manual';
                }
            }

            // METHOD 2: Jupiter fallback (SLOWER but reliable)
            if (!price) {
                logger.debug(`🔄 Manual method failed, trying Jupiter fallback...`);
                price = await this.getJupiterPrice(tokenAddress);
                if (price) {
                    source = 'jupiter';
                }
            }

            if (!price) {
                this.stats.priceFailures++;
                throw new Error('All price methods failed');
            }

            // Cache the result
            this.priceCache.set(tokenAddress, {
                price: price,
                timestamp: now,
                source: source
            });

            logger.debug(`✅ Final price: ${price.toFixed(12)} SOL via ${source}`);
            return price;

        } catch (error) {
            this.stats.priceFailures++;
            this.stats.errors++;
            logger.error(`❌ Price fetch failed for ${tokenAddress}: ${error.message}`);
            throw error;
        }
    }

    // Helper method for position manager
    async getTokenPriceManual(tokenAddress, poolAddress = null) {
        try {
            return await this.getTokenPrice(tokenAddress, true);
        } catch (error) {
            logger.debug(`Position manager price fetch failed: ${error.message}`);
            return null;
        }
    }

    // Calculate stop loss price
    calculateStopLossPrice(entryPrice) {
        return entryPrice * (1 - this.config.stopLossPercentage / 100);
    }

    // Calculate take profit prices
    calculateTakeProfitPrices(entryPrice) {
        return this.config.takeProfitLevels.map((level, index) => ({
            targetPrice: entryPrice * (1 + level.percentage / 100),
            sellPercentage: level.sellPercentage,
            percentage: level.percentage,
            triggered: false,
            level: index + 1
        }));
    }

    // Execute paper buy
    async executePaperBuy(alert, investmentAmount, currentPrice, expectedTokens) {
        const stopLossPrice = this.calculateStopLossPrice(currentPrice);
        const takeProfitPrices = this.calculateTakeProfitPrices(currentPrice);

        const position = {
            id: this.generatePositionId(),
            tokenAddress: alert.token.address,
            symbol: alert.token.symbol,
            side: 'LONG',
            entryPrice: currentPrice,
            quantity: expectedTokens.toString(),
            investedAmount: investmentAmount,
            entryTime: Date.now(),
            txHash: 'PAPER_TRADE_' + Date.now(),
            stopLossPrice: stopLossPrice,
            takeProfitLevels: takeProfitPrices,
            remainingQuantity: expectedTokens.toString(),
            alert: alert,
            paperTrade: true,
            priceSource: this.priceCache.get(alert.token.address)?.source || 'unknown'
        };

        if (this.positionManager) {
            await this.positionManager.addPosition(position);
        }

        this.stats.tradesExecuted++;
        this.stats.buyOrders++;

        const priceSource = position.priceSource === 'manual' ? 'Manual RPC' : 'Jupiter API';
        logger.info(`📝 Paper buy: ${expectedTokens.toFixed(2)} ${alert.token.symbol} @ ${currentPrice.toFixed(12)} SOL (${priceSource})`);
        
        this.emit('tradeExecuted', {
            type: 'PAPER_BUY',
            symbol: alert.token.symbol,
            amount: expectedTokens.toString(),
            price: currentPrice,
            priceSource: priceSource
        });

        return position;
    }

    // Main buy execution
    async executeBuy(alert) {
        try {
            const tokenAddress = alert.token.address;
            const symbol = alert.token.symbol;
            const investmentAmount = this.config.initialInvestment;
            
            logger.info(`💰 Executing BUY: ${investmentAmount} SOL → ${symbol}`);

            // Get current price using smart method
            const currentPrice = await this.getTokenPrice(tokenAddress, true);
            const expectedTokens = investmentAmount / currentPrice;
            
            logger.info(`💎 Trade: ${expectedTokens.toFixed(2)} ${symbol} @ ${currentPrice.toFixed(12)} SOL`);

            // For now, only paper trading (live trading would use Jupiter swap here)
            return await this.executePaperBuy(alert, investmentAmount, currentPrice, expectedTokens);

        } catch (error) {
            logger.error(`❌ Buy execution failed: ${error.message}`);
            this.stats.errors++;
            throw error;
        }
    }

    generatePositionId() {
        return 'pos_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    async processAlert(alert) {
        if (!this.isTradingEnabled || !this.isInitialized) return;

        try {
            this.stats.alertsProcessed++;
            logger.info(`🔔 Processing alert: ${alert.token.symbol}`);

            if (this.positionManager?.hasPosition(alert.token.address)) {
                logger.info(`⏭️ Already have position in ${alert.token.symbol}`);
                return;
            }

            await this.executeBuy(alert);
        } catch (error) {
            logger.error(`❌ Error processing alert: ${error.message}`);
            this.stats.errors++;
        }
    }

    getStats() {
        const keepAliveEfficiency = this.stats.httpRequests > 0 ? 
            ((this.stats.httpKeepAliveUsed / this.stats.httpRequests) * 100).toFixed(1) : '0';

        return {
            ...this.stats,
            config: {
                mode: this.config.tradingMode,
                priceMethod: 'Auto Pool Discovery + Manual Calculation + Jupiter Fallback',
                httpOptimization: 'Keep-Alive Persistent Connections'
            },
            pricing: {
                manualPrices: this.stats.manualPrices,
                jupiterPrices: this.stats.jupiterPrices,
                failures: this.stats.priceFailures,
                poolsFound: this.stats.poolsFound,
                poolsNotFound: this.stats.poolsNotFound
            },
            http: {
                totalRequests: this.stats.httpRequests,
                keepAliveUsed: this.stats.httpKeepAliveUsed,
                keepAliveEfficiency: keepAliveEfficiency + '%'
            }
        };
    }

    pauseTrading() {
        this.isTradingEnabled = false;
        logger.info('⏸️ Trading paused');
    }

    resumeTrading() {
        this.isTradingEnabled = true;
        logger.info('▶️ Trading resumed');
    }

    async stop() {
        this.pauseTrading();
        this.priceCache.clear();
        
        // Clean up HTTP agents
        if (this.httpClient?.defaults?.httpAgent) {
            this.httpClient.defaults.httpAgent.destroy();
        }
        if (this.httpClient?.defaults?.httpsAgent) {
            this.httpClient.defaults.httpsAgent.destroy();
        }
        
        logger.info('🛑 Trading bot stopped (HTTP connections closed)');
    }
}

module.exports = TradingBot;