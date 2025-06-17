// src/bot/tradingBot.js - PumpSwap integrated trading bot
const EventEmitter = require('events');
const logger = require('../utils/logger');
const PumpSwapService = require('../services/pumpSwapService');

class TradingBot extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            tradingMode: config.tradingMode || process.env.TRADING_MODE || 'paper',
            initialInvestment: parseFloat(config.initialInvestment || process.env.INITIAL_INVESTMENT_SOL) || 0.01,
            stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE) || 50,
            buySlippage: parseFloat(process.env.BUY_SLIPPAGE_TOLERANCE) || 30,
            sellSlippage: parseFloat(process.env.SELL_SLIPPAGE_TOLERANCE) || 100,
            slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 30,
            privateKey: process.env.PRIVATE_KEY,
            takeProfitLevels: [
                { percentage: 100, sellPercentage: 50 },  // 2x - sell 50%
                { percentage: 300, sellPercentage: 25 },  // 4x - sell 25%
                { percentage: 900, sellPercentage: 100 }  // 10x - sell rest
            ]
        };

        this.positionManager = config.positionManager;
        
        // PumpSwap service handles all trading operations
        this.pumpSwapService = new PumpSwapService({
            privateKey: this.config.privateKey,
            buySlippage: this.config.buySlippage,
            sellSlippage: this.config.sellSlippage,
            rpcUrl: config.rpcUrl
        });

        // Connect this bot to the position manager
        if (this.positionManager) {
            this.positionManager.setTradingBot(this);
        }
        
        // Trading statistics
        this.stats = {
            alertsProcessed: 0,
            tradesExecuted: 0,
            buyOrders: 0,
            sellOrders: 0,
            totalPnL: 0,
            liveTrades: 0,
            paperTrades: 0,
            stopLossExecutions: 0,
            takeProfitExecutions: 0,
            errors: 0
        };

        this.isTradingEnabled = true;
        this.isInitialized = false;
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing PumpSwap trading bot...');
            logger.info(`💰 Trading mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`🎯 Initial investment: ${this.config.initialInvestment} SOL`);
            logger.info(`🛡️ Stop loss: ${this.config.stopLossPercentage}%`);
            
            // 🔥 NEW: Log separate slippage settings
            logger.info(`📈 Buy slippage: ${this.config.buySlippage}% (conservative entry)`);
            logger.info(`📉 Sell slippage: ${this.config.sellSlippage}% (guaranteed exit)`);
            
            // Check if PumpSwap service is ready
            if (this.pumpSwapService.wallet) {
                logger.info(`💼 Wallet: ${this.pumpSwapService.wallet.publicKey.toString()}`);
            }
            
            // Log slippage strategy explanation
            if (this.config.sellSlippage >= 50) {
                logger.info(`🚨 High sell slippage configured - sells will execute even during major dumps`);
            }
            
            logger.info('✅ PumpSwap trading bot initialized');
            this.isInitialized = true;
        } catch (error) {
            logger.error('❌ Failed to initialize:', error);
            throw error;
        }
    }

    // Get current token price using PumpSwap
    async getTokenPrice(tokenAddress, forceRefresh = false, migrationPool = null) {
        try {
            const marketData = await this.pumpSwapService.getMarketData(tokenAddress);
            if (marketData && marketData.price) {
                return marketData.price; // Return just the price number
            }
            
            throw new Error('Price not available from PumpSwap');
        } catch (error) {
            this.stats.errors++;
            logger.error(`❌ Price fetch failed for ${tokenAddress}: ${error.message}`);
            throw error;
        }
    }

    // Find pool address using PumpSwap service
    async findPoolAddress(tokenAddress) {
        try {
            return await this.pumpSwapService.findPool(tokenAddress);
        } catch (error) {
            logger.error(`❌ Pool derivation failed: ${error.message}`);
            return null;
        }
    }

    // Execute buy order
    async executeBuy(alert) {
        try {
            const tokenAddress = alert.token.address;
            const symbol = alert.token.symbol;
            const investmentAmount = this.config.initialInvestment;
            
            logger.info(`💰 Executing BUY: ${investmentAmount} SOL → ${symbol}`);

            if (this.config.tradingMode === 'live') {
                // Live trading via PumpSwap
                const result = await this.pumpSwapService.executeBuy(
                    tokenAddress, 
                    investmentAmount, 
                    this.config.buySlippage
                );
                
                if (result.success) {
                    const currentPrice = investmentAmount / result.tokensReceived;
                    const position = await this.createLivePosition(alert, investmentAmount, currentPrice, result);
                    
                    this.stats.liveTrades++;
                    this.stats.buyOrders++;
                    this.stats.tradesExecuted++;
                    
                    this.emit('tradeExecuted', {
                        type: 'LIVE_BUY',
                        symbol: symbol,
                        amount: result.tokensReceived,
                        price: currentPrice,
                        signature: result.signature,
                        method: 'pumpswap'
                    });
                    
                    return position;
                }
                
                throw new Error('PumpSwap buy failed');
            } else {
                // Paper trading
                const priceInfo = await this.getTokenPrice(tokenAddress, true);
                const expectedTokens = investmentAmount / priceInfo;
                const position = await this.createPaperPosition(alert, investmentAmount, priceInfo, expectedTokens);
                
                this.stats.paperTrades++;
                this.stats.buyOrders++;
                this.stats.tradesExecuted++;
                
                this.emit('tradeExecuted', {
                    type: 'PAPER_BUY',
                    symbol: symbol,
                    amount: expectedTokens,
                    price: priceInfo,
                    method: 'simulated'
                });
                
                return position;
            }

        } catch (error) {
            this.stats.errors++;
            logger.error(`❌ Buy execution failed: ${error.message}`);
            throw error;
        }
    }

    // Execute sell order (called by position manager)
    async executePumpSwapSell(position, sellPercentage, reason = 'Manual Sell') {
        try {
            if (this.config.tradingMode === 'live') {
                // Live selling via PumpSwap
                const tokenAmount = parseFloat(position.remainingQuantity) * (sellPercentage / 100);
                
                const result = await this.pumpSwapService.executeSell(
                    position.tokenAddress,
                    tokenAmount,
                    this.config.sellSlippage
                );
                
                if (result.success) {
                    // Calculate PnL
                    const originalInvestment = (tokenAmount / parseFloat(position.quantity)) * position.investedAmount;
                    const pnl = result.solReceived - originalInvestment;
                    const pnlPercentage = (pnl / originalInvestment) * 100;
                    
                    this.stats.liveTrades++;
                    this.stats.sellOrders++;
                    this.stats.totalPnL += pnl;
                    
                    if (reason.includes('Stop Loss')) {
                        this.stats.stopLossExecutions++;
                    } else if (reason.includes('Take Profit')) {
                        this.stats.takeProfitExecutions++;
                    }
                    
                    // Update position through position manager
                    if (this.positionManager) {
                        await this.positionManager.updatePositionAfterSell(
                            position.id,
                            tokenAmount,
                            result.solReceived,
                            pnl,
                            result.signature,
                            reason
                        );
                    }
                    
                    this.emit('tradeExecuted', {
                        type: 'LIVE_SELL',
                        symbol: position.symbol,
                        amount: tokenAmount,
                        price: result.solReceived / tokenAmount,
                        signature: result.signature,
                        pnl: pnl,
                        pnlPercentage: pnlPercentage,
                        reason: reason,
                        method: 'pumpswap'
                    });
                    
                    return {
                        success: true,
                        signature: result.signature,
                        tokensSold: tokenAmount,
                        solReceived: result.solReceived,
                        pnl: pnl,
                        pnlPercentage: pnlPercentage,
                        method: 'pumpswap'
                    };
                }
                
                throw new Error('PumpSwap sell failed');
            } else {
                // Paper trading simulation
                return await this.simulatePaperSell(position, sellPercentage, reason);
            }

        } catch (error) {
            this.stats.errors++;
            logger.error(`❌ Sell execution failed: ${error.message}`);
            throw error;
        }
    }

    // Create live position
    async createLivePosition(alert, investmentAmount, currentPrice, tradeResult) {
        const stopLossPrice = this.calculateStopLossPrice(currentPrice);
        const takeProfitPrices = this.calculateTakeProfitPrices(currentPrice);
    
        const position = {
            id: this.generatePositionId(),
            tokenAddress: alert.token.address,
            symbol: alert.token.symbol,
            side: 'LONG',
            entryPrice: currentPrice,
            quantity: tradeResult.tokensReceived.toString(),
            investedAmount: investmentAmount,
            entryTime: Date.now(),
            txHash: tradeResult.signature,
            stopLossPrice: stopLossPrice,
            takeProfitLevels: takeProfitPrices,
            remainingQuantity: tradeResult.tokensReceived.toString(),
            alert: alert,
            paperTrade: false,
            priceSource: 'pumpswap_service',
            migrationPool: tradeResult.poolAddress, // 🔥 FIXED: Store actual pool address from buy result
            poolAddress: tradeResult.poolAddress, // 🔥 FIXED: Store pool address for price updates
            eventType: alert.eventType || 'creation',
            isMigration: alert.migration ? true : false,
            tradingMethod: 'pumpswap'
        };
    
        if (this.positionManager) {
            await this.positionManager.addPosition(position);
        }
    
        return position;
    }

    // Calculate stop loss price
    calculateStopLossPrice(entryPrice) {
        return entryPrice * (1 - this.config.stopLossPercentage / 100);
    }

    // Calculate take profit levels
    calculateTakeProfitPrices(entryPrice) {
        return this.config.takeProfitLevels.map((level, index) => ({
            targetPrice: entryPrice * (1 + level.percentage / 100),
            sellPercentage: level.sellPercentage,
            percentage: level.percentage,
            triggered: false,
            level: index + 1
        }));
    }

    // Generate unique position ID
    generatePositionId() {
        return 'pos_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    // Process incoming alerts
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

    // Get trading statistics
    getStats() {
        const serviceStats = this.pumpSwapService.getStats();
        
        return {
            // Trading Bot stats
            alertsProcessed: this.stats.alertsProcessed,
            tradesExecuted: this.stats.tradesExecuted,
            buyOrders: this.stats.buyOrders,
            sellOrders: this.stats.sellOrders,
            liveTrades: this.stats.liveTrades,
            paperTrades: this.stats.paperTrades,
            totalPnL: this.stats.totalPnL.toFixed(6) + ' SOL',
            stopLossExecutions: this.stats.stopLossExecutions,
            takeProfitExecutions: this.stats.takeProfitExecutions,
            errors: this.stats.errors,
            
            // PumpSwap Service stats
            pumpSwap: {
                poolsFound: serviceStats.poolsFound,
                poolsNotFound: serviceStats.poolsNotFound,
                buysExecuted: serviceStats.buysExecuted,
                sellsExecuted: serviceStats.sellsExecuted,
                successRate: serviceStats.successRate,
                wallet: serviceStats.wallet
            },
            
            config: {
                mode: this.config.tradingMode,
                initialInvestment: this.config.initialInvestment + ' SOL',
                stopLoss: this.config.stopLossPercentage + '%',
                slippage: this.config.slippageTolerance + '%',
                tradingMethod: 'PumpSwap Integration'
            }
        };
    }

    // Trading controls
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
        logger.info('🛑 PumpSwap trading bot stopped');
    }
}

module.exports = TradingBot;