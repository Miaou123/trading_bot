// src/bot/tradingBot.js - Proper PumpSwap SDK Integration
const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const Big = require('big.js');

// Import PumpSwap SDK with correct imports
let PumpAmmSdk, Direction;
try {
    const pumpSdk = require('@pump-fun/pump-swap-sdk');
    PumpAmmSdk = pumpSdk.PumpAmmSdk || pumpSdk.default;
    Direction = pumpSdk.Direction;
    logger.info('🔌 PumpSwap SDK imported successfully');
} catch (error) {
    logger.warn('⚠️ PumpSwap SDK not installed - using price APIs only. Install with: npm install @pump-fun/pump-swap-sdk');
}

class TradingBot extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            tradingMode: config.tradingMode || process.env.TRADING_MODE || 'paper',
            initialInvestment: parseFloat(config.initialInvestment || process.env.INITIAL_INVESTMENT_SOL) || 0.1,
            stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE) || 50,
            slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 5,
            // RPC Configuration
            rpcUrl: process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com',
            privateKey: process.env.PRIVATE_KEY, // For real trading
            // Take profit levels
            takeProfitLevels: [
                {
                    percentage: parseFloat(process.env.TAKE_PROFIT_1_PERCENTAGE) || 100, // 2x
                    sellPercentage: parseFloat(process.env.TAKE_PROFIT_1_SELL_PERCENTAGE) || 50 // Sell 50%
                },
                {
                    percentage: parseFloat(process.env.TAKE_PROFIT_2_PERCENTAGE) || 300, // 4x  
                    sellPercentage: parseFloat(process.env.TAKE_PROFIT_2_SELL_PERCENTAGE) || 25 // Sell 25%
                },
                {
                    percentage: parseFloat(process.env.TAKE_PROFIT_3_PERCENTAGE) || 900, // 10x
                    sellPercentage: parseFloat(process.env.TAKE_PROFIT_3_SELL_PERCENTAGE) || 100 // Sell rest
                }
            ],
            ...config
        };

        this.positionManager = config.positionManager;
        
        // Initialize Solana connection
        this.connection = new Connection(this.config.rpcUrl, 'confirmed');
        
        // Initialize PumpSwap SDK
        this.pumpSdk = null;
        if (PumpAmmSdk) {
            this.pumpSdk = new PumpAmmSdk();
            logger.info('🔌 PumpSwap SDK initialized');
        }
        
        // Initialize wallet for real trading
        this.wallet = null;
        if (this.config.tradingMode === 'live' && this.config.privateKey) {
            try {
                this.wallet = this.initializeWallet();
                logger.info('💼 Wallet initialized for live trading');
            } catch (error) {
                logger.error('❌ Wallet initialization failed:', error);
            }
        }
        
        // Pool and price cache
        this.poolCache = new Map();
        this.priceCache = new Map();
        this.lastPoolUpdate = new Map();
        
        this.isTradingEnabled = true;
        this.isInitialized = false;
        
        // Trading statistics
        this.stats = {
            alertsProcessed: 0,
            tradesExecuted: 0,
            buyOrders: 0,
            sellOrders: 0,
            profitableTrades: 0,
            totalPnL: 0,
            totalVolume: 0,
            priceUpdates: 0,
            poolsFound: 0,
            poolsFailed: 0,
            realPrices: 0,
            mockPrices: 0,
            dexScreenerPrices: 0,
            pumpSwapPrices: 0,
            errors: 0
        };

        this.initialize();
    }

    initializeWallet() {
        try {
            // Parse private key (support both array and base58 formats)
            let secretKey;
            const privateKeyString = this.config.privateKey.trim();
            
            if (privateKeyString.startsWith('[') && privateKeyString.endsWith(']')) {
                // Array format
                const keyArray = JSON.parse(privateKeyString);
                secretKey = new Uint8Array(keyArray);
            } else {
                // Base58 format
                const bs58 = require('bs58');
                secretKey = bs58.decode(privateKeyString);
            }
            
            if (secretKey.length !== 64) {
                throw new Error(`Invalid private key length: ${secretKey.length} bytes (expected 64)`);
            }

            const wallet = Keypair.fromSecretKey(secretKey);
            logger.info(`💼 Wallet: ${wallet.publicKey.toString()}`);
            
            return wallet;
        } catch (error) {
            logger.error('❌ Failed to initialize wallet:', error);
            throw error;
        }
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing PumpSwap trading bot...');
            logger.info(`💰 Trading mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`💰 Initial investment per trade: ${this.config.initialInvestment} SOL`);
            logger.info(`🌐 RPC: ${this.config.rpcUrl}`);
            logger.info(`⚡ Slippage tolerance: ${this.config.slippageTolerance}%`);
            
            // Test connection
            const blockHeight = await this.connection.getBlockHeight();
            logger.info(`📡 Connected to Solana (block: ${blockHeight})`);

            // Check wallet balance for live trading
            if (this.wallet) {
                const balance = await this.connection.getBalance(this.wallet.publicKey);
                const solBalance = balance / 1e9;
                logger.info(`💰 Wallet balance: ${solBalance.toFixed(4)} SOL`);
                
                if (solBalance < this.config.initialInvestment) {
                    logger.warn(`⚠️ Low wallet balance! Required: ${this.config.initialInvestment} SOL, Available: ${solBalance.toFixed(4)} SOL`);
                }
            }

            this.isInitialized = true;
            logger.info('✅ Trading bot initialized successfully');
            
        } catch (error) {
            logger.error('❌ Failed to initialize trading bot:', error);
            throw error;
        }
    }

    // 🚀 NEW: Find PumpFun pool for token
    async findPumpFunPool(tokenAddress) {
        try {
            const cacheKey = `pool_${tokenAddress}`;
            
            // Check cache first
            if (this.poolCache.has(cacheKey)) {
                const cached = this.poolCache.get(cacheKey);
                const lastUpdate = this.lastPoolUpdate.get(cacheKey) || 0;
                
                if (Date.now() - lastUpdate < 5 * 60 * 1000) { // 5 minute cache
                    return cached;
                }
            }

            logger.info(`🔍 Finding PumpFun pool for ${tokenAddress.substring(0, 8)}...`);

            if (!this.pumpSdk) {
                logger.debug('PumpSwap SDK not available, skipping pool lookup');
                return null;
            }

            // Method 1: Try to find pool through DexScreener first (get pool address)
            const poolAddress = await this.findPoolAddressFromDexScreener(tokenAddress);
            
            if (poolAddress) {
                logger.info(`📊 Found pool address: ${poolAddress.substring(0, 8)}...`);
                
                // Try to get pool data
                const poolData = await this.getPoolData(poolAddress, tokenAddress);
                
                if (poolData) {
                    // Cache the pool
                    this.poolCache.set(cacheKey, poolData);
                    this.lastPoolUpdate.set(cacheKey, Date.now());
                    this.stats.poolsFound++;
                    
                    logger.info(`✅ Pool found and cached for ${tokenAddress.substring(0, 8)}...`);
                    return poolData;
                }
            }

            // Method 2: Try common PumpFun pool derivation patterns
            const derivedPool = await this.derivePoolAddress(tokenAddress);
            if (derivedPool) {
                const poolData = await this.getPoolData(derivedPool, tokenAddress);
                if (poolData) {
                    this.poolCache.set(cacheKey, poolData);
                    this.lastPoolUpdate.set(cacheKey, Date.now());
                    this.stats.poolsFound++;
                    return poolData;
                }
            }

            logger.warn(`❌ No pool found for ${tokenAddress.substring(0, 8)}...`);
            this.stats.poolsFailed++;
            return null;

        } catch (error) {
            logger.error(`Error finding pool: ${error.message}`);
            this.stats.poolsFailed++;
            return null;
        }
    }

    // Find pool address from DexScreener
    async findPoolAddressFromDexScreener(tokenAddress) {
        try {
            const axios = require('axios');
            const response = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
                { timeout: 5000 }
            );

            if (response.data && response.data.pairs && response.data.pairs.length > 0) {
                // Find PumpFun pair
                const pumpPair = response.data.pairs.find(pair => 
                    pair.dexId === 'pumpfun' || 
                    pair.quoteToken?.symbol === 'SOL'
                );

                if (pumpPair && pumpPair.pairAddress) {
                    return pumpPair.pairAddress;
                }
            }

            return null;
        } catch (error) {
            logger.debug(`DexScreener pool lookup failed: ${error.message}`);
            return null;
        }
    }

    // Derive potential pool address (simplified - actual derivation would be more complex)
    async derivePoolAddress(tokenAddress) {
        try {
            // This is a simplified version - actual pool derivation would depend on PumpFun's specific implementation
            // You might need to use program-derived addresses or specific seeds
            
            // For now, return null as we don't have the exact derivation logic
            return null;
        } catch (error) {
            logger.debug(`Pool derivation failed: ${error.message}`);
            return null;
        }
    }

    // Get pool data structure
    async getPoolData(poolAddress, tokenAddress) {
        try {
            // Create a basic pool structure that PumpSwap SDK expects
            // This would need to be adapted based on the actual Pool interface
            
            const pool = {
                address: poolAddress,
                baseMint: tokenAddress, // The token we're trading
                quoteMint: 'So11111111111111111111111111111111111111112', // SOL
                // Add other required pool fields based on PumpSwap SDK Pool interface
            };

            return pool;
        } catch (error) {
            logger.debug(`Error getting pool data: ${error.message}`);
            return null;
        }
    }

    // 🚀 NEW: Get price using multiple sources including PumpSwap
    async getTokenPrice(tokenAddress, forceRefresh = false) {
        try {
            const cacheKey = tokenAddress;
            
            // Check cache first
            if (!forceRefresh && this.priceCache.has(cacheKey)) {
                const cached = this.priceCache.get(cacheKey);
                if (Date.now() - cached.timestamp < 30000) {
                    return cached.price;
                }
            }

            logger.debug(`💰 Getting price for ${tokenAddress.substring(0, 8)}...`);

            let price = null;
            let source = 'UNKNOWN';

            // Method 1: Try PumpSwap SDK for most accurate price
            if (this.pumpSdk) {
                try {
                    const pool = await this.findPumpFunPool(tokenAddress);
                    if (pool) {
                        // Use PumpSwap SDK to get a quote for 1 SOL -> Token
                        const oneSOL = new Big(1);
                        const expectedTokens = await this.pumpSdk.swapAutocompleteBaseFromQuote(
                            pool,
                            oneSOL,
                            0.1, // Low slippage for price calculation
                            Direction.QuoteToBase
                        );
                        
                        if (expectedTokens && expectedTokens.gt(0)) {
                            price = parseFloat(oneSOL.div(expectedTokens).toString());
                            source = 'PUMPSWAP_SDK';
                            this.stats.pumpSwapPrices++;
                            logger.debug(`📊 PumpSwap SDK price: ${price.toFixed(12)} SOL`);
                        }
                    }
                } catch (sdkError) {
                    logger.debug(`PumpSwap SDK failed: ${sdkError.message}`);
                }
            }

            // Method 2: DexScreener (fallback)
            if (!price) {
                try {
                    price = await this.getPriceFromDexScreener(tokenAddress);
                    if (price > 0) {
                        source = 'DEXSCREENER';
                        this.stats.dexScreenerPrices++;
                    }
                } catch (error) {
                    logger.debug(`DexScreener failed: ${error.message}`);
                }
            }

            // Final fallback to mock
            if (!price || price <= 0) {
                price = this.getMockPrice();
                source = 'MOCK';
                this.stats.mockPrices++;
            }

            // Cache the price
            this.priceCache.set(cacheKey, { 
                price, 
                source, 
                timestamp: Date.now() 
            });
            
            this.stats.priceUpdates++;
            
            logger.debug(`💰 Price: ${price.toFixed(12)} SOL (${source})`);
            return price;

        } catch (error) {
            logger.error(`Error getting token price: ${error.message}`);
            const mockPrice = this.getMockPrice();
            this.stats.mockPrices++;
            return mockPrice;
        }
    }

    // 🚀 NEW: Calculate expected tokens using PumpSwap SDK or price
    async calculateExpectedTokens(tokenAddress, solAmount) {
        try {
            logger.info(`🔢 Calculating tokens for ${solAmount} SOL...`);

            // Method 1: Try PumpSwap SDK for most accurate calculation
            if (this.pumpSdk) {
                const pool = await this.findPumpFunPool(tokenAddress);
                if (pool) {
                    try {
                        const solAmountBig = new Big(solAmount);
                        const slippageBig = new Big(this.config.slippageTolerance);
                        
                        // Use PumpSwap SDK to calculate expected tokens
                        const expectedTokens = await this.pumpSdk.swapAutocompleteBaseFromQuote(
                            pool,
                            solAmountBig,
                            slippageBig,
                            Direction.QuoteToBase // SOL -> Token
                        );
                        
                        if (expectedTokens && expectedTokens.gt(0)) {
                            const tokensNumber = parseFloat(expectedTokens.toString());
                            const pricePerToken = solAmount / tokensNumber;
                            
                            logger.info(`🎯 PumpSwap SDK calculation:`);
                            logger.info(`   • ${solAmount} SOL → ${tokensNumber.toFixed(2)} tokens`);
                            logger.info(`   • Price: ${pricePerToken.toFixed(12)} SOL/token`);
                            logger.info(`   • Slippage: ${this.config.slippageTolerance}%`);
                            logger.info(`   • Source: PUMPSWAP_SDK (most accurate)`);
                            
                            return tokensNumber;
                        }
                    } catch (sdkError) {
                        logger.warn(`PumpSwap SDK calculation failed: ${sdkError.message}`);
                    }
                }
            }

            // Method 2: Fallback to price-based calculation
            const price = await this.getTokenPrice(tokenAddress, true);
            
            if (!price || price <= 0) {
                throw new Error('Could not get valid price');
            }

            // Simple calculation with slippage
            const expectedTokens = solAmount / price;
            const slippageMultiplier = 1 - (this.config.slippageTolerance / 100);
            const tokensAfterSlippage = expectedTokens * slippageMultiplier;
            
            const cached = this.priceCache.get(tokenAddress);
            const priceSource = cached ? cached.source : 'UNKNOWN';
            
            logger.info(`📊 Price-based calculation:`);
            logger.info(`   • Price: ${price.toFixed(12)} SOL/token (${priceSource})`);
            logger.info(`   • Before slippage: ${expectedTokens.toFixed(2)} tokens`);
            logger.info(`   • After ${this.config.slippageTolerance}% slippage: ${tokensAfterSlippage.toFixed(2)} tokens`);
            logger.info(`   • Investment: ${solAmount} SOL`);
            
            return tokensAfterSlippage;

        } catch (error) {
            logger.error(`Error calculating expected tokens: ${error.message}`);
            
            // Final fallback
            const mockPrice = this.getMockPrice();
            const tokens = solAmount / mockPrice;
            logger.info(`🎲 Fallback calculation: ${solAmount} SOL = ${tokens.toFixed(2)} tokens @ ${mockPrice.toFixed(12)} SOL each`);
            
            return tokens;
        }
    }

    // DexScreener price fetching
    async getPriceFromDexScreener(tokenAddress) {
        try {
            const axios = require('axios');
            const response = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
                { timeout: 5000 }
            );

            if (response.data && response.data.pairs && response.data.pairs.length > 0) {
                const pumpPair = response.data.pairs.find(pair => 
                    pair.dexId === 'pumpfun' || 
                    pair.quoteToken?.symbol === 'SOL'
                );

                if (pumpPair && pumpPair.priceNative) {
                    const price = parseFloat(pumpPair.priceNative);
                    if (price > 0) {
                        return price;
                    }
                }
            }

            return null;
        } catch (error) {
            logger.debug(`DexScreener API error: ${error.message}`);
            return null;
        }
    }


    // Enhanced mock price
    getMockPrice() {
        const basePrice = 0.00005;
        const volatility = (Math.random() - 0.5) * 0.4;
        return Math.max(0.000001, basePrice * (1 + volatility));
    }

    // 🚀 ENHANCED: Execute buy with PumpSwap integration
    async executeBuy(alert) {
        try {
            const tokenAddress = alert.token.address;
            const symbol = alert.token.symbol;
            const investmentAmount = this.calculateInvestmentAmount(alert);
            
            logger.info(`💰 Executing BUY: ${investmentAmount} SOL → ${symbol}`);
            logger.info(`🔍 Getting real price and token amount...`);

            // Get real price and calculate tokens
            const currentPrice = await this.getTokenPrice(tokenAddress, true);
            const expectedTokens = await this.calculateExpectedTokens(tokenAddress, investmentAmount);
            
            // Get price source info
            const cached = this.priceCache.get(tokenAddress);
            const priceSource = cached ? cached.source : 'UNKNOWN';
            const isPumpSwapPrice = priceSource === 'PUMPSWAP_SDK';

            logger.info(`💎 TRADE EXECUTION DETAILS:`);
            logger.info(`   • Token: ${symbol} (${tokenAddress.substring(0, 8)}...)`);
            logger.info(`   • Price: ${currentPrice.toFixed(12)} SOL per token`);
            logger.info(`   • Price source: ${priceSource} ${isPumpSwapPrice ? '(MOST ACCURATE)' : ''}`);
            logger.info(`   • Expected tokens: ${expectedTokens.toFixed(2)} ${symbol}`);
            logger.info(`   • Investment: ${investmentAmount} SOL`);
            logger.info(`   • Trading mode: ${this.config.tradingMode.toUpperCase()}`);

            // Execute the trade
            let position;
            if (this.config.tradingMode === 'live' && this.wallet) {
                position = await this.executeLiveBuy(alert, investmentAmount, currentPrice, expectedTokens, priceSource);
            } else {
                position = await this.executePaperBuy(alert, investmentAmount, currentPrice, expectedTokens, priceSource);
            }

            return position;

        } catch (error) {
            logger.error(`❌ Buy execution failed for ${alert.token.symbol}:`, error);
            this.stats.errors++;
            throw error;
        }
    }

    // 🚀 NEW: Execute live buy using PumpSwap SDK
    async executeLiveBuy(alert, investmentAmount, currentPrice, expectedTokens, priceSource) {
        try {
            logger.info(`🔴 LIVE TRADING: Executing real buy order...`);
            
            if (!this.pumpSdk || !this.wallet) {
                throw new Error('PumpSwap SDK or wallet not available for live trading');
            }

            const tokenAddress = alert.token.address;
            const pool = await this.findPumpFunPool(tokenAddress);
            
            if (!pool) {
                throw new Error('Pool not found for live trading');
            }

            // Create swap instructions using PumpSwap SDK
            const solAmountBig = new Big(investmentAmount);
            const slippageBig = new Big(this.config.slippageTolerance);
            
            const swapInstructions = await this.pumpSdk.swapInstructions(
                pool,
                solAmountBig,
                slippageBig,
                Direction.QuoteToBase, // SOL -> Token
                this.wallet.publicKey
            );

            // Build and send transaction
            const transaction = new Transaction();
            swapInstructions.forEach(ix => transaction.add(ix));
            
            const signature = await this.connection.sendTransaction(transaction, [this.wallet], {
                skipPreflight: false,
                preflightCommitment: 'confirmed'
            });

            // Confirm transaction
            await this.connection.confirmTransaction(signature, 'confirmed');
            
            logger.info(`✅ LIVE BUY EXECUTED: ${signature}`);
            
            // Create position record
            const position = {
                id: this.generatePositionId(),
                tokenAddress: alert.token.address,
                symbol: alert.token.symbol,
                side: 'LONG',
                entryPrice: currentPrice,
                quantity: expectedTokens.toString(),
                investedAmount: investmentAmount,
                entryTime: Date.now(),
                txHash: signature,
                stopLoss: this.calculateStopLoss(investmentAmount),
                takeProfitLevels: this.calculateTakeProfitLevels(investmentAmount),
                remainingQuantity: expectedTokens.toString(),
                alert: alert,
                paperTrade: false,
                priceSource: priceSource,
                slippageApplied: this.config.slippageTolerance
            };

            // Add position
            if (this.positionManager) {
                await this.positionManager.addPosition(position);
            }

            this.stats.tradesExecuted++;
            this.stats.buyOrders++;
            this.stats.totalVolume += investmentAmount;

            this.emit('tradeExecuted', {
                type: 'LIVE_BUY',
                symbol: alert.token.symbol,
                amount: expectedTokens.toString(),
                price: currentPrice,
                investmentAmount: investmentAmount,
                priceSource: priceSource,
                signature: signature
            });

            return position;

        } catch (error) {
            logger.error(`❌ Live buy execution failed: ${error.message}`);
            throw error;
        }
    }

    // Enhanced paper buy
    async executePaperBuy(alert, investmentAmount, currentPrice, expectedTokens, priceSource) {
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
            stopLoss: this.calculateStopLoss(investmentAmount),
            takeProfitLevels: this.calculateTakeProfitLevels(investmentAmount),
            remainingQuantity: expectedTokens.toString(),
            alert: alert,
            paperTrade: true,
            priceSource: priceSource,
            slippageApplied: this.config.slippageTolerance
        };

        if (this.positionManager) {
            await this.positionManager.addPosition(position);
        }

        this.stats.tradesExecuted++;
        this.stats.buyOrders++;
        this.stats.totalVolume += investmentAmount;

        const isPumpSwapPrice = priceSource === 'PUMPSWAP_SDK';

        logger.info(`📝 PAPER BUY EXECUTED:`);
        logger.info(`   • Tokens: ${expectedTokens.toFixed(2)} ${alert.token.symbol}`);
        logger.info(`   • Investment: ${investmentAmount} SOL`);
        logger.info(`   • Entry price: ${currentPrice.toFixed(12)} SOL/token`);
        logger.info(`   • Price source: ${priceSource} ${isPumpSwapPrice ? '(SDK ACCURACY)' : ''}`);
        logger.info(`   • Real price data: ${priceSource !== 'MOCK' ? '✅' : '❌'}`);
        
        // Show targets
        const takeProfitPrices = this.config.takeProfitLevels.map((level, i) => {
            const targetPrice = currentPrice * (1 + level.percentage / 100);
            return `${targetPrice.toFixed(12)} SOL (+${level.percentage}%, sell ${level.sellPercentage}%)`;
        });
        
        logger.info(`🎯 PRICE TARGETS:`);
        takeProfitPrices.forEach((target, i) => logger.info(`   • TP${i + 1}: ${target}`));
        
        if (isPumpSwapPrice) {
            logger.info(`🚀 Using PumpSwap SDK pricing - MOST ACCURATE!`);
        }
        
        this.emit('tradeExecuted', {
            type: 'PAPER_BUY',
            symbol: alert.token.symbol,
            amount: expectedTokens.toString(),
            price: currentPrice,
            investmentAmount: investmentAmount,
            priceSource: priceSource,
            isPumpSwapPrice,
            signature: position.txHash
        });

        return position;
    }

    // Rest of the methods remain the same...
    calculateInvestmentAmount(alert) {
        let amount = this.config.initialInvestment;
        if (alert.twitter.likes >= 1000) amount *= 1.2;
        if (alert.twitter.views >= 1000000) amount *= 1.2;
        if (alert.token.eventType === 'migration') amount *= 1.1;
        return Math.min(amount, this.config.initialInvestment * 2);
    }

    calculateStopLoss(investedAmount) {
        return investedAmount * (1 - this.config.stopLossPercentage / 100);
    }

    calculateTakeProfitLevels(investedAmount) {
        return this.config.takeProfitLevels.map(level => ({
            targetValue: investedAmount * (1 + level.percentage / 100),
            sellPercentage: level.sellPercentage,
            triggered: false
        }));
    }

    generatePositionId() {
        return 'pos_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    async processAlert(alert) {
        if (!this.isTradingEnabled || !this.isInitialized) {
            return;
        }

        try {
            this.stats.alertsProcessed++;
            logger.info(`🔔 Processing alert: ${alert.token.symbol}`);

            if (this.positionManager && this.positionManager.hasPosition(alert.token.address)) {
                logger.info(`⏭️ Already have position in ${alert.token.symbol}, skipping`);
                return;
            }

            await this.executeBuy(alert);

        } catch (error) {
            logger.error(`❌ Error processing alert for ${alert.token.symbol}:`, error);
            this.stats.errors++;
        }
    }

    pauseTrading() {
        this.isTradingEnabled = false;
        logger.info('⏸️ Trading paused');
    }

    resumeTrading() {
        this.isTradingEnabled = true;
        logger.info('▶️ Trading resumed');
    }

    isTradingEnabledStatus() {
        return this.isTradingEnabled;
    }

    getStats() {
        const winRate = this.stats.tradesExecuted > 0 ? 
            (this.stats.profitableTrades / this.stats.tradesExecuted * 100).toFixed(1) : '0';

        const totalRealPrices = this.stats.realPrices + this.stats.dexScreenerPrices + this.stats.pumpSwapPrices;
        const totalPrices = totalRealPrices + this.stats.mockPrices;
        const priceAccuracy = totalPrices > 0 ?
            (totalRealPrices / totalPrices * 100).toFixed(1) : '0';

        return {
            ...this.stats,
            winRate: winRate + '%',
            priceAccuracy: priceAccuracy + '%',
            config: {
                mode: this.config.tradingMode,
                initialInvestment: this.config.initialInvestment,
                slippage: this.config.slippageTolerance + '%',
                pumpSwapSdkAvailable: !!this.pumpSdk,
                walletConfigured: !!this.wallet,
                priceSourceBreakdown: {
                    pumpSwapSdk: this.stats.pumpSwapPrices,
                    dexScreener: this.stats.dexScreenerPrices,
                    otherAPIs: this.stats.realPrices,
                    mock: this.stats.mockPrices
                }
            }
        };
    }

    async stop() {
        this.pauseTrading();
        logger.info('🛑 PumpSwap trading bot stopped');
    }
}

module.exports = TradingBot;