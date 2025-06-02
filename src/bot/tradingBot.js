// src/bot/tradingBot.js - ENHANCED: Added live PumpSwap sell execution
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { AccountLayout } = require('@solana/spl-token');
const { NATIVE_MINT } = require('@solana/spl-token');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');
const BN = require('bn.js');

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
        
        // 🚀 POOL DERIVATION SETUP
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
        
        // 🚀 Initialize PumpSwap SDK for direct trading
        this.pumpAmmSdk = null;
        this.pumpInternalSdk = null;
        this.initializePumpSDK();
        
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
            jupiterPrices: 0,
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

    async initializePumpSDK() {
        try {
            const { PumpAmmSdk, PumpAmmInternalSdk } = require('@pump-fun/pump-swap-sdk');
            
            // Initialize both SDKs
            this.pumpAmmSdk = new PumpAmmSdk(this.connection);
            this.pumpInternalSdk = new PumpAmmInternalSdk(this.connection);
            
            logger.info('✅ PumpSwap SDK initialized (High-level + Internal)');
            return true;
        } catch (error) {
            logger.warn('⚠️ PumpSwap SDK not available:', error.message);
            this.pumpAmmSdk = null;
            this.pumpInternalSdk = null;
            return false;
        }
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing ULTIMATE trading bot...');
            logger.info(`💰 Trading mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`⚡ Trading System: Pool Derivation + PumpSwap Direct Trading`);
            
            const blockHeight = await this.connection.getBlockHeight();
            logger.info(`📡 Connected to Solana (block: ${blockHeight})`);

            if (this.wallet) {
                const balance = await this.connection.getBalance(this.wallet.publicKey);
                logger.info(`💰 Wallet balance: ${(balance / 1e9).toFixed(4)} SOL`);
            }

            this.isInitialized = true;
            logger.info('✅ ULTIMATE trading bot initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize:', error);
            throw error;
        }
    }

    // 🚀 INSTANT pool derivation (0-5ms)
    derivePoolAddress(tokenMint) {
        try {
            const mintPubkey = new PublicKey(tokenMint);
            
            // Step 1: Derive pool authority
            const [poolAuthority] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("pool-authority"),
                    mintPubkey.toBuffer()
                ],
                this.PUMP_PROGRAM_ID
            );
            
            // Step 2: Derive pool address
            const poolIndexBuffer = Buffer.alloc(2);
            poolIndexBuffer.writeUInt16LE(this.CANONICAL_POOL_INDEX, 0);
            
            const [poolAddress] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("pool"),
                    poolIndexBuffer,
                    poolAuthority.toBuffer(),
                    mintPubkey.toBuffer(),
                    NATIVE_MINT.toBuffer()
                ],
                this.PUMP_AMM_PROGRAM_ID
            );
            
            this.stats.poolsDerivied++;
            this.stats.derivationSuccesses++;
            
            const poolAddressString = poolAddress.toString();
            logger.debug(`⚡ Pool derived: ${poolAddressString}`);
            return poolAddressString;
            
        } catch (error) {
            this.stats.derivationFailures++;
            logger.debug(`❌ Pool derivation failed: ${error.message}`);
            return null;
        }
    }

    // 🔧 Calculate price using manual RPC method (FAST!)
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
            
            // Convert to readable amounts
            const baseAmount = parseFloat(baseTokenData.amount.toString()) / Math.pow(10, 6); // Token: 6 decimals
            const quoteAmount = parseFloat(quoteTokenData.amount.toString()) / Math.pow(10, 9); // SOL: 9 decimals
            
            if (baseAmount <= 0 || quoteAmount <= 0) {
                throw new Error(`Invalid pool reserves: ${baseAmount} tokens, ${quoteAmount} SOL`);
            }

            // Calculate price
            const price = quoteAmount / baseAmount;
            
            this.stats.manualPrices++;
            logger.debug(`✅ Manual price: ${price.toFixed(12)} SOL (${baseAmount.toFixed(2)} tokens, ${quoteAmount.toFixed(6)} SOL)`);
            
            return price;

        } catch (error) {
            logger.debug(`❌ Manual price calculation failed: ${error.message}`);
            return null;
        }
    }

    // 🧠 MAIN: Optimized price fetching with instant pool derivation
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
            let price = null;
            let source = 'unknown';
            let poolAddress = null;

            // 🚀 PRIORITY 1: Use provided migration pool (INSTANT!)
            if (migrationPool) {
                logger.debug(`⚡ Using migration pool: ${migrationPool}`);
                price = await this.calculatePriceFromPool(tokenAddress, migrationPool);
                poolAddress = migrationPool;
                if (price) {
                    source = 'migration_pool';
                    this.stats.instantPoolTrades++;
                }
            }

            // 🚀 PRIORITY 2: Derive pool instantly (0-5ms)
            if (!price) {
                const derivedPool = this.derivePoolAddress(tokenAddress);
                if (derivedPool) {
                    price = await this.calculatePriceFromPool(tokenAddress, derivedPool);
                    poolAddress = derivedPool;
                    if (price) {
                        source = 'derived_pool';
                    }
                }
            }

            if (!price) {
                this.stats.priceFailures++;
                throw new Error('Pool derivation and manual calculation failed');
            }

            // Cache the result with pool address
            this.priceCache.set(tokenAddress, {
                price: price,
                timestamp: now,
                source: source,
                poolAddress: poolAddress
            });

            const sourceEmoji = source === 'migration_pool' ? '⚡' : '🔍';
            logger.debug(`${sourceEmoji} Final price: ${price.toFixed(12)} SOL via ${source}`);
            
            return { price, poolAddress, source };

        } catch (error) {
            this.stats.priceFailures++;
            this.stats.errors++;
            logger.error(`❌ Price fetch failed for ${tokenAddress}: ${error.message}`);
            throw error;
        }
    }

    // 🚀 NEW: Execute REAL PumpSwap buy
    async executePumpSwapBuy(alert, investmentAmount, poolAddress) {
        try {
            if (!this.pumpInternalSdk || !this.wallet) {
                throw new Error('PumpSwap SDK or wallet not available for live trading');
            }

            logger.info(`🚀 Executing REAL PumpSwap buy: ${investmentAmount} SOL`);

            const pool = new PublicKey(poolAddress);
            const quoteAmount = new BN(investmentAmount * 1e9); // Convert SOL to lamports
            const slippage = this.config.slippageTolerance;

            // Get expected tokens
            const buyResult = await this.pumpInternalSdk.buyQuoteInputInternal(pool, quoteAmount, slippage);
            const expectedTokens = parseFloat(buyResult.base.toString()) / Math.pow(10, 6);

            logger.info(`💎 Expected: ${expectedTokens.toFixed(6)} ${alert.token.symbol} for ${investmentAmount} SOL`);

            // Get transaction instructions
            const instructions = await this.pumpInternalSdk.buyQuoteInput(
                pool,
                quoteAmount,
                slippage,
                this.wallet.publicKey
            );

            // Execute transaction
            const { sendAndConfirmTransaction } = require('@pump-fun/pump-swap-sdk');
            const [transaction, error] = await sendAndConfirmTransaction(
                this.connection,
                this.wallet.publicKey,
                instructions,
                [this.wallet]
            );

            if (error) {
                throw new Error(`PumpSwap transaction failed: ${JSON.stringify(error)}`);
            }

            const signature = Buffer.from(transaction.signatures[0]).toString('base64');
            this.stats.pumpSwapTrades++;
            this.stats.liveTrades++;

            logger.info(`✅ PumpSwap BUY SUCCESS! Signature: ${signature}`);

            return {
                success: true,
                signature: signature,
                expectedTokens: expectedTokens,
                actualPrice: investmentAmount / expectedTokens,
                poolAddress: poolAddress,
                method: 'pumpswap'
            };

        } catch (error) {
            logger.error(`❌ PumpSwap buy failed: ${error.message}`);
            throw error;
        }
    }

    // 🚀 NEW: Execute REAL PumpSwap sell
    async executePumpSwapSell(position, sellPercentage, reason = 'Manual Sell') {
        try {
            if (!this.pumpInternalSdk || !this.wallet) {
                throw new Error('PumpSwap SDK or wallet not available for live trading');
            }

            const tokenAmount = parseFloat(position.remainingQuantity) * (sellPercentage / 100);
            const poolAddress = position.poolAddress;

            if (!poolAddress) {
                throw new Error('Pool address not found in position data');
            }

            logger.info(`🚀 Executing REAL PumpSwap sell: ${tokenAmount.toFixed(6)} ${position.symbol} (${sellPercentage}%)`);
            logger.info(`📍 Reason: ${reason}`);

            const pool = new PublicKey(poolAddress);
            const baseAmount = new BN(tokenAmount * Math.pow(10, 6)); // Convert to base units (6 decimals)
            const slippage = this.config.slippageTolerance;

            // Get expected SOL for these tokens
            const sellResult = await this.pumpInternalSdk.sellBaseInputInternal(pool, baseAmount, slippage);
            const expectedSol = parseFloat(sellResult.uiQuote.toString()) / 1e9;
            const minSolReceived = parseFloat(sellResult.minQuote.toString()) / 1e9;

            logger.info(`💰 Expected: ${expectedSol.toFixed(6)} SOL for ${tokenAmount.toFixed(6)} ${position.symbol}`);
            logger.info(`🛡️ Min SOL (with ${slippage}% slippage): ${minSolReceived.toFixed(6)} SOL`);

            // Get transaction instructions
            const instructions = await this.pumpInternalSdk.sellBaseInput(
                pool,
                baseAmount,
                slippage,
                this.wallet.publicKey
            );

            // Execute transaction
            const { sendAndConfirmTransaction } = require('@pump-fun/pump-swap-sdk');
            const [transaction, error] = await sendAndConfirmTransaction(
                this.connection,
                this.wallet.publicKey,
                instructions,
                [this.wallet]
            );

            if (error) {
                throw new Error(`PumpSwap sell transaction failed: ${JSON.stringify(error)}`);
            }

            const signature = Buffer.from(transaction.signatures[0]).toString('base64');
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
                method: 'pumpswap'
            });

            return {
                success: true,
                signature: signature,
                tokensSold: tokenAmount,
                solReceived: expectedSol,
                pnl: pnl,
                pnlPercentage: pnlPercentage,
                method: 'pumpswap'
            };

        } catch (error) {
            logger.error(`❌ PumpSwap sell failed: ${error.message}`);
            throw error;
        }
    }

    // 🚀 NEW: Sell position by ID (for position manager integration)
    async sellPosition(positionId, sellPercentage, reason = 'Manual Sell') {
        try {
            if (!this.positionManager) {
                throw new Error('Position manager not connected');
            }

            const position = this.positionManager.positions.get(positionId);
            if (!position) {
                throw new Error(`Position ${positionId} not found`);
            }

            logger.info(`🔄 Selling position: ${position.symbol} (${sellPercentage}%) - ${reason}`);

            if (this.config.tradingMode === 'live') {
                // Execute real PumpSwap sell
                return await this.executePumpSwapSell(position, sellPercentage, reason);
            } else {
                // Execute paper sell (handled by position manager)
                return await this.positionManager.simulatePartialSell(position, sellPercentage, reason);
            }

        } catch (error) {
            logger.error(`❌ Sell position failed: ${error.message}`);
            throw error;
        }
    }

    // 📝 Execute paper buy (for paper trading mode)
    async executePaperBuy(alert, investmentAmount, currentPrice, expectedTokens, metadata = {}) {
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
            // Enhanced metadata
            priceSource: metadata.priceSource || 'unknown',
            migrationPool: metadata.migrationPool || null,
            poolAddress: metadata.poolAddress || null,
            eventType: alert.eventType || 'creation',
            isMigration: alert.eventType === 'migration'
        };

        if (this.positionManager) {
            await this.positionManager.addPosition(position);
        }

        this.stats.tradesExecuted++;
        this.stats.buyOrders++;
        this.stats.paperTrades++;

        // Enhanced logging
        const sourceInfo = metadata.priceSource === 'migration_pool' ? '⚡ Migration Pool' : 
                          metadata.priceSource === 'derived_pool' ? '🔍 Derived Pool' : 'Unknown';
        
        const migrationInfo = position.isMigration ? 
            (metadata.migrationPool ? ` [INSTANT MIGRATION]` : ' [MIGRATION]') : '';
        
        logger.info(`📝 Paper buy: ${expectedTokens.toFixed(2)} ${alert.token.symbol} @ ${currentPrice.toFixed(12)} SOL (${sourceInfo})${migrationInfo}`);
        
        this.emit('tradeExecuted', {
            type: 'PAPER_BUY',
            symbol: alert.token.symbol,
            amount: expectedTokens.toString(),
            price: currentPrice,
            priceSource: sourceInfo,
            isMigration: position.isMigration,
            migrationPool: metadata.migrationPool
        });

        return position;
    }

    // 🚀 NEW: Execute live buy with real PumpSwap
    async executeLiveBuy(alert, investmentAmount, poolAddress, priceInfo) {
        try {
            const buyResult = await this.executePumpSwapBuy(alert, investmentAmount, poolAddress);
            
            if (!buyResult.success) {
                throw new Error('PumpSwap buy failed');
            }

            // Create position for live trade
            const stopLossPrice = this.calculateStopLossPrice(buyResult.actualPrice);
            const takeProfitPrices = this.calculateTakeProfitPrices(buyResult.actualPrice);

            const position = {
                id: this.generatePositionId(),
                tokenAddress: alert.token.address,
                symbol: alert.token.symbol,
                side: 'LONG',
                entryPrice: buyResult.actualPrice,
                quantity: buyResult.expectedTokens.toString(),
                investedAmount: investmentAmount,
                entryTime: Date.now(),
                txHash: buyResult.signature,
                stopLossPrice: stopLossPrice,
                takeProfitLevels: takeProfitPrices,
                remainingQuantity: buyResult.expectedTokens.toString(),
                alert: alert,
                paperTrade: false,
                // Live trade metadata
                priceSource: priceInfo.source,
                migrationPool: priceInfo.source === 'migration_pool' ? poolAddress : null,
                poolAddress: poolAddress,
                eventType: alert.eventType || 'creation',
                isMigration: alert.eventType === 'migration',
                tradingMethod: 'pumpswap'
            };

            if (this.positionManager) {
                await this.positionManager.addPosition(position);
            }

            const migrationInfo = position.isMigration ? ' [LIVE MIGRATION]' : '';
            logger.info(`🚀 Live buy: ${buyResult.expectedTokens.toFixed(6)} ${alert.token.symbol} @ ${buyResult.actualPrice.toFixed(12)} SOL${migrationInfo}`);

            this.emit('tradeExecuted', {
                type: 'LIVE_BUY',
                symbol: alert.token.symbol,
                amount: buyResult.expectedTokens.toString(),
                price: buyResult.actualPrice,
                signature: buyResult.signature,
                priceSource: priceInfo.source,
                isMigration: position.isMigration,
                method: 'pumpswap'
            });

            return position;

        } catch (error) {
            logger.error(`❌ Live buy execution failed: ${error.message}`);
            throw error;
        }
    }

    // Enhanced buy execution with PumpSwap integration
    async executeBuy(alert) {
        try {
            const tokenAddress = alert.token.address;
            const symbol = alert.token.symbol;
            const investmentAmount = this.config.initialInvestment;
            
            // Check if this is a migration with pool data
            const isMigration = alert.eventType === 'migration';
            const migrationPool = alert.migration?.pool;
            const hasMigrationPool = migrationPool && migrationPool !== 'unknown';
            
            logger.info(`💰 Executing BUY: ${investmentAmount} SOL → ${symbol} ${isMigration ? '(MIGRATION)' : '(CREATION)'}`);
            
            if (isMigration) {
                this.stats.migrationTrades++;
                if (hasMigrationPool) {
                    logger.info(`⚡ INSTANT MIGRATION: Using provided pool ${migrationPool}`);
                } else {
                    logger.info(`🔍 Migration without pool, deriving instantly...`);
                }
            }

            // Get current price and pool address
            const priceInfo = await this.getTokenPrice(
                tokenAddress, 
                true, // Force refresh for new trades
                hasMigrationPool ? migrationPool : null
            );
            
            const currentPrice = priceInfo.price;
            const poolAddress = priceInfo.poolAddress;
            const priceSource = priceInfo.source;
            const expectedTokens = investmentAmount / currentPrice;
            
            const sourceEmoji = priceSource === 'migration_pool' ? '⚡' : '🔍';
            logger.info(`💎 Trade: ${expectedTokens.toFixed(2)} ${symbol} @ ${currentPrice.toFixed(12)} SOL ${sourceEmoji}`);

            // Execute based on trading mode
            if (this.config.tradingMode === 'live') {
                // 🚀 LIVE TRADING with PumpSwap
                return await this.executeLiveBuy(alert, investmentAmount, poolAddress, priceInfo);
            } else {
                // 📝 PAPER TRADING
                return await this.executePaperBuy(
                    alert, 
                    investmentAmount, 
                    currentPrice, 
                    expectedTokens,
                    { 
                        priceSource: priceSource,
                        migrationPool: hasMigrationPool ? migrationPool : null,
                        poolAddress: poolAddress
                    }
                );
            }

        } catch (error) {
            logger.error(`❌ Buy execution failed: ${error.message}`);
            this.stats.errors++;
            throw error;
        }
    }

    // Calculate stop loss and take profit prices
    calculateStopLossPrice(entryPrice) {
        return entryPrice * (1 - this.config.stopLossPercentage / 100);
    }

    calculateTakeProfitPrices(entryPrice) {
        return this.config.takeProfitLevels.map((level, index) => ({
            targetPrice: entryPrice * (1 + level.percentage / 100),
            sellPercentage: level.sellPercentage,
            percentage: level.percentage,
            triggered: false,
            level: index + 1
        }));
    }

    // Helper method for position manager
    async getTokenPriceManual(tokenAddress, poolAddress = null) {
        try {
            if (poolAddress) {
                return await this.calculatePriceFromPool(tokenAddress, poolAddress);
            }
            const priceInfo = await this.getTokenPrice(tokenAddress, true);
            return priceInfo.price;
        } catch (error) {
            logger.debug(`Position manager price fetch failed: ${error.message}`);
            return null;
        }
    }

    generatePositionId() {
        return 'pos_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    async processAlert(alert) {
        if (!this.isTradingEnabled || !this.isInitialized) return;

        try {
            this.stats.alertsProcessed++;
            
            const isMigration = alert.eventType === 'migration';
            const migrationInfo = isMigration ? 
                (alert.migration?.pool ? ' [INSTANT MIGRATION]' : ' [MIGRATION]') : '';
            
            logger.info(`🔔 Processing alert: ${alert.token.symbol}${migrationInfo}`);

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
        const derivationSuccessRate = this.stats.poolsDerivied > 0 ? 
            ((this.stats.derivationSuccesses / this.stats.poolsDerivied) * 100).toFixed(1) : '0';

        return {
            ...this.stats,
            config: {
                mode: this.config.tradingMode,
                tradingMethod: 'Pool Derivation + PumpSwap Direct Trading'
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
                manualPrices: this.stats.manualPrices
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
        logger.info('🛑 ULTIMATE trading bot stopped');
    }
}

module.exports = TradingBot;