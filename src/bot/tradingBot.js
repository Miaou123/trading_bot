// src/bot/tradingBot.js - Simplified with correct PumpSwap SDK imports
const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { AccountLayout } = require('@solana/spl-token');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const Big = require('big.js');

// 🔥 CORRECT: Use documented imports
let PumpAmmSdk, Direction;
let sdkAvailable = false;

try {
    const pumpSdk = require('@pump-fun/pump-swap-sdk');
    PumpAmmSdk = pumpSdk.PumpAmmSdk;
    Direction = pumpSdk.Direction;
    
    if (PumpAmmSdk && Direction) {
        sdkAvailable = true;
        logger.info('✅ PumpSwap SDK imported successfully');
    } else {
        logger.warn('⚠️ PumpSwap SDK imports incomplete');
    }
} catch (error) {
    logger.warn('⚠️ PumpSwap SDK not available:', error.message);
    sdkAvailable = false;
}

class TradingBot extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            tradingMode: config.tradingMode || process.env.TRADING_MODE || 'paper',
            initialInvestment: parseFloat(config.initialInvestment || process.env.INITIAL_INVESTMENT_SOL) || 0.1,
            stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE) || 50,
            slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 5,
            rpcUrl: process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com',
            privateKey: process.env.PRIVATE_KEY,
            takeProfitLevels: [
                { percentage: 100, sellPercentage: 50 },
                { percentage: 300, sellPercentage: 25 },
                { percentage: 900, sellPercentage: 100 }
            ],
            ...config
        };

        this.positionManager = config.positionManager;
        this.connection = new Connection(this.config.rpcUrl, 'confirmed');
        
        // Initialize PumpSwap SDK
        this.pumpSdk = null;
        if (sdkAvailable) {
            try {
                this.pumpSdk = new PumpAmmSdk();
                logger.info('🚀 PumpSwap SDK initialized');
            } catch (error) {
                logger.warn('⚠️ PumpSwap SDK init failed:', error.message);
            }
        }
        
        this.wallet = null;
        if (this.config.tradingMode === 'live' && this.config.privateKey) {
            this.wallet = this.initializeWallet();
        }
        
        this.priceCache = new Map();
        this.poolCache = new Map();
        this.isTradingEnabled = true;
        this.isInitialized = false;
        
        this.stats = {
            alertsProcessed: 0,
            tradesExecuted: 0,
            buyOrders: 0,
            totalPnL: 0,
            priceUpdates: 0,
            manualPrices: 0,
            mockPrices: 0,
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
                const bs58 = require('bs58');
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
            logger.info('🔧 Initializing enhanced trading bot...');
            logger.info(`💰 Trading mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`🌐 RPC: ${this.config.rpcUrl}`);
            logger.info(`🚀 PumpSwap SDK: ${this.pumpSdk ? '✅ ACTIVE' : '❌ DISABLED (using manual calculation)'}`);
            
            const blockHeight = await this.connection.getBlockHeight();
            logger.info(`📡 Connected to Solana (block: ${blockHeight})`);

            if (this.wallet) {
                const balance = await this.connection.getBalance(this.wallet.publicKey);
                logger.info(`💰 Wallet balance: ${(balance / 1e9).toFixed(4)} SOL`);
            }

            this.isInitialized = true;
            logger.info('✅ Enhanced trading bot initialized successfully');
        } catch (error) {
            logger.error('❌ Failed to initialize:', error);
            throw error;
        }
    }

    // 🔥 SIMPLIFIED: Manual price calculation using your working method
    async getTokenPriceManual(tokenAddress, poolAddress = null) {
        try {
            if (this.config.tradingMode === 'paper') {
                return this.getMockPrice(tokenAddress);
            }

            if (!this.pumpSdk || !poolAddress) {
                return this.getMockPrice(tokenAddress);
            }

            // Use your working manual method
            const poolPubkey = new PublicKey(poolAddress);
            const pool = await this.pumpSdk.fetchPool(poolPubkey);
            
            if (!pool) {
                return this.getMockPrice(tokenAddress);
            }
            
            const [baseAccountInfo, quoteAccountInfo] = await Promise.all([
                this.connection.getAccountInfo(pool.poolBaseTokenAccount),
                this.connection.getAccountInfo(pool.poolQuoteTokenAccount)
            ]);
            
            if (!baseAccountInfo || !quoteAccountInfo) {
                return this.getMockPrice(tokenAddress);
            }
            
            const baseTokenData = AccountLayout.decode(baseAccountInfo.data);
            const quoteTokenData = AccountLayout.decode(quoteAccountInfo.data);
            
            const baseAmount = parseFloat(baseTokenData.amount.toString()) / Math.pow(10, 6);
            const quoteAmount = parseFloat(quoteTokenData.amount.toString()) / Math.pow(10, 9);
            
            if (baseAmount <= 0 || quoteAmount <= 0) {
                return this.getMockPrice(tokenAddress);
            }
            
            const price = quoteAmount / baseAmount;
            this.stats.manualPrices++;
            return price;

        } catch (error) {
            logger.debug(`Manual price calculation failed: ${error.message}`);
            return this.getMockPrice(tokenAddress);
        }
    }

    getMockPrice(tokenAddress) {
        const cached = this.priceCache.get(`mock_${tokenAddress}`);
        
        if (cached && Date.now() - cached.timestamp < 30000) {
            const volatility = (Math.random() - 0.5) * 0.04; // 2% movement
            const newPrice = cached.price * (1 + volatility);
            const boundedPrice = Math.max(0.000001, Math.min(0.0001, newPrice));
            
            this.priceCache.set(`mock_${tokenAddress}`, {
                price: boundedPrice,
                timestamp: Date.now()
            });
            return boundedPrice;
        } else {
            // Initial realistic price (based on your debug: ~0.000007 SOL)
            const basePrice = 0.000005 + Math.random() * 0.000005;
            this.priceCache.set(`mock_${tokenAddress}`, {
                price: basePrice,
                timestamp: Date.now()
            });
            this.stats.mockPrices++;
            return basePrice;
        }
    }

    async getTokenPrice(tokenAddress, forceRefresh = false, priority = 'normal', poolAddress = null) {
        try {
            const price = await this.getTokenPriceManual(tokenAddress, poolAddress);
            this.stats.priceUpdates++;
            return price;
        } catch (error) {
            logger.error(`Price error: ${error.message}`);
            this.stats.errors++;
            return this.getMockPrice(tokenAddress);
        }
    }

    async executeBuy(alert) {
        try {
            const tokenAddress = alert.token.address;
            const symbol = alert.token.symbol;
            const investmentAmount = this.calculateInvestmentAmount(alert);
            
            logger.info(`💰 Executing BUY: ${investmentAmount} SOL → ${symbol}`);

            const currentPrice = await this.getTokenPrice(tokenAddress, true);
            const expectedTokens = investmentAmount / currentPrice;
            
            const cached = this.priceCache.get(tokenAddress) || this.priceCache.get(`mock_${tokenAddress}`);
            const priceSource = this.stats.manualPrices > this.stats.mockPrices ? 'MANUAL' : 'MOCK';

            logger.info(`💎 Trade: ${expectedTokens.toFixed(2)} ${symbol} @ ${currentPrice.toFixed(12)} SOL (${priceSource})`);

            const position = await this.executePaperBuy(alert, investmentAmount, currentPrice, expectedTokens, priceSource);
            return position;

        } catch (error) {
            logger.error(`❌ Buy failed for ${alert.token.symbol}:`, error);
            this.stats.errors++;
            throw error;
        }
    }

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
            priceSource: priceSource
        };

        if (this.positionManager) {
            await this.positionManager.addPosition(position);
        }

        this.stats.tradesExecuted++;
        this.stats.buyOrders++;

        logger.info(`📝 Paper buy: ${expectedTokens.toFixed(2)} ${alert.token.symbol} @ ${currentPrice.toFixed(12)} SOL`);
        
        this.emit('tradeExecuted', {
            type: 'PAPER_BUY',
            symbol: alert.token.symbol,
            amount: expectedTokens.toString(),
            price: currentPrice,
            investmentAmount: investmentAmount,
            signature: position.txHash
        });

        return position;
    }

    calculateInvestmentAmount(alert) {
        let amount = this.config.initialInvestment;
        if (alert.twitter?.likes >= 1000) amount *= 1.2;
        if (alert.twitter?.views >= 1000000) amount *= 1.2;
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

    isTradingEnabledStatus() {
        return this.isTradingEnabled;
    }

    getStats() {
        const winRate = this.stats.tradesExecuted > 0 ? 
            (this.stats.profitableTrades / this.stats.tradesExecuted * 100).toFixed(1) : '0';

        return {
            ...this.stats,
            winRate: winRate + '%',
            config: {
                mode: this.config.tradingMode,
                initialInvestment: this.config.initialInvestment,
                pumpSwapSdk: !!this.pumpSdk,
                priceMethod: this.pumpSdk ? 'Manual + SDK' : 'Mock only'
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