// src/bot/tradingBot.js - CLEAN: Delegates to PumpSwapService
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
            slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 5,
            privateKey: process.env.PRIVATE_KEY,
            takeProfitLevels: [
                { percentage: 100, sellPercentage: 50 },  // 2x - sell 50%
                { percentage: 300, sellPercentage: 25 },  // 4x - sell 25%
                { percentage: 900, sellPercentage: 100 }  // 10x - sell rest
            ]
        };

        this.positionManager = config.positionManager;
        
        // 🚀 SINGLE SOURCE OF TRUTH: PumpSwapService handles ALL PumpSwap operations
        this.pumpSwapService = new PumpSwapService({
            privateKey: this.config.privateKey,
            slippageTolerance: this.config.slippageTolerance,
            rpcUrl: config.rpcUrl
        });
        
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
            logger.info('🔧 Initializing trading bot...');
            logger.info(`💰 Trading mode: ${this.config.tradingMode.toUpperCase()}`);
            
            // The PumpSwapService handles all initialization internally
            logger.info('✅ Trading bot initialized (PumpSwap service ready)');
            this.isInitialized = true;
        } catch (error) {
            logger.error('❌ Failed to initialize:', error);
            throw error;
        }
    }

    // 🚀 DELEGATE: Price fetching to PumpSwapService
    async getTokenPrice(tokenAddress, forceRefresh = false, migrationPool = null) {
        try {
            // Let PumpSwapService handle all price logic
            const marketData = await this.pumpSwapService.getMarketData(tokenAddress);
            if (marketData && marketData.price) {
                return {
                    price: marketData.price,
                    poolAddress: marketData.poolAddress,
                    source: 'pumpswap_service'
                };
            }
            
            throw new Error('Price not available');
        } catch (error) {
            this.stats.errors++;
            logger.error(`❌ Price fetch failed for ${tokenAddress}: ${error.message}`);
            throw error;
        }
    }

    // 🚀 DELEGATE: Pool derivation to PumpSwapService
    async findPoolAddress(tokenAddress) {
        try {
            return await this.pumpSwapService.findPool(tokenAddress);
        } catch (error) {
            logger.error(`❌ Pool derivation failed: ${error.message}`);
            return null;
        }
    }

    // 🚀 MAIN: Execute buy (delegates to service for live trades)
    async executeBuy(alert) {
        try {
            const tokenAddress = alert.token.address;
            const symbol = alert.token.symbol;
            const investmentAmount = this.config.initialInvestment;
            
            logger.info(`💰 Executing BUY: ${investmentAmount} SOL → ${symbol}`);

            if (this.config.tradingMode === 'live') {
                // 🚀 LIVE TRADING: Delegate to PumpSwapService
                const result = await this.pumpSwapService.executeBuy(
                    tokenAddress, 
                    investmentAmount, 
                    this.config.slippageTolerance
                );
                
                if (result.success) {
                    const currentPrice = investmentAmount / result.tokensReceived; // Calculate actual price
                    const position = await this.createPosition(alert, investmentAmount, currentPrice, result);
                    
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
                // 📝 PAPER TRADING: Use service for price, simulate trade
                const priceInfo = await this.getTokenPrice(tokenAddress, true);
                const expectedTokens = investmentAmount / priceInfo.price;
                const position = await this.createPaperPosition(alert, investmentAmount, priceInfo.price, expectedTokens);
                
                this.stats.paperTrades++;
                this.stats.buyOrders++;
                this.stats.tradesExecuted++;
                
                this.emit('tradeExecuted', {
                    type: 'PAPER_BUY',
                    symbol: symbol,
                    amount: expectedTokens,
                    price: priceInfo.price,
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

    // 🚀 MAIN: Execute sell (delegates to service for live trades)
    async executePumpSwapSell(position, sellPercentage, reason = 'Manual Sell') {
        try {
            if (this.config.tradingMode === 'live') {
                // 🚀 LIVE TRADING: Delegate to PumpSwapService
                const tokenAmount = parseFloat(position.remainingQuantity) * (sellPercentage / 100);
                
                const result = await this.pumpSwapService.executeSell(
                    position.tokenAddress,
                    tokenAmount,
                    this.config.slippageTolerance
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
                // 📝 PAPER TRADING: Simulate sell
                return await this.simulatePaperSell(position, sellPercentage, reason);
            }

        } catch (error) {
            this.stats.errors++;
            logger.error(`❌ Sell execution failed: ${error.message}`);
            throw error;
        }
    }

    // 🚀 HELPER: Create live position
    async createPosition(alert, investmentAmount, currentPrice, tradeResult) {
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
            poolAddress: tradeResult.poolAddress || null,
            eventType: alert.eventType || 'creation',
            tradingMethod: 'pumpswap_service'
        };

        if (this.positionManager) {
            await this.positionManager.addPosition(position);
        }

        return position;
    }

    // 🚀 HELPER: Create paper position
    async createPaperPosition(alert, investmentAmount, currentPrice, expectedTokens) {
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
            eventType: alert.eventType || 'creation',
            tradingMethod: 'simulated'
        };

        if (this.positionManager) {
            await this.positionManager.addPosition(position);
        }

        return position;
    }

    // 🚀 HELPER: Simulate paper sell
    async simulatePaperSell(position, sellPercentage, reason) {
        const tokenAmount = parseFloat(position.remainingQuantity) * (sellPercentage / 100);
        const currentPrice = position.currentPrice || position.entryPrice;
        const solReceived = tokenAmount * currentPrice;
        const originalInvestment = (tokenAmount / parseFloat(position.quantity)) * position.investedAmount;
        const pnl = solReceived - originalInvestment;
        const pnlPercentage = (pnl / originalInvestment) * 100;
        
        logger.info(`📝 Paper sell: ${tokenAmount.toFixed(6)} ${position.symbol} for ${solReceived.toFixed(6)} SOL`);
        logger.info(`📊 Paper PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPercentage.toFixed(2)}%)`);
        
        this.stats.paperTrades++;
        this.stats.sellOrders++;
        this.stats.totalPnL += pnl;
        
        if (this.positionManager) {
            await this.positionManager.updatePositionAfterSell(
                position.id,
                tokenAmount,
                solReceived,
                pnl,
                'PAPER_SELL_' + Date.now(),
                reason
            );
        }
        
        return {
            success: true,
            signature: 'PAPER_SELL_' + Date.now(),
            tokensSold: tokenAmount,
            solReceived: solReceived,
            pnl: pnl,
            pnlPercentage: pnlPercentage,
            method: 'simulated'
        };
    }

    // Helper methods
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
        // Combine trading bot stats with PumpSwap service stats
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
                successRate: serviceStats.successRate
            },
            
            config: {
                mode: this.config.tradingMode,
                tradingMethod: 'PumpSwap Service Integration'
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
        logger.info('🛑 Trading bot stopped');
    }
}

module.exports = TradingBot;