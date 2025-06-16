// src/bot/tradingBot.js - UPDATED: Integration with new PumpSwap service
const { Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage } = require('@solana/web3.js');
const { AccountLayout } = require('@solana/spl-token');
const { NATIVE_MINT } = require('@solana/spl-token');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');
const BN = require('bn.js');
const fs = require('fs');
const path = require('path');

// 🚀 NEW: Import PumpSwap service
const PumpSwapService = require('../services/pumpSwapService');

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
        
        // 🚀 POOL DERIVATION SETUP (for fallback)
        this.PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        this.PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
        this.CANONICAL_POOL_INDEX = 0;
        
        // Initialize wallet for live trading
        this.wallet = null;
        if (this.config.tradingMode === 'live' && this.config.privateKey) {
            this.wallet = this.initializeWallet();
        }
        
        // Price caching
        this.priceCache = new Map();
        this.priceCacheTimeout = 3000; // 3 seconds
        
        // 🚀 NEW: Initialize PumpSwap service
        this.pumpSwapService = null;
        this.initializePumpSwapService();
        
        // Enhanced statistics
        this.stats = {
            alertsProcessed: 0,
            tradesExecuted: 0,
            buyOrders: 0,
            sellOrders: 0,
            totalPnL: 0,
            // Pool derivation stats
            poolsDerivied: 0,
            derivationSuccesses: 0,
            derivationFailures: 0,
            // Price source stats
            manualPrices: 0,
            pumpSwapPrices: 0,
            priceFailures: 0,
            // Trading method stats
            pumpSwapTrades: 0,
            pumpSwapSells: 0,
            paperTrades: 0,
            liveTrades: 0,
            // Migration specific
            migrationTrades: 0,
            instantPoolTrades: 0,
            // Stop loss & take profit
            stopLossExecutions: 0,
            takeProfitExecutions: 0,
            errors: 0
        };

        this.isTradingEnabled = true;
        this.isInitialized = false;
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

    // 🚀 NEW: Initialize PumpSwap service with IDL
    async initializePumpSwapService() {
        try {
            if (!this.wallet) {
                logger.warn('⚠️ PumpSwap service not initialized - no wallet available');
                return false;
            }

            // Load PumpSwap IDL
            const idlPath = path.join(__dirname, '../../pumpswap-idl.json');
            if (!fs.existsSync(idlPath)) {
                logger.warn('⚠️ PumpSwap IDL not found at:', idlPath);
                return false;
            }

            const pumpSwapIDL = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
            
            // Initialize service
            this.pumpSwapService = new PumpSwapService(this.connection, this.wallet, pumpSwapIDL);
            
            logger.info('✅ PumpSwap service initialized');
            return true;
        } catch (error) {
            logger.warn('⚠️ PumpSwap service not available:', error.message);
            this.pumpSwapService = null;
            return false;
        }
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing ENHANCED trading bot...');
            logger.info(`💰 Trading mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`⚡ Trading System: Pool Derivation + Direct PumpSwap Integration`);
            
            const blockHeight = await this.connection.getBlockHeight();
            logger.info(`📡 Connected to Solana (block: ${blockHeight})`);

            if (this.wallet) {
                const balance = await this.connection.getBalance(this.wallet.publicKey);
                logger.info(`💰 Wallet balance: ${(balance / 1e9).toFixed(4)} SOL`);
            }

            // Initialize PumpSwap service
            await this.initializePumpSwapService();

            this.isInitialized = true;
            logger.info('✅ ENHANCED trading bot initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize:', error);
            throw error;
        }
    }

    // 🚀 IMPROVED: Enhanced price fetching with PumpSwap service
    async getTokenPrice(tokenAddress, forceRefresh = false, migrationPool = null) {
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
            let priceInfo = null;
            let source = 'unknown';

            // 🚀 PRIORITY 1: Use PumpSwap service (most reliable)
            if (this.pumpSwapService) {
                try {
                    priceInfo = await this.pumpSwapService.getTokenPrice(new PublicKey(tokenAddress));
                    if (priceInfo) {
                        source = 'pumpswap_service';
                        this.stats.pumpSwapPrices++;
                        logger.debug(`✅ PumpSwap service price: ${priceInfo.price.toFixed(12)} SOL`);
                    }
                } catch (error) {
                    logger.debug(`PumpSwap service price failed: ${error.message}`);
                }
            }

            // 🚀 PRIORITY 2: Use provided migration pool (instant)
            if (!priceInfo && migrationPool) {
                logger.debug(`⚡ Using migration pool: ${migrationPool}`);
                const price = await this.calculatePriceFromPool(tokenAddress, migrationPool);
                if (price) {
                    priceInfo = { 
                        price: price, 
                        poolAddress: migrationPool,
                        source: 'migration_pool'
                    };
                    source = 'migration_pool';
                    this.stats.instantPoolTrades++;
                }
            }

            // 🚀 PRIORITY 3: Derive pool instantly (fallback)
            if (!priceInfo) {
                const derivedPool = this.derivePoolAddress(tokenAddress);
                if (derivedPool) {
                    const price = await this.calculatePriceFromPool(tokenAddress, derivedPool);
                    if (price) {
                        priceInfo = {
                            price: price,
                            poolAddress: derivedPool,
                            source: 'derived_pool'
                        };
                        source = 'derived_pool';
                        this.stats.manualPrices++;
                    }
                }
            }

            if (!priceInfo) {
                this.stats.priceFailures++;
                throw new Error('All price fetch methods failed');
            }

            // Cache the result
            this.priceCache.set(tokenAddress, {
                price: priceInfo.price,
                timestamp: now,
                source: source,
                poolAddress: priceInfo.poolAddress
            });

            const sourceEmoji = source === 'pumpswap_service' ? '🚀' : 
                              source === 'migration_pool' ? '⚡' : '🔍';
            logger.debug(`${sourceEmoji} Final price: ${priceInfo.price.toFixed(12)} SOL via ${source}`);
            
            return priceInfo;

        } catch (error) {
            this.stats.priceFailures++;
            this.stats.errors++;
            logger.error(`❌ Price fetch failed for ${tokenAddress}: ${error.message}`);
            throw error;
        }
    }

    // 🚀 NEW: Execute REAL PumpSwap buy using service
    async executePumpSwapBuy(alert, investmentAmount, poolAddress) {
        try {
            if (!this.pumpSwapService || !this.wallet) {
                throw new Error('PumpSwap service or wallet not available for live trading');
            }

            logger.info(`🚀 Executing REAL PumpSwap buy: ${investmentAmount} SOL`);

            const tokenMint = new PublicKey(alert.token.address);
            
            // Calculate expected tokens
            const solInLamports = Math.floor(investmentAmount * 1e9);
            const expectedTokens = Math.floor(investmentAmount / (await this.getTokenPrice(alert.token.address)).price);

            // Build buy instructions
            const buyData = await this.pumpSwapService.buildBuyInstructions(
                tokenMint,
                expectedTokens,
                solInLamports,
                this.config.slippageTolerance
            );

            logger.info(`💎 Expected: ${(expectedTokens / 1e6).toFixed(6)} ${alert.token.symbol} for ${investmentAmount} SOL`);

            // Create and send transaction
            const { blockhash } = await this.connection.getLatestBlockhash();
            const message = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: buyData.instructions,
            }).compileToV0Message();

            const transaction = new VersionedTransaction(message);
            transaction.sign([this.wallet]);

            // Send transaction
            const signature = await this.connection.sendTransaction(transaction, {
                maxRetries: 3,
                preflightCommitment: 'confirmed'
            });

            // Wait for confirmation
            await this.connection.confirmTransaction(signature, 'confirmed');

            this.stats.pumpSwapTrades++;
            this.stats.liveTrades++;

            logger.info(`✅ PumpSwap BUY SUCCESS! Signature: ${signature}`);

            return {
                success: true,
                signature: signature,
                expectedTokens: expectedTokens / 1e6, // Convert to human readable
                actualPrice: investmentAmount / (expectedTokens / 1e6),
                poolAddress: buyData.poolAddress,
                method: 'pumpswap_service'
            };

        } catch (error) {
            logger.error(`❌ PumpSwap buy failed: ${error.message}`);
            throw error;
        }
    }

    // 🚀 NEW: Execute REAL PumpSwap sell using service
    async executePumpSwapSell(position, sellPercentage, reason = 'Manual Sell') {
        try {
            if (!this.pumpSwapService || !this.wallet) {
                throw new Error('PumpSwap service or wallet not available for live trading');
            }

            const tokenAmount = parseFloat(position.remainingQuantity) * (sellPercentage / 100);
            const poolAddress = position.poolAddress;

            if (!poolAddress) {
                throw new Error('Pool address not found in position data');
            }

            logger.info(`🚀 Executing REAL PumpSwap sell: ${tokenAmount.toFixed(6)} ${position.symbol} (${sellPercentage}%)`);
            logger.info(`📍 Reason: ${reason}`);

            const tokenMint = new PublicKey(position.tokenAddress);
            const tokenAmountInBaseUnits = Math.floor(tokenAmount * 1e6); // Convert to base units

            // Build sell instructions
            const sellData = await this.pumpSwapService.buildSellInstructions(
                tokenMint,
                tokenAmountInBaseUnits,
                null, // Let service calculate min SOL out
                this.config.slippageTolerance
            );

            const expectedSol = parseFloat(sellData.expectedSolReceived.toString()) / 1e9;
            const minSolReceived = parseFloat(sellData.minSolOut.toString()) / 1e9;

            logger.info(`💰 Expected: ${expectedSol.toFixed(6)} SOL for ${tokenAmount.toFixed(6)} ${position.symbol}`);
            logger.info(`🛡️ Min SOL (with ${this.config.slippageTolerance}% slippage): ${minSolReceived.toFixed(6)} SOL`);

            // Create and send transaction
            const { blockhash } = await this.connection.getLatestBlockhash();
            const message = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: sellData.instructions,
            }).compileToV0Message();

            const transaction = new VersionedTransaction(message);
            transaction.sign([this.wallet]);

            // Send transaction
            const signature = await this.connection.sendTransaction(transaction, {
                maxRetries: 3,
                preflightCommitment: 'confirmed'
            });

            // Wait for confirmation
            await this.connection.confirmTransaction(signature, 'confirmed');

            this.stats.pumpSwapSells++;
            this.stats.sellOrders++;

            // Calculate PnL
            const originalInvestment = (tokenAmount / parseFloat(position.quantity)) * position.investedAmount;
            const pnl = expectedSol - originalInvestment;
            const pnlPercentage = (pnl / originalInvestment) * 100;

            logger.info(`✅ PumpSwap SELL SUCCESS!`);
            logger.info(`   📝 Signature: ${signature}`);
            logger.info(`   💰 Received: ${expectedSol.toFixed(6)} SOL`);
            logger.info(`   📊 PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPercentage > 0 ? '+' : ''}${pnlPercentage.toFixed(2)}%)`);

            // Update stats
            this.stats.totalPnL += pnl;
            if (reason.includes('Stop Loss')) {
                this.stats.stopLossExecutions++;
            } else if (reason.includes('Take Profit')) {
                this.stats.takeProfitExecutions++;
            }

            // Update position in position manager
            if (this.positionManager) {
                await this.positionManager.updatePositionAfterSell(
                    position.id,
                    tokenAmount,
                    expectedSol,
                    pnl,
                    signature,
                    reason
                );
            }

            this.emit('tradeExecuted', {
                type: 'LIVE_SELL',
                symbol: position.symbol,
                amount: tokenAmount.toString(),
                price: expectedSol / tokenAmount,
                signature: signature,
                pnl: pnl,
                pnlPercentage: pnlPercentage,
                reason: reason,
                method: 'pumpswap_service'
            });

            return {
                success: true,
                signature: signature,
                tokensSold: tokenAmount,
                solReceived: expectedSol,
                pnl: pnl,
                pnlPercentage: pnlPercentage,
                method: 'pumpswap_service'
            };

        } catch (error) {
            logger.error(`❌ PumpSwap sell failed: ${error.message}`);
            throw error;
        }
    }

    // Keep all your existing methods (derivePoolAddress, calculatePriceFromPool, etc.)
    // ... (rest of your existing code remains the same)

    // 🚀 UPDATED: getStats method
    getStats() {
        const derivationSuccessRate = this.stats.poolsDerivied > 0 ? 
            ((this.stats.derivationSuccesses / this.stats.poolsDerivied) * 100).toFixed(1) : '0';

        return {
            ...this.stats,
            config: {
                mode: this.config.tradingMode,
                tradingMethod: 'Enhanced PumpSwap Service Integration'
            },
            poolDerivation: {
                derived: this.stats.poolsDerivied,
                successes: this.stats.derivationSuccesses,
                failures: this.stats.derivationFailures,
                successRate: derivationSuccessRate + '%'
            },
            trading: {
                paperTrades: this.stats.paperTrades,
                liveTrades: this.stats.liveTrades,
                pumpSwapTrades: this.stats.pumpSwapTrades,
                pumpSwapSells: this.stats.pumpSwapSells,
                pumpSwapPrices: this.stats.pumpSwapPrices
            },
            riskManagement: {
                stopLossExecutions: this.stats.stopLossExecutions,
                takeProfitExecutions: this.stats.takeProfitExecutions,
                totalPnL: this.stats.totalPnL.toFixed(6) + ' SOL'
            },
            migration: {
                totalMigrations: this.stats.migrationTrades,
                instantPoolTrades: this.stats.instantPoolTrades
            }
        };
    }
}

module.exports = TradingBot;