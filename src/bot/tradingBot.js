// src/bot/tradingBot.js - PumpSwap integrated trading bot (LIVE ONLY)
const EventEmitter = require('events');
const logger = require('../utils/logger');
const PumpSwapService = require('../services/pumpSwapService');
const HolderConcentrationChecker = require('../analysis/holderConcentrationChecker');

class TradingBot extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            tradingMode: config.tradingMode || process.env.TRADING_MODE || 'live',
            initialInvestment: parseFloat(config.initialInvestment || process.env.INITIAL_INVESTMENT_SOL) || 0.01,
            stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE) || 50,
            buySlippage: parseFloat(process.env.BUY_SLIPPAGE_TOLERANCE) || 30,
            sellSlippage: parseFloat(process.env.SELL_SLIPPAGE_TOLERANCE) || 100,
            slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 30,
            privateKey: process.env.PRIVATE_KEY,
            takeProfitLevels: [
                { 
                    percentage: parseFloat(process.env.TAKE_PROFIT_1_PERCENTAGE) || 100, 
                    sellPercentage: parseFloat(process.env.TAKE_PROFIT_1_SELL_PERCENTAGE) || 50 
                },
                { 
                    percentage: parseFloat(process.env.TAKE_PROFIT_2_PERCENTAGE) || 300, 
                    sellPercentage: parseFloat(process.env.TAKE_PROFIT_2_SELL_PERCENTAGE) || 25 
                },
                { 
                    percentage: parseFloat(process.env.TAKE_PROFIT_3_PERCENTAGE) || 900, 
                    sellPercentage: parseFloat(process.env.TAKE_PROFIT_3_SELL_PERCENTAGE) || 100 
                }
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
            stopLossExecutions: 0,
            takeProfitExecutions: 0,
            errors: 0
        };

        this.isTradingEnabled = true;
        this.isInitialized = false;
    
        // Add holder concentration checker
        this.holderChecker = new HolderConcentrationChecker();

        // Configuration for pre-trade checks
        this.preTradeChecks = {
            enableHolderCheck: config.enableHolderCheck !== false, // Default enabled
            holderConcentrationThreshold: config.holderConcentrationThreshold || 70,
            skipChecksInPaperMode: config.skipChecksInPaperMode || false
        };
        
        // Update the checker threshold if custom value provided
        if (config.holderConcentrationThreshold) {
            this.holderChecker.setConcentrationThreshold(config.holderConcentrationThreshold);
        }
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing PumpSwap trading bot...');
            logger.info(`💰 Trading mode: ${this.config.tradingMode.toUpperCase()}`);
            logger.info(`🎯 Initial investment: ${this.config.initialInvestment} SOL`);
            logger.info(`🛡️ Stop loss: ${this.config.stopLossPercentage}%`);
            
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
                return marketData.price;
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

        // Add this new method to your TradingBot class
        async performPreTradeValidation(tokenAddress, symbol) {
            logger.info(`🔍 Performing pre-trade validation for ${symbol} (${tokenAddress})`);
            
            const validationResults = {
                holderCheck: { passed: true, reason: 'Skipped' },
                overallSafe: true,
                reasons: []
            };
    
            // Skip all checks in paper mode if configured
            if (this.config.tradingMode === 'paper' && this.preTradeChecks.skipChecksInPaperMode) {
                logger.info(`📝 PAPER MODE: Skipping pre-trade validation checks`);
                return validationResults;
            }
    
            // Holder concentration check
            if (this.preTradeChecks.enableHolderCheck) {
                try {
                    logger.info(`📊 Checking holder concentration for ${symbol}...`);
                    const holderResult = await this.holderChecker.checkConcentration(tokenAddress);
                    
                    validationResults.holderCheck = {
                        passed: holderResult.safe,
                        concentration: holderResult.concentration,
                        holderCount: holderResult.holderCount,
                        reason: holderResult.reason || `${holderResult.concentration.toFixed(1)}% concentration`
                    };
    
                    if (!holderResult.safe) {
                        validationResults.overallSafe = false;
                        validationResults.reasons.push(`Holder concentration: ${holderResult.reason}`);
                        logger.warn(`🚫 HOLDER CHECK FAILED: ${symbol} - ${holderResult.reason}`);
                    } else {
                        logger.info(`✅ HOLDER CHECK PASSED: ${symbol} - ${holderResult.concentration.toFixed(1)}% concentration`);
                    }
    
                } catch (error) {
                    logger.error(`❌ Holder check error for ${symbol}: ${error.message}`);
                    validationResults.holderCheck = {
                        passed: false,
                        reason: `Check failed: ${error.message}`
                    };
                    validationResults.overallSafe = false;
                    validationResults.reasons.push('Holder check failed');
                }
            }
    
            // Log overall result
            if (validationResults.overallSafe) {
                logger.info(`✅ Pre-trade validation PASSED for ${symbol}`);
            } else {
                logger.warn(`🚫 Pre-trade validation FAILED for ${symbol}: ${validationResults.reasons.join(', ')}`);
            }
    
            return validationResults;
        }

    // Execute buy order (LIVE ONLY)
    async executeBuy(alert) {
        try {
            const tokenAddress = alert.token.address;
            const symbol = alert.token.symbol;
            const investmentAmount = this.config.initialInvestment;
            
            logger.info(`💰 Executing BUY: ${investmentAmount} SOL → ${symbol}`);
            
            // Execute live trade
            const result = await this.pumpSwapService.executeBuy(
                tokenAddress, 
                investmentAmount, 
                this.config.buySlippage
            );
            
            if (result.success) {
                // Use the price that was calculated during the buy operation
                const currentPrice = result.calculatedPrice;
                
                if (!currentPrice || currentPrice <= 0) {
                    throw new Error('No calculated price returned from buy operation');
                }
                
                logger.info(`💰 Using calculated price: ${currentPrice.toFixed(12)} SOL per token`);
            
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

        } catch (error) {
            this.stats.errors++;
            logger.error(`❌ Buy execution failed: ${error.message}`);
            throw error;
        }
    }

    // Execute sell order (called by position manager)
    async executePumpSwapSell(position, sellPercentage, reason = 'Manual Sell') {
        try {
            // Live selling via PumpSwap
            const tokenAmount = parseFloat(position.remainingQuantity) * (sellPercentage / 100);
            
            const result = await this.pumpSwapService.executeSell(
                position.tokenAddress,
                tokenAmount,
                this.config.sellSlippage
            );
            
            if (result.success) {
                // 🔥 FIXED: Use exact amounts from result, not estimates
                const actualTokensSold = result.exactData?.exactTokensSold || result.tokensSpent || tokenAmount;
                const actualSolReceived = result.exactData?.exactSolReceived || result.solReceived;
                
                // Calculate PnL based on actual amounts
                const originalInvestment = (actualTokensSold / parseFloat(position.quantity)) * position.investedAmount;
                const pnl = actualSolReceived - originalInvestment;
                const pnlPercentage = (pnl / originalInvestment) * 100;
                
                this.stats.liveTrades++;
                this.stats.sellOrders++;
                this.stats.totalPnL += pnl;
                
                if (reason.includes('Stop Loss')) {
                    this.stats.stopLossExecutions++;
                } else if (reason.includes('Take Profit')) {
                    this.stats.takeProfitExecutions++;
                }
                
                logger.info(`💰 EXACT SELL RESULTS:`);
                logger.info(`   Tokens Sold: ${actualTokensSold.toLocaleString()} (${sellPercentage}%)`);
                logger.info(`   SOL Received: ${actualSolReceived.toFixed(6)} SOL`);
                logger.info(`   Original Investment: ${originalInvestment.toFixed(6)} SOL`);
                logger.info(`   PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPercentage >= 0 ? '+' : ''}${pnlPercentage.toFixed(1)}%)`);
                
                // Update position through position manager with EXACT data
                if (this.positionManager) {
                    await this.positionManager.updatePositionAfterSell(
                        position.id,
                        actualTokensSold,
                        actualSolReceived,
                        pnl,
                        result.signature,
                        reason
                    );
                }
                
                this.emit('tradeExecuted', {
                    type: 'LIVE_SELL',
                    symbol: position.symbol,
                    amount: actualTokensSold,
                    price: actualSolReceived / actualTokensSold,
                    signature: result.signature,
                    pnl: pnl,
                    pnlPercentage: pnlPercentage,
                    reason: reason,
                    method: 'pumpswap'
                });
                
                return {
                    success: true,
                    signature: result.signature,
                    tokensSold: actualTokensSold,
                    solReceived: actualSolReceived,
                    pnl: pnl,
                    pnlPercentage: pnlPercentage,
                    method: 'pumpswap'
                };
            }
            
            throw new Error('PumpSwap sell failed');
    
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
        const actualInvestment = tradeResult.exactData?.exactSolSpent || tradeResult.solSpent || investmentAmount;

        const position = {
            id: this.generatePositionId(),
            tokenAddress: alert.token.address,
            symbol: alert.token.symbol,
            side: 'LONG',
            entryPrice: currentPrice,
            quantity: tradeResult.tokensReceived.toString(),
            investedAmount: actualInvestment,
            entryTime: Date.now(),
            txHash: tradeResult.signature,
            stopLossPrice: stopLossPrice,
            takeProfitLevels: takeProfitPrices,
            remainingQuantity: tradeResult.tokensReceived.toString(),
            alertData: alert,
            paperTrade: false,
            priceSource: 'pumpswap_service',
            migrationPool: tradeResult.poolAddress,
            poolAddress: tradeResult.poolAddress,
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
    async processAlert(alertData) {
        if (!this.isTradingEnabled || !this.isInitialized) return;

        try {
            const { token, twitter, confidence } = alertData;
            const symbol = token.symbol || 'Unknown';
            
            this.stats.alertsProcessed++; // 🔥 INCREMENT STATS
            logger.info(`🎯 Processing alert: ${symbol} (${token.address})`);

            // Check if we already have a position in this token FIRST
            if (this.positionManager?.hasPosition(token.address)) {
                logger.info(`⏭️ Already have position in ${symbol}`);
                return;
            }

            // Check if we can accept new positions
            if (!this.canAcceptNewPosition()) {
                logger.warn(`⚠️ Cannot accept new position: ${this.getPositionLimitReason()}`);
                return;
            }

            // 🔥 Pre-trade validation with holder concentration check
            const validation = await this.performPreTradeValidation(token.address, symbol);
            
            if (!validation.overallSafe) {
                logger.warn(`🚫 TRADE BLOCKED: ${symbol} failed pre-trade validation`);
                logger.warn(`📋 Validation failures: ${validation.reasons.join(', ')}`);
                
                // Emit event for monitoring
                this.emit('tradeBlocked', {
                    symbol,
                    address: token.address,
                    reason: 'Pre-trade validation failed',
                    details: validation.reasons,
                    holderConcentration: validation.holderCheck.concentration
                });
                
                return;
            }

            // Continue with existing buy logic...
            logger.info(`✅ Pre-trade validation passed, proceeding with buy order for ${symbol}`);
            
            // 🔥 FIXED: Call the correct method name
            const buyResult = await this.executeBuy(alertData);
            
            if (buyResult) {
                logger.info(`🎯 Buy order successful for ${symbol}`);
                this.emit('tradeExecuted', {
                    type: 'BUY',
                    symbol,
                    address: token.address,
                    result: buyResult,
                    validation: validation // Include validation results
                });
            }

        } catch (error) {
            logger.error(`❌ Error processing alert:`, error);
            this.stats.errors++;
        }
    }

    // Check if we can accept new positions
    canAcceptNewPosition() {
        if (!this.positionManager) {
            logger.debug('No position manager available - allowing position');
            return true;
        }
        
        const activePositions = this.positionManager.getActivePositionsCount();
        const maxPositions = this.positionManager.config?.maxPositions || 10;
        const canAccept = activePositions < maxPositions;
        
        logger.debug(`Position check: ${activePositions}/${maxPositions} positions - ${canAccept ? 'CAN' : 'CANNOT'} accept new`);
        return canAccept;
    }

    // Get reason why we can't accept new positions
    getPositionLimitReason() {
        if (!this.positionManager) {
            return 'Position manager not available';
        }
        
        const activePositions = this.positionManager.getActivePositionsCount();
        const maxPositions = this.positionManager.config?.maxPositions || 10;
        
        if (activePositions >= maxPositions) {
            return `Maximum positions reached: ${activePositions}/${maxPositions}`;
        }
        
        return `Active positions: ${activePositions}/${maxPositions}`;
    }
    

    // Add method to update holder check settings at runtime
    updateHolderCheckSettings(settings) {
        if (settings.enabled !== undefined) {
            this.preTradeChecks.enableHolderCheck = settings.enabled;
            logger.info(`📊 Holder checks ${settings.enabled ? 'ENABLED' : 'DISABLED'}`);
        }

        if (settings.threshold !== undefined && settings.threshold >= 0 && settings.threshold <= 100) {
            this.preTradeChecks.holderConcentrationThreshold = settings.threshold;
            this.holderChecker.setConcentrationThreshold(settings.threshold);
            logger.info(`📊 Holder concentration threshold updated to ${settings.threshold}%`);
        }

        if (settings.skipInPaperMode !== undefined) {
            this.preTradeChecks.skipChecksInPaperMode = settings.skipInPaperMode;
            logger.info(`📝 Skip checks in paper mode: ${settings.skipInPaperMode}`);
        }
    }

    // Add method to get current pre-trade check status
    getPreTradeCheckStatus() {
        return {
            ...this.preTradeChecks,
            holderCheckerConfig: this.holderChecker.getConfig()
        };
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