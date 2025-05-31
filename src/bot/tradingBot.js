// src/bot/tradingBot.js - FIXED: Price-based stop loss and take profits
const { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram, VersionedTransaction } = require('@solana/web3.js');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const axios = require('axios');

// Use anchor's bs58 since it's working
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
                { percentage: 100, sellPercentage: 50 },  // 2x (100% gain) - sell 50%
                { percentage: 300, sellPercentage: 25 },  // 4x (300% gain) - sell 25%
                { percentage: 900, sellPercentage: 100 }  // 10x (900% gain) - sell remaining
            ]
        };

        this.positionManager = config.positionManager;
        this.connection = new Connection(this.config.rpcUrl, 'confirmed');
        
        // Jupiter configuration
        this.JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
        this.JUPITER_PRICE_API = 'https://price.jup.ag/v6';
        this.SOL_MINT = 'So11111111111111111111111111111111111111112';
        
        // Initialize wallet for live trading
        this.wallet = null;
        if (this.config.tradingMode === 'live' && this.config.privateKey) {
            this.wallet = this.initializeWallet();
        }
        
        // 🪐 JUPITER PRICE CACHING
        this.priceCache = new Map();
        this.priceCacheTimeout = 3000; // 3 seconds - Jupiter updates every 2-3 seconds
        this.isTradingEnabled = true;
        this.isInitialized = false;
        
        this.stats = {
            alertsProcessed: 0,
            tradesExecuted: 0,
            buyOrders: 0,
            sellOrders: 0,
            totalPnL: 0,
            priceUpdates: 0,
            jupiterPrices: 0,
            priceFailures: 0,
            liveTradesExecuted: 0,
            paperTradesExecuted: 0,
            jupiterQuotes: 0,
            jupiterSwaps: 0,
            priceApiCalls: 0,
            errors: 0
        };

        this.initialize();
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

    async initialize() {
        try {
            logger.info('🔧 Initializing trading bot with fixed price-based stop loss/take profits...');
            logger.info(`💰 Trading mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`📊 Stop Loss: -${this.config.stopLossPercentage}% from entry price`);
            logger.info(`🎯 Take Profits: +${this.config.takeProfitLevels.map(tp => tp.percentage + '%').join(', ')} from entry price`);
            
            if (this.config.tradingMode === 'live') {
                logger.info(`🚀 LIVE TRADING: ✅ Real Jupiter swaps will be executed`);
            } else {
                logger.info(`📝 PAPER TRADES: ✅ Simulating Jupiter swaps without execution`);
            }
            
            const blockHeight = await this.connection.getBlockHeight();
            logger.info(`📡 Connected to Solana (block: ${blockHeight})`);

            if (this.wallet) {
                const balance = await this.connection.getBalance(this.wallet.publicKey);
                logger.info(`💰 Wallet balance: ${(balance / 1e9).toFixed(4)} SOL`);
            }

            // Test Jupiter APIs
            await this.testJupiterConnections();

            this.isInitialized = true;
            logger.info('✅ Trading bot initialized with FIXED price-based triggers');
        } catch (error) {
            logger.error('❌ Failed to initialize:', error);
            throw error;
        }
    }

    async testJupiterConnections() {
        try {
            logger.info('🧪 Testing Jupiter Quote API connection...');
            
            // 🔥 FIXED: Test Quote API only (remove broken Price API test)
            const quoteResponse = await axios.get(`${this.JUPITER_API_URL}/quote`, {
                params: {
                    inputMint: this.SOL_MINT,
                    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                    amount: 1000000, // 0.001 SOL
                    slippageBps: 50
                },
                timeout: 5000
            });
            
            if (quoteResponse.data && quoteResponse.data.outAmount) {
                logger.info('✅ Jupiter Quote API connection successful');
                this.stats.jupiterQuotes++;
            }
            
            // 🔥 Test actual price fetching via Quote API
            logger.info('🧪 Testing price fetching via Quote API...');
            const testPrice = await this.getTokenPriceViaQuote('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
            logger.info(`✅ Quote API price test: ${testPrice.toFixed(8)} SOL`);
            
        } catch (error) {
            logger.warn('⚠️ Jupiter Quote API test failed:', error.message);
            logger.warn('Will retry on actual usage...');
        }
    }

    // 🪐 Get token price using Jupiter Price API
    async getTokenPrice(tokenAddress, forceRefresh = false, priority = 'normal', poolAddress = null) {
        try {
            const now = Date.now();
            
            // Check cache first
            if (!forceRefresh && this.priceCache.has(tokenAddress)) {
                const cached = this.priceCache.get(tokenAddress);
                if (now - cached.timestamp < this.priceCacheTimeout) {
                    return cached.price;
                }
            }
    
            logger.debug(`🪐 Getting Jupiter price for ${tokenAddress} via Quote API...`);
    
            // 🔥 SKIP BROKEN PRICE API - GO DIRECTLY TO QUOTE API
            const price = await this.getTokenPriceViaQuote(tokenAddress);
    
            // Cache the price
            this.priceCache.set(tokenAddress, {
                price: price,
                timestamp: now,
                source: 'Jupiter Quote API'
            });
    
            this.stats.jupiterPrices++;
            this.stats.priceUpdates++;
    
            logger.debug(`✅ Jupiter quote price: ${price.toFixed(12)} SOL`);
            return price;
    
        } catch (error) {
            logger.error(`❌ Jupiter price error for ${tokenAddress}: ${error.message}`);
            this.stats.priceFailures++;
            this.stats.errors++;
            throw error;
        }
    }

    // 🪐 Fallback price method using Jupiter quote
    async getTokenPriceViaQuote(tokenAddress) {
        try {
            const testAmount = 1000000; // 0.001 SOL in lamports
            
            const quote = await this.getJupiterQuote(
                this.SOL_MINT,
                tokenAddress,
                testAmount
            );
    
            // Handle different token decimals properly
            let decimals = 6; // Default assumption
            
            // For well-known tokens, use correct decimals
            if (tokenAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') decimals = 6; // USDC
            if (tokenAddress === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') decimals = 6; // USDT
            if (tokenAddress === 'So11111111111111111111111111111111111111112') decimals = 9; // SOL
    
            const tokensReceived = parseFloat(quote.outAmount) / Math.pow(10, decimals);
            const price = (testAmount / 1e9) / tokensReceived;
    
            logger.debug(`✅ Quote-based price: ${price.toFixed(12)} SOL (${tokensReceived} tokens for 0.001 SOL)`);
            return price;
    
        } catch (error) {
            throw new Error(`Quote method failed: ${error.message}`);
        }
    }

    // Get token price manually for position manager (Jupiter API)
    async getTokenPriceManual(tokenAddress, poolAddress = null) {
        try {
            return await this.getTokenPrice(tokenAddress, true, 'normal', poolAddress);
        } catch (error) {
            logger.debug(`Manual Jupiter price fetch failed for ${tokenAddress}:`, error.message);
            return null;
        }
    }

    // 🪐 Get Jupiter quote for swap
    async getJupiterQuote(inputMint, outputMint, amount, slippageBps = null) {
        try {
            const slippage = slippageBps || (this.config.slippageTolerance * 100); // Convert % to BPS
            
            const params = {
                inputMint,
                outputMint,
                amount: Math.floor(amount).toString(),
                slippageBps: slippage,
                onlyDirectRoutes: false,
                asLegacyTransaction: false
            };

            logger.debug(`🪐 Jupiter quote: ${amount} ${inputMint.substring(0, 8)} → ${outputMint.substring(0, 8)}`);

            const response = await axios.get(`${this.JUPITER_API_URL}/quote`, {
                params,
                timeout: 10000
            });

            if (!response.data) {
                throw new Error('No quote received from Jupiter');
            }

            this.stats.jupiterQuotes++;
            
            const quote = response.data;
            logger.debug(`✅ Jupiter quote: ${quote.outAmount} (${quote.routePlan?.length || 0} routes)`);
            
            return quote;

        } catch (error) {
            logger.error(`❌ Jupiter quote failed: ${error.message}`);
            throw error;
        }
    }

    // 🪐 Execute Jupiter swap
    async executeJupiterSwap(quote, priorityFee = 10000) {
        try {
            if (!this.wallet) {
                throw new Error('Wallet not initialized for live trading');
            }

            logger.info(`🪐 Executing Jupiter swap...`);

            // Get swap transaction from Jupiter
            const swapResponse = await axios.post(`${this.JUPITER_API_URL}/swap`, {
                quoteResponse: quote,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: priorityFee
            }, {
                timeout: 15000
            });

            if (!swapResponse.data || !swapResponse.data.swapTransaction) {
                throw new Error('No swap transaction received from Jupiter');
            }

            // Deserialize the transaction
            const swapTransactionBuf = Buffer.from(swapResponse.data.swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

            // Sign the transaction
            transaction.sign([this.wallet]);

            // Send and confirm transaction
            logger.info(`📝 Sending Jupiter swap transaction...`);
            const signature = await this.connection.sendTransaction(transaction, {
                skipPreflight: false,
                maxRetries: 3
            });

            // Confirm transaction
            const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
            
            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            logger.info(`✅ Jupiter swap executed! Signature: ${signature}`);
            this.stats.jupiterSwaps++;

            return signature;

        } catch (error) {
            logger.error(`❌ Jupiter swap execution failed: ${error.message}`);
            throw error;
        }
    }

    // 🔥 FIXED: Calculate price-based stop loss
    calculateStopLossPrice(entryPrice) {
        // Stop loss = entry price * (1 - stop loss percentage / 100)
        const stopLossPrice = entryPrice * (1 - this.config.stopLossPercentage / 100);
        
        logger.debug(`📉 Stop loss: ${entryPrice.toFixed(12)} SOL * (1 - ${this.config.stopLossPercentage}%) = ${stopLossPrice.toFixed(12)} SOL`);
        
        return stopLossPrice;
    }

    // 🔥 FIXED: Calculate price-based take profit levels
    calculateTakeProfitPrices(entryPrice) {
        const takeProfitLevels = this.config.takeProfitLevels.map((level, index) => {
            // Take profit price = entry price * (1 + percentage / 100)
            const targetPrice = entryPrice * (1 + level.percentage / 100);
            
            logger.debug(`📈 TP${index + 1}: ${entryPrice.toFixed(12)} SOL * (1 + ${level.percentage}%) = ${targetPrice.toFixed(12)} SOL (sell ${level.sellPercentage}%)`);
            
            return {
                targetPrice: targetPrice,
                sellPercentage: level.sellPercentage,
                percentage: level.percentage,
                triggered: false,
                level: index + 1
            };
        });

        return takeProfitLevels;
    }

    // 🪐 Execute live buy using Jupiter
    async executeLiveBuy(alert, investmentAmount, currentPrice, expectedTokens) {
        try {
            logger.info(`🚀 EXECUTING LIVE BUY WITH JUPITER: ${investmentAmount} SOL → ${alert.token.symbol}`);
            
            if (!this.wallet) {
                throw new Error('Wallet not initialized for live trading');
            }

            const tokenMint = alert.token.address;
            const amountLamports = Math.floor(investmentAmount * 1e9); // Convert SOL to lamports

            // Get Jupiter quote
            const quote = await this.getJupiterQuote(
                this.SOL_MINT,
                tokenMint,
                amountLamports
            );

            const expectedTokensFromJupiter = parseFloat(quote.outAmount) / Math.pow(10, 6); // Assuming 6 decimals
            const actualPrice = investmentAmount / expectedTokensFromJupiter;

            logger.info(`💎 Jupiter quote: ${expectedTokensFromJupiter.toFixed(2)} tokens @ ${actualPrice.toFixed(12)} SOL`);

            // Execute the swap
            const signature = await this.executeJupiterSwap(quote);

            // 🔥 FIXED: Calculate price-based stop loss and take profits
            const stopLossPrice = this.calculateStopLossPrice(actualPrice);
            const takeProfitPrices = this.calculateTakeProfitPrices(actualPrice);

            // Create position with FIXED price-based triggers
            const position = {
                id: this.generatePositionId(),
                tokenAddress: alert.token.address,
                symbol: alert.token.symbol,
                side: 'LONG',
                entryPrice: actualPrice,
                quantity: expectedTokensFromJupiter.toString(),
                investedAmount: investmentAmount,
                entryTime: Date.now(),
                txHash: signature,
                stopLossPrice: stopLossPrice, // 🔥 FIXED: Price-based stop loss
                takeProfitLevels: takeProfitPrices, // 🔥 FIXED: Price-based take profits
                remainingQuantity: expectedTokensFromJupiter.toString(),
                alert: alert,
                paperTrade: false, // 🔥 REAL TRADE
                realPrice: true,
                executedVia: 'Jupiter',
                jupiterQuote: quote
            };

            // Add to position manager
            if (this.positionManager) {
                await this.positionManager.addPosition(position);
            }

            this.stats.tradesExecuted++;
            this.stats.buyOrders++;
            this.stats.liveTradesExecuted++;

            logger.info(`🎉 Jupiter buy completed: ${expectedTokensFromJupiter.toFixed(2)} ${alert.token.symbol} @ ${actualPrice.toFixed(12)} SOL`);
            logger.info(`📉 Stop loss set at: ${stopLossPrice.toFixed(12)} SOL (-${this.config.stopLossPercentage}%)`);
            logger.info(`📈 Take profits: ${takeProfitPrices.map(tp => `${tp.targetPrice.toFixed(12)} SOL (+${tp.percentage}%)`).join(', ')}`);
            
            this.emit('tradeExecuted', {
                type: 'JUPITER_BUY',
                symbol: alert.token.symbol,
                amount: expectedTokensFromJupiter.toString(),
                price: actualPrice,
                investmentAmount: investmentAmount,
                signature: signature,
                realTrade: true,
                executedVia: 'Jupiter',
                stopLossPrice: stopLossPrice,
                takeProfitPrices: takeProfitPrices
            });

            return position;

        } catch (error) {
            logger.error(`❌ Jupiter buy failed for ${alert.token.symbol}:`, error);
            this.stats.errors++;
            throw error;
        }
    }

    // Paper trade execution (simulate only) - FIXED
    async executePaperBuy(alert, investmentAmount, currentPrice, expectedTokens) {
        // 🔥 FIXED: Calculate price-based stop loss and take profits
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
            stopLossPrice: stopLossPrice, // 🔥 FIXED: Price-based stop loss
            takeProfitLevels: takeProfitPrices, // 🔥 FIXED: Price-based take profits
            remainingQuantity: expectedTokens.toString(),
            alert: alert,
            paperTrade: true,
            realPrice: true,
            executedVia: 'Paper (Jupiter simulation)'
        };

        if (this.positionManager) {
            await this.positionManager.addPosition(position);
        }

        this.stats.tradesExecuted++;
        this.stats.buyOrders++;
        this.stats.paperTradesExecuted++;

        logger.info(`📝 Paper buy: ${expectedTokens.toFixed(2)} ${alert.token.symbol} @ ${currentPrice.toFixed(12)} SOL (Jupiter price)`);
        logger.info(`📉 Stop loss set at: ${stopLossPrice.toFixed(12)} SOL (-${this.config.stopLossPercentage}%)`);
        logger.info(`📈 Take profits: ${takeProfitPrices.map(tp => `${tp.targetPrice.toFixed(12)} SOL (+${tp.percentage}%)`).join(', ')}`);
        
        this.emit('tradeExecuted', {
            type: 'PAPER_BUY',
            symbol: alert.token.symbol,
            amount: expectedTokens.toString(),
            price: currentPrice,
            investmentAmount: investmentAmount,
            signature: position.txHash,
            realPrice: true,
            realTrade: false,
            executedVia: 'Paper (Jupiter simulation)',
            stopLossPrice: stopLossPrice,
            takeProfitPrices: takeProfitPrices
        });

        return position;
    }

    // Enhanced buy execution with Jupiter integration
    async executeBuy(alert) {
        try {
            const tokenAddress = alert.token.address;
            const symbol = alert.token.symbol;
            const investmentAmount = this.calculateInvestmentAmount(alert);
            
            logger.info(`💰 Executing BUY: ${investmentAmount} SOL → ${symbol} (${this.config.tradingMode.toUpperCase()} MODE)`);

            // Get REAL current price using Jupiter Price API
            let currentPrice;
            try {
                currentPrice = await this.getTokenPrice(tokenAddress, true);
                logger.info(`📊 Jupiter price: ${currentPrice.toFixed(12)} SOL per token`);
            } catch (priceError) {
                logger.warn(`⚠️ Could not get Jupiter price: ${priceError.message}`);
                // For Jupiter, we'll get the actual execution price from the quote
                currentPrice = 0.000001; // Fallback
            }

            const expectedTokens = investmentAmount / currentPrice;
            
            logger.info(`💎 Expected trade: ~${expectedTokens.toFixed(2)} ${symbol} (Jupiter will determine exact amount)`);

            // 🔥 MODE SWITCHING: Execute based on trading mode
            if (this.config.tradingMode === 'live') {
                return await this.executeLiveBuy(alert, investmentAmount, currentPrice, expectedTokens);
            } else {
                return await this.executePaperBuy(alert, investmentAmount, currentPrice, expectedTokens);
            }

        } catch (error) {
            logger.error(`❌ Buy execution failed for ${alert.token.symbol}:`, error);
            this.stats.errors++;
            throw error;
        }
    }

    // 🪐 Execute live sell using Jupiter
    async executeLiveSell(position, sellQuantity, reason = 'Manual') {
        try {
            logger.info(`🚀 EXECUTING LIVE SELL WITH JUPITER: ${sellQuantity} ${position.symbol} → SOL`);
            
            if (!this.wallet) {
                throw new Error('Wallet not initialized for live trading');
            }

            const tokenMint = position.tokenAddress;
            const amountTokens = Math.floor(sellQuantity * Math.pow(10, 6)); // Convert to token units (assuming 6 decimals)

            // Get Jupiter quote for sell
            const quote = await this.getJupiterQuote(
                tokenMint,
                this.SOL_MINT,
                amountTokens
            );

            const expectedSOL = parseFloat(quote.outAmount) / 1e9; // Convert lamports to SOL
            const sellPrice = expectedSOL / sellQuantity;

            logger.info(`💰 Jupiter sell quote: ${sellQuantity} tokens → ${expectedSOL.toFixed(6)} SOL @ ${sellPrice.toFixed(12)} SOL per token`);

            // Execute the swap
            const signature = await this.executeJupiterSwap(quote);

            // Calculate PnL
            const soldValue = expectedSOL;
            const investedPortionValue = (sellQuantity / parseFloat(position.quantity)) * position.investedAmount;
            const pnl = soldValue - investedPortionValue;

            // Update position
            if (this.positionManager) {
                await this.positionManager.updatePositionAfterSell(
                    position.id,
                    sellQuantity,
                    soldValue,
                    pnl,
                    signature,
                    reason
                );
            }

            this.stats.sellOrders++;
            this.stats.liveTradesExecuted++;
            this.stats.totalPnL += pnl;

            logger.info(`🎉 Jupiter sell completed: ${sellQuantity} ${position.symbol} → ${soldValue.toFixed(6)} SOL (PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(6)} SOL)`);
            
            this.emit('tradeExecuted', {
                type: 'JUPITER_SELL',
                symbol: position.symbol,
                amount: sellQuantity.toString(),
                soldValue: soldValue,
                pnl: pnl,
                signature: signature,
                reason: reason,
                realTrade: true,
                executedVia: 'Jupiter'
            });

            return {
                signature,
                soldValue,
                pnl,
                sellQuantity
            };

        } catch (error) {
            logger.error(`❌ Jupiter sell failed for ${position.symbol}:`, error);
            this.stats.errors++;
            throw error;
        }
    }

    // 🪐 Helper method to sell a position using Jupiter
    async sellPosition(positionId, sellPercentage, reason = 'Triggered') {
        try {
            const position = this.positionManager.positions.get(positionId);
            if (!position) {
                throw new Error(`Position ${positionId} not found`);
            }

            const remainingQuantity = parseFloat(position.remainingQuantity);
            const sellQuantity = remainingQuantity * (sellPercentage / 100);

            if (this.config.tradingMode === 'live') {
                return await this.executeLiveSell(position, sellQuantity, reason);
            } else {
                // Paper sell logic with Jupiter price
                let currentPrice;
                try {
                    currentPrice = await this.getTokenPrice(position.tokenAddress, true);
                } catch (error) {
                    currentPrice = position.currentPrice || position.entryPrice;
                }
                
                const soldValue = sellQuantity * currentPrice;
                const investedPortionValue = (sellQuantity / parseFloat(position.quantity)) * position.investedAmount;
                const pnl = soldValue - investedPortionValue;

                logger.info(`📝 Paper sell: ${sellQuantity} ${position.symbol} @ ${currentPrice.toFixed(12)} SOL (${reason}) - Jupiter price`);
                
                // Update position through position manager
                if (this.positionManager) {
                    await this.positionManager.updatePositionAfterSell(
                        position.id,
                        sellQuantity,
                        soldValue,
                        pnl,
                        'PAPER_SELL_' + Date.now(),
                        reason
                    );
                }

                this.stats.sellOrders++;
                this.stats.paperTradesExecuted++;
                this.stats.totalPnL += pnl;

                return {
                    signature: 'PAPER_SELL_' + Date.now(),
                    soldValue: soldValue,
                    pnl: pnl,
                    sellQuantity
                };
            }

        } catch (error) {
            logger.error(`❌ Sell position failed:`, error);
            throw error;
        }
    }

    calculateInvestmentAmount(alert) {
        let amount = this.config.initialInvestment;
        if (alert.twitter?.likes >= 1000) amount *= 1.2;
        if (alert.twitter?.views >= 1000000) amount *= 1.2;
        if (alert.twitter?.likes >= 5000) amount *= 1.3;
        if (alert.twitter?.views >= 5000000) amount *= 1.3;
        return Math.min(amount, this.config.initialInvestment * 2);
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
        const successRate = this.stats.priceUpdates > 0 ? 
            ((this.stats.jupiterPrices / this.stats.priceUpdates) * 100).toFixed(1) : '0';

        return {
            ...this.stats,
            config: {
                mode: this.config.tradingMode,
                initialInvestment: this.config.initialInvestment,
                priceSource: 'Jupiter Price API',
                swapExecution: 'Jupiter Aggregator',
                slippageTolerance: this.config.slippageTolerance + '%',
                priceCacheTimeout: this.priceCacheTimeout + 'ms',
                stopLossPercentage: this.config.stopLossPercentage + '%',
                takeProfitLevels: this.config.takeProfitLevels.map(tp => `+${tp.percentage}% (sell ${tp.sellPercentage}%)`).join(', ')
            },
            pricing: {
                jupiterPricesObtained: this.stats.jupiterPrices,
                totalPriceApiCalls: this.stats.priceApiCalls,
                failures: this.stats.priceFailures,
                successRate: successRate + '%',
                method: 'Jupiter Price API (real-time aggregated)',
                cacheTimeout: '3 seconds'
            },
            jupiter: {
                priceApiCalls: this.stats.priceApiCalls,
                quotes: this.stats.jupiterQuotes,
                swaps: this.stats.jupiterSwaps,
                priceApiUrl: this.JUPITER_PRICE_API,
                swapApiUrl: this.JUPITER_API_URL
            },
            trading: {
                liveTradesExecuted: this.stats.liveTradesExecuted,
                paperTradesExecuted: this.stats.paperTradesExecuted,
                totalPnL: this.stats.totalPnL.toFixed(4) + ' SOL',
                buyOrders: this.stats.buyOrders,
                sellOrders: this.stats.sellOrders
            }
        };
    }

    async stop() {
        this.pauseTrading();
        this.priceCache.clear();
        logger.info('🛑 Trading bot stopped');
    }
}

module.exports = TradingBot;