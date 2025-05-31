// src/bot/tradingBot.js - Enhanced with precise price fetching using PumpSwap SDK
const { PumpAmmSdk, Direction } = require('@pump-fun/pump-swap-sdk');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const { riskConfig, strategyConfig, blockchainConfig, tradingConfig } = require('../config/tradingConfig');
const Big = require('big.js');

class TradingBot extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            tradingMode: config.tradingMode || tradingConfig.mode,
            initialInvestment: config.initialInvestment || tradingConfig.initialInvestment,
            stopLossPercentage: strategyConfig.stopLossPercentage,
            takeProfitLevels: strategyConfig.takeProfitLevels,
            slippageTolerance: strategyConfig.slippageTolerance,
            priceRefreshInterval: tradingConfig.priceUpdateInterval,
            ...config
        };

        // Initialize Solana connection and wallet
        this.connection = new Connection(
            blockchainConfig.rpcUrl,
            blockchainConfig.commitment
        );

        this.wallet = this.initializeWallet();
        this.pumpSdk = new PumpAmmSdk();
        
        this.positionManager = config.positionManager;
        this.riskManager = config.riskManager;
        
        // Price cache for efficiency
        this.priceCache = new Map();
        this.poolCache = new Map();
        this.lastPriceUpdate = new Map();
        
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
            cacheHits: 0,
            errors: 0
        };

        this.initialize();
    }

    initializeWallet() {
        try {
            const privateKeyString = blockchainConfig.privateKey || process.env.PRIVATE_KEY;
            if (!privateKeyString) {
                throw new Error('PRIVATE_KEY environment variable is required');
            }

            // Use your working approach with @coral-xyz/anchor
            const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');
            
            // Trim any whitespace
            const trimmedKey = privateKeyString.trim();
            
            let secretKey;
            let format = 'unknown';
            
            // Check if it's array format [1,2,3,...]
            if (trimmedKey.startsWith('[') && trimmedKey.endsWith(']')) {
                try {
                    const keyArray = JSON.parse(trimmedKey);
                    secretKey = new Uint8Array(keyArray);
                    format = 'array';
                    logger.debug('📋 Detected array format private key');
                } catch (parseError) {
                    throw new Error(`Invalid array format: ${parseError.message}`);
                }
            } 
            // Otherwise assume base58 format
            else {
                try {
                    secretKey = bs58.decode(trimmedKey);
                    format = 'base58';
                    logger.debug('🔑 Detected base58 format private key');
                } catch (decodeError) {
                    throw new Error(`Invalid base58 format: ${decodeError.message}`);
                }
            }
            
            // Validate key length (should be 64 bytes for Solana)
            if (secretKey.length !== 64) {
                throw new Error(`Invalid private key length: ${secretKey.length} bytes (expected 64)`);
            }

            const wallet = Keypair.fromSecretKey(secretKey);
            logger.info(`💼 Wallet initialized: ${wallet.publicKey.toString()} (${format} format)`);
            
            return wallet;
        } catch (error) {
            logger.error('❌ Failed to initialize wallet:', error);
            throw new Error('Failed to initialize wallet. Check your PRIVATE_KEY configuration.');
        }
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing trading bot...');
            
            // Check wallet balance
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const solBalance = balance / 1e9;
            
            logger.info(`💰 Wallet balance: ${solBalance.toFixed(4)} SOL`);
            
            if (solBalance < this.config.initialInvestment) {
                logger.warn(`⚠️ Low wallet balance! Required: ${this.config.initialInvestment} SOL, Available: ${solBalance.toFixed(4)} SOL`);
                
                if (this.config.tradingMode === 'live') {
                    throw new Error('Insufficient SOL balance for trading');
                }
            }

            // Start price monitoring
            this.startPriceMonitoring();

            this.isInitialized = true;
            logger.info('✅ Trading bot initialized successfully');
            
        } catch (error) {
            logger.error('❌ Failed to initialize trading bot:', error);
            throw error;
        }
    }

    // 🔥 NEW: Precise price fetching using PumpSwap SDK with adaptive caching
    async getTokenPrice(tokenAddress, useCache = true, priority = 'normal') {
        try {
            const now = Date.now();
            const cacheKey = tokenAddress;
            
            // Adaptive cache intervals based on priority
            let cacheInterval = this.config.priceRefreshInterval;
            if (priority === 'high') {
                cacheInterval = 500; // 0.5 seconds for high priority
            } else if (priority === 'critical') {
                cacheInterval = 0; // No cache for critical operations
            }
            
            // Check cache first (if enabled and not expired)
            if (useCache && this.priceCache.has(cacheKey) && priority !== 'critical') {
                const lastUpdate = this.lastPriceUpdate.get(cacheKey) || 0;
                if (now - lastUpdate < cacheInterval) {
                    this.stats.cacheHits++;
                    return this.priceCache.get(cacheKey);
                }
            }

            if (this.config.tradingMode === 'paper') {
                // For paper trading, simulate realistic price movement
                const basePrice = 0.0001;
                const volatility = (Math.random() - 0.5) * 0.2; // ±10% movement
                const simulatedPrice = basePrice * (1 + volatility);
                
                this.priceCache.set(cacheKey, simulatedPrice);
                this.lastPriceUpdate.set(cacheKey, now);
                return simulatedPrice;
            }

            // Get the pool for this token
            const pool = await this.findOrGetPool(tokenAddress);
            if (!pool) {
                logger.warn(`No pool found for token ${tokenAddress}`);
                return null;
            }

            // Use PumpSwap SDK to get current price
            // We'll calculate price by seeing how much SOL we get for 1 token
            const oneToken = new Big(1); // 1 token (adjust for decimals if needed)
            
            try {
                // Get quote amount for 1 token (Base to Quote swap)
                const quoteAmount = await this.pumpSdk.swapAutocompleteQuoteFromBase(
                    pool,
                    oneToken,
                    0.5, // Low slippage for price calculation
                    Direction.BaseToQuote
                );

                const price = parseFloat(quoteAmount.toString());
                
                // Cache the price
                this.priceCache.set(cacheKey, price);
                this.lastPriceUpdate.set(cacheKey, now);
                this.stats.priceUpdates++;
                
                logger.debug(`💰 Price for ${tokenAddress}: ${price} SOL`);
                return price;
                
            } catch (swapError) {
                logger.debug(`Could not calculate price via swap simulation: ${swapError.message}`);
                
                // Fallback: Calculate price from pool reserves if available
                const fallbackPrice = this.calculatePriceFromPool(pool);
                if (fallbackPrice) {
                    this.priceCache.set(cacheKey, fallbackPrice);
                    this.lastPriceUpdate.set(cacheKey, now);
                    return fallbackPrice;
                }
                
                return null;
            }

        } catch (error) {
            logger.error(`Error getting token price for ${tokenAddress}:`, error);
            return null;
        }
    }

    // 🔥 NEW: Find or get cached pool for token
    async findOrGetPool(tokenAddress) {
        try {
            // Check pool cache first
            if (this.poolCache.has(tokenAddress)) {
                return this.poolCache.get(tokenAddress);
            }

            // Find the pool for this token paired with SOL
            const solMint = 'So11111111111111111111111111111111111111112';
            
            // TODO: Implement actual pool discovery
            // For now, we'll create a mock pool structure
            // In reality, you'd need to:
            // 1. Find the pool address for the token/SOL pair
            // 2. Fetch the pool state
            // 3. Return the pool object
            
            if (this.config.tradingMode === 'paper') {
                const mockPool = {
                    address: `mock_pool_${tokenAddress}`,
                    baseMint: tokenAddress,
                    quoteMint: solMint,
                    baseReserve: new Big(1000000), // Mock reserves
                    quoteReserve: new Big(100)
                };
                
                this.poolCache.set(tokenAddress, mockPool);
                return mockPool;
            }

            // For live trading, you'll need to implement pool discovery
            // This might involve:
            // - Querying the PumpFun program for pools
            // - Using Solana RPC to find token accounts
            // - Checking pool state and reserves
            
            logger.warn(`Real pool discovery not implemented for ${tokenAddress}`);
            return null;

        } catch (error) {
            logger.error(`Error finding pool for ${tokenAddress}:`, error);
            return null;
        }
    }

    // 🔥 NEW: Calculate price from pool reserves (fallback method)
    calculatePriceFromPool(pool) {
        try {
            if (!pool.baseReserve || !pool.quoteReserve) {
                return null;
            }

            // Price = quoteReserve / baseReserve
            const baseReserve = new Big(pool.baseReserve.toString());
            const quoteReserve = new Big(pool.quoteReserve.toString());
            
            if (baseReserve.eq(0)) {
                return null;
            }

            const price = quoteReserve.div(baseReserve);
            return parseFloat(price.toString());

        } catch (error) {
            logger.error('Error calculating price from pool reserves:', error);
            return null;
        }
    }

    // 🔥 NEW: Start periodic price monitoring
    startPriceMonitoring() {
        setInterval(async () => {
            try {
                // Update prices for all active positions
                if (this.positionManager) {
                    const activePositions = this.positionManager.getActivePositions();
                    
                    if (activePositions.length > 0) {
                        logger.debug(`🔄 Updating prices for ${activePositions.length} positions...`);
                        
                        const pricePromises = activePositions.map(async (position) => {
                            try {
                                const price = await this.getTokenPrice(position.tokenAddress, false); // Force refresh
                                return { position, price };
                            } catch (error) {
                                logger.debug(`Price update failed for ${position.symbol}: ${error.message}`);
                                return { position, price: null };
                            }
                        });

                        const results = await Promise.allSettled(pricePromises);
                        
                        results.forEach((result) => {
                            if (result.status === 'fulfilled' && result.value.price) {
                                const { position, price } = result.value;
                                logger.debug(`💰 ${position.symbol}: ${price.toFixed(8)} SOL`);
                            }
                        });
                    }
                }
            } catch (error) {
                logger.error('Error in price monitoring:', error);
            }
        }, this.config.priceRefreshInterval);

        logger.info(`📊 Price monitoring started (${this.config.priceRefreshInterval / 1000}s intervals)`);
    }

    // 🔥 ENHANCED: Execute buy with precise price calculation
    async executeBuy(alert) {
        try {
            const tokenAddress = alert.token.address;
            const symbol = alert.token.symbol;
            const investmentAmount = this.calculateInvestmentAmount(alert);
            
            logger.info(`💰 Executing BUY: ${investmentAmount} SOL → ${symbol}`);

            if (this.config.tradingMode === 'paper') {
                return await this.executePaperBuy(alert, investmentAmount);
            }

            // Get current price for entry price recording
            const currentPrice = await this.getTokenPrice(tokenAddress, false);
            if (!currentPrice) {
                throw new Error(`Could not determine current price for ${symbol}`);
            }

            // Get pool information
            const pool = await this.findOrGetPool(tokenAddress);
            if (!pool) {
                throw new Error(`No pool found for token ${symbol}`);
            }

            // Calculate expected tokens using PumpSwap SDK
            const investmentBig = new Big(investmentAmount);
            const expectedTokens = await this.pumpSdk.swapAutocompleteBaseFromQuote(
                pool,
                investmentBig,
                this.config.slippageTolerance,
                Direction.QuoteToBase
            );

            // Create swap instructions
            const swapInstructions = await this.pumpSdk.swapInstructions(
                pool,
                expectedTokens,
                this.config.slippageTolerance,
                Direction.QuoteToBase,
                this.wallet.publicKey
            );

            // Execute transaction
            const transaction = this.transactionFromInstructions(swapInstructions);
            const signature = await this.sendAndConfirmTransaction(transaction);

            // Record position with accurate entry price
            const position = {
                id: this.generatePositionId(),
                tokenAddress,
                symbol,
                side: 'LONG',
                entryPrice: currentPrice,
                quantity: expectedTokens.toString(),
                investedAmount: investmentAmount,
                entryTime: Date.now(),
                txHash: signature,
                stopLoss: this.calculateStopLoss(investmentAmount),
                takeProfitLevels: this.calculateTakeProfitLevels(investmentAmount),
                remainingQuantity: expectedTokens.toString(),
                alert: alert
            };

            await this.positionManager.addPosition(position);

            this.stats.tradesExecuted++;
            this.stats.buyOrders++;
            this.stats.totalVolume += investmentAmount;

            logger.info(`✅ BUY executed: ${expectedTokens} ${symbol} for ${investmentAmount} SOL @ ${currentPrice.toFixed(8)} SOL/token (${signature})`);
            
            this.emit('tradeExecuted', {
                type: 'BUY',
                symbol,
                amount: expectedTokens.toString(),
                price: currentPrice,
                signature
            });

            return position;

        } catch (error) {
            logger.error(`❌ Buy execution failed for ${alert.token.symbol}:`, error);
            this.stats.errors++;
            throw error;
        }
    }

    // 🔥 ENHANCED: Execute sell with precise price calculation
    async executeSell(position, sellQuantity, reason = 'Manual') {
        try {
            const sellAmount = new Big(sellQuantity);
            
            logger.info(`💸 Executing SELL: ${sellAmount} ${position.symbol} (${reason})`);

            if (position.paperTrade || this.config.tradingMode === 'paper') {
                return await this.executePaperSell(position, sellAmount, reason);
            }

            // Get current price for accurate valuation
            const currentPrice = await this.getTokenPrice(position.tokenAddress, false);
            if (!currentPrice) {
                logger.warn(`Could not get current price for ${position.symbol}, proceeding with swap anyway`);
            }

            // Get current pool
            const pool = await this.findOrGetPool(position.tokenAddress);
            if (!pool) {
                throw new Error(`No pool found for token ${position.symbol}`);
            }

            // Calculate expected SOL using PumpSwap SDK
            const expectedSol = await this.pumpSdk.swapAutocompleteQuoteFromBase(
                pool,
                sellAmount,
                this.config.slippageTolerance,
                Direction.BaseToQuote
            );

            // Create swap instructions
            const swapInstructions = await this.pumpSdk.swapInstructions(
                pool,
                sellAmount,
                this.config.slippageTolerance,
                Direction.BaseToQuote,
                this.wallet.publicKey
            );

            // Execute transaction
            const transaction = this.transactionFromInstructions(swapInstructions);
            const signature = await this.sendAndConfirmTransaction(transaction);

            // Calculate PnL
            const soldValue = parseFloat(expectedSol.toString());
            const costBasis = (parseFloat(sellAmount.toString()) / parseFloat(position.quantity)) * position.investedAmount;
            const pnl = soldValue - costBasis;

            // Update position
            const updatedPosition = await this.positionManager.updatePositionAfterSell(
                position.id,
                sellAmount.toString(),
                soldValue,
                pnl,
                signature,
                reason
            );

            this.stats.sellOrders++;
            this.stats.totalVolume += soldValue;
            this.stats.totalPnL += pnl;
            
            if (pnl > 0) {
                this.stats.profitableTrades++;
            }

            logger.info(`✅ SELL executed: ${sellAmount} ${position.symbol} for ${soldValue.toFixed(4)} SOL @ ${currentPrice ? currentPrice.toFixed(8) : 'unknown'} SOL/token (PnL: ${pnl.toFixed(4)}) [${signature}]`);
            
            this.emit('tradeExecuted', {
                type: 'SELL',
                symbol: position.symbol,
                amount: sellAmount.toString(),
                value: soldValue,
                price: currentPrice,
                pnl,
                signature
            });

            // Check if position is fully closed
            if (parseFloat(updatedPosition.remainingQuantity) <= 0) {
                this.emit('positionClosed', {
                    symbol: position.symbol,
                    pnl: updatedPosition.totalPnL,
                    holdTime: Date.now() - position.entryTime
                });
            }

            return { soldValue, pnl, signature };

        } catch (error) {
            logger.error(`❌ Sell execution failed for ${position.symbol}:`, error);
            this.stats.errors++;
            throw error;
        }
    }

    // Rest of the methods remain the same...
    async executePaperBuy(alert, investmentAmount) {
        const currentPrice = await this.getTokenPrice(alert.token.address, false);
        const expectedTokens = investmentAmount / currentPrice;
        
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
            paperTrade: true
        };

        await this.positionManager.addPosition(position);

        this.stats.tradesExecuted++;
        this.stats.buyOrders++;
        this.stats.totalVolume += investmentAmount;

        logger.info(`📝 PAPER BUY: ${expectedTokens.toFixed(2)} ${alert.token.symbol} for ${investmentAmount} SOL @ ${currentPrice.toFixed(8)} SOL/token`);
        
        this.emit('tradeExecuted', {
            type: 'PAPER_BUY',
            symbol: alert.token.symbol,
            amount: expectedTokens.toString(),
            price: currentPrice,
            signature: position.txHash
        });

        return position;
    }

    async executePaperSell(position, sellAmount, reason) {
        // Get current price for accurate PnL calculation
        const currentPrice = await this.getTokenPrice(position.tokenAddress, false);
        const soldValue = parseFloat(sellAmount.toString()) * currentPrice;
        
        const costBasis = (parseFloat(sellAmount.toString()) / parseFloat(position.quantity)) * position.investedAmount;
        const pnl = soldValue - costBasis;

        const signature = 'PAPER_SELL_' + Date.now();

        // Update position
        const updatedPosition = await this.positionManager.updatePositionAfterSell(
            position.id,
            sellAmount.toString(),
            soldValue,
            pnl,
            signature,
            reason
        );

        this.stats.sellOrders++;
        this.stats.totalVolume += soldValue;
        this.stats.totalPnL += pnl;
        
        if (pnl > 0) {
            this.stats.profitableTrades++;
        }

        logger.info(`📝 PAPER SELL: ${sellAmount} ${position.symbol} for ${soldValue.toFixed(4)} SOL @ ${currentPrice.toFixed(8)} SOL/token (PnL: ${pnl.toFixed(4)})`);

        this.emit('tradeExecuted', {
            type: 'PAPER_SELL',
            symbol: position.symbol,
            amount: sellAmount.toString(),
            value: soldValue,
            price: currentPrice,
            pnl,
            signature
        });

        if (parseFloat(updatedPosition.remainingQuantity) <= 0) {
            this.emit('positionClosed', {
                symbol: position.symbol,
                pnl: updatedPosition.totalPnL,
                holdTime: Date.now() - position.entryTime
            });
        }

        return { soldValue, pnl, signature };
    }

    // Existing methods remain the same...
    async processAlert(alert) {
        if (!this.isTradingEnabled) {
            logger.debug('Trading is disabled, skipping alert');
            return;
        }

        if (!this.isInitialized) {
            logger.warn('Trading bot not initialized, skipping alert');
            return;
        }

        try {
            this.stats.alertsProcessed++;
            logger.info(`🔔 Processing alert: ${alert.token.symbol} (${alert.confidence})`);

            // Risk management checks
            const riskCheck = await this.riskManager.checkAlert(alert);
            if (!riskCheck.approved) {
                logger.info(`🚫 Alert rejected by risk management: ${riskCheck.reason}`);
                return;
            }

            // Check if we already have a position in this token
            if (this.positionManager.hasPosition(alert.token.address)) {
                logger.info(`⏭️ Already have position in ${alert.token.symbol}, skipping`);
                return;
            }

            // Execute initial buy
            await this.executeBuy(alert);

        } catch (error) {
            logger.error(`❌ Error processing alert for ${alert.token.symbol}:`, error);
            this.stats.errors++;
        }
    }

    calculateInvestmentAmount(alert) {
        let amount = this.config.initialInvestment;
        
        switch (alert.confidence) {
            case 'HIGH': amount *= 1.5; break;
            case 'MEDIUM': amount *= 1.0; break;
            case 'LOW': amount *= 0.7; break;
            case 'VERY_LOW': amount *= 0.5; break;
        }

        if (alert.twitter.likes >= 1000) amount *= 1.2;
        if (alert.twitter.views >= 1000000) amount *= 1.3;

        if (alert.analysis.bundleDetected) amount *= 0.8;
        if (alert.analysis.riskLevel === 'HIGH') amount *= 0.7;

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

    transactionFromInstructions(instructions) {
        logger.warn('transactionFromInstructions not fully implemented');
        return null;
    }

    async sendAndConfirmTransaction(transaction) {
        logger.warn('sendAndConfirmTransaction not fully implemented');
        return 'mock_signature_' + Date.now();
    }

    pauseTrading() {
        this.isTradingEnabled = false;
        logger.info('⏸️ Trading paused');
    }

    resumeTrading() {
        this.isTradingEnabled = true;
        logger.info('▶️ Trading resumed');
    }

    getStats() {
        const winRate = this.stats.tradesExecuted > 0 ? 
            (this.stats.profitableTrades / this.stats.tradesExecuted * 100).toFixed(1) : '0';

        return {
            ...this.stats,
            winRate: winRate + '%',
            avgPnL: this.stats.tradesExecuted > 0 ? 
                (this.stats.totalPnL / this.stats.tradesExecuted).toFixed(4) : '0',
            priceAccuracy: this.stats.priceUpdates > 0 ? 
                ((this.stats.priceUpdates - this.stats.errors) / this.stats.priceUpdates * 100).toFixed(1) + '%' : '0%',
            cacheEfficiency: this.stats.priceUpdates > 0 ? 
                (this.stats.cacheHits / (this.stats.priceUpdates + this.stats.cacheHits) * 100).toFixed(1) + '%' : '0%',
            config: {
                mode: this.config.tradingMode,
                initialInvestment: this.config.initialInvestment,
                stopLoss: this.config.stopLossPercentage + '%',
                takeProfits: this.config.takeProfitLevels.map(tp => 
                    `${tp.percentage}% (sell ${tp.sellPercentage}%)`
                ),
                priceRefreshInterval: this.config.priceRefreshInterval / 1000 + 's'
            }
        };
    }

    // 🔥 NEW: Get current price info for all positions
    async getPositionPrices() {
        if (!this.positionManager) return {};
        
        const activePositions = this.positionManager.getActivePositions();
        const prices = {};
        
        for (const position of activePositions) {
            try {
                const price = await this.getTokenPrice(position.tokenAddress);
                prices[position.symbol] = {
                    current: price,
                    entry: position.entryPrice,
                    change: price && position.entryPrice ? 
                        ((price - position.entryPrice) / position.entryPrice * 100).toFixed(2) + '%' : 'N/A'
                };
            } catch (error) {
                prices[position.symbol] = { current: null, entry: position.entryPrice, change: 'Error' };
            }
        }
        
        return prices;
    }

    // 🔥 NEW: Clear price cache (useful for testing)
    clearPriceCache() {
        this.priceCache.clear();
        this.lastPriceUpdate.clear();
        logger.info('💰 Price cache cleared');
    }

    async stop() {
        this.pauseTrading();
        logger.info('🛑 Trading bot stopped');
    }
}

module.exports = TradingBot;