// src/bot/positionManager.js - ENHANCED: Live PumpSwap sell integration for stop loss & take profit
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class PositionManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            tradingMode: config.tradingMode || 'paper',
            positionsFile: config.positionsFile || './positions.json',
            maxPositions: config.maxPositions || 20,
            // Enhanced update intervals for live trading
            fastUpdateInterval: config.fastUpdateInterval || 1000,  // 1s for live monitoring
            slowUpdateInterval: config.slowUpdateInterval || 60000, // 1min for fallback
            ...config
        };

        this.positions = new Map();
        this.closedPositions = new Map();
        this.tradingBot = null;
        
        // Track price source performance
        this.priceUpdateStats = {
            poolBased: { attempts: 0, successes: 0, totalTime: 0 },
            fallback: { attempts: 0, successes: 0, totalTime: 0 },
            lastUpdate: Date.now()
        };
        
        this.stats = {
            stopLossTriggered: 0,
            takeProfitTriggered: 0,
            priceUpdates: 0,
            poolBasedPriceUpdates: 0,
            fallbackPriceUpdates: 0,
            priceUpdateFailures: 0,
            // Live trading stats
            liveSellsExecuted: 0,
            paperSellsExecuted: 0,
            stopLossExecutions: 0,
            takeProfitExecutions: 0,
            totalLivePnL: 0
        };
        
        this.loadPositions();
        this.startEnhancedPriceUpdates();
        this.startPriceStatsLogging();
    }

    setTradingBot(tradingBot) {
        this.tradingBot = tradingBot;
        logger.info('📊 Enhanced TradingBot connected for live trading & price updates');
    }

    // Enhanced price updates with live monitoring
    startEnhancedPriceUpdates() {
        // Fast updates for live trading (1 second for critical monitoring)
        setInterval(async () => {
            if (this.positions.size > 0 && this.tradingBot) {
                await this.updateAllPositionsFast();
            }
        }, this.config.fastUpdateInterval);
        
        // Slower fallback updates (1 minute)
        setInterval(async () => {
            if (this.positions.size > 0 && this.tradingBot) {
                await this.updateAllPositionsSlow();
            }
        }, this.config.slowUpdateInterval);
        
        logger.info(`📊 Enhanced price monitoring started:`);
        logger.info(`   🔧 Pool-based: ${this.config.fastUpdateInterval}ms intervals`);
        logger.info(`   🪐 Fallback: ${this.config.slowUpdateInterval}ms intervals`);
    }

    // Log price source stats every minute
    startPriceStatsLogging() {
        setInterval(() => {
            const poolBased = this.priceUpdateStats.poolBased;
            const fallback = this.priceUpdateStats.fallback;
            
            if (poolBased.attempts > 0 || fallback.attempts > 0) {
                const poolSuccess = poolBased.attempts > 0 ? ((poolBased.successes / poolBased.attempts) * 100).toFixed(1) : '0';
                const fallbackSuccess = fallback.attempts > 0 ? ((fallback.successes / fallback.attempts) * 100).toFixed(1) : '0';
                const poolAvg = poolBased.successes > 0 ? (poolBased.totalTime / poolBased.successes).toFixed(0) : 'N/A';
                const fallbackAvg = fallback.successes > 0 ? (fallback.totalTime / fallback.successes).toFixed(0) : 'N/A';
                
                logger.info('📊 POSITION PRICE UPDATE STATS:');
                logger.info(`   🔧 Pool-based: ${poolBased.successes}/${poolBased.attempts} (${poolSuccess}%) avg: ${poolAvg}ms`);
                logger.info(`   🪐 Fallback: ${fallback.successes}/${fallback.attempts} (${fallbackSuccess}%) avg: ${fallbackAvg}ms`);
                
                // Show live trading stats if any
                if (this.stats.liveSellsExecuted > 0 || this.stats.paperSellsExecuted > 0) {
                    logger.info('💰 TRADING EXECUTION STATS:');
                    logger.info(`   🚀 Live sells: ${this.stats.liveSellsExecuted}`);
                    logger.info(`   📝 Paper sells: ${this.stats.paperSellsExecuted}`);
                    logger.info(`   🛑 Stop losses: ${this.stats.stopLossExecutions}`);
                    logger.info(`   🎯 Take profits: ${this.stats.takeProfitExecutions}`);
                    logger.info(`   💎 Total Live PnL: ${this.stats.totalLivePnL.toFixed(6)} SOL`);
                }
                
                // Reset stats
                this.priceUpdateStats.poolBased = { attempts: 0, successes: 0, totalTime: 0 };
                this.priceUpdateStats.fallback = { attempts: 0, successes: 0, totalTime: 0 };
            }
        }, 60000); // Every minute
    }

    // FAST: Update all positions using pool-based method
    async updateAllPositionsFast() {
        for (const position of this.positions.values()) {
            try {
                // Use the working getTokenPrice method from trading bot
                const currentPrice = await this.getPositionPricePoolBased(position);
                
                if (currentPrice && currentPrice !== position.currentPrice) {
                    await this.updatePositionPrice(position, currentPrice, 'pool_based');
                    
                    // 🚀 ENHANCED: Check triggers after price update with live execution
                    await this.checkStopLossWithLiveExecution(position);
                    await this.checkTakeProfitsWithLiveExecution(position);
                }
                
            } catch (error) {
                logger.debug(`Fast price update failed for ${position.symbol}: ${error.message}`);
            }
        }
    }

    // SLOW: Update all positions using fallback method
    async updateAllPositionsSlow() {
        for (const position of this.positions.values()) {
            try {
                // Only use fallback if pool-based method hasn't updated recently
                const timeSinceLastUpdate = Date.now() - (position.lastPriceUpdate || 0);
                
                if (timeSinceLastUpdate > 30000) { // If no update in 30 seconds
                    logger.debug(`📡 Using fallback for ${position.symbol} (no recent pool-based update)`);
                    
                    const currentPrice = await this.getPositionPriceFallback(position);
                    
                    if (currentPrice && currentPrice !== position.currentPrice) {
                        await this.updatePositionPrice(position, currentPrice, 'fallback');
                        
                        // Check triggers with fallback price too
                        await this.checkStopLossWithLiveExecution(position);
                        await this.checkTakeProfitsWithLiveExecution(position);
                    }
                }
                
            } catch (error) {
                logger.debug(`Fallback price update failed for ${position.symbol}: ${error.message}`);
            }
        }
    }

    // Get position price using pool-based method
    async getPositionPricePoolBased(position) {
        const startTime = Date.now();
        this.priceUpdateStats.poolBased.attempts++;
        
        try {
            // Use the existing getTokenPrice method that actually works!
            const priceInfo = await this.tradingBot.getTokenPrice(
                position.tokenAddress, 
                true, // Force refresh
                position.poolAddress || position.migrationPool // Use known pool if available
            );
            
            let price;
            if (typeof priceInfo === 'object' && priceInfo.price) {
                price = priceInfo.price;
            } else if (typeof priceInfo === 'number') {
                price = priceInfo;
            } else {
                throw new Error('Invalid price format returned');
            }
            
            if (price && price > 0) {
                const duration = Date.now() - startTime;
                this.priceUpdateStats.poolBased.successes++;
                this.priceUpdateStats.poolBased.totalTime += duration;
                this.stats.poolBasedPriceUpdates++;
                
                logger.debug(`🔧 Pool-based price for ${position.symbol}: ${price.toFixed(12)} SOL (${duration}ms)`);
                return price;
            }
            
            return null;
            
        } catch (error) {
            logger.debug(`Pool-based price failed for ${position.symbol}: ${error.message}`);
            return null;
        }
    }

    // Get position price using fallback method
    async getPositionPriceFallback(position) {
        const startTime = Date.now();
        this.priceUpdateStats.fallback.attempts++;
        
        try {
            // For fallback, we can try to derive the pool if we don't have it
            if (!position.poolAddress && this.tradingBot.derivePoolAddress) {
                const derivedPool = this.tradingBot.derivePoolAddress(position.tokenAddress);
                if (derivedPool) {
                    position.poolAddress = derivedPool;
                    logger.debug(`📍 Derived pool for ${position.symbol}: ${derivedPool}`);
                }
            }
            
            // Try the same method but with derived pool
            const priceInfo = await this.tradingBot.getTokenPrice(
                position.tokenAddress, 
                true,
                position.poolAddress
            );
            
            let price;
            if (typeof priceInfo === 'object' && priceInfo.price) {
                price = priceInfo.price;
            } else if (typeof priceInfo === 'number') {
                price = priceInfo;
            } else {
                throw new Error('Invalid price format returned');
            }
            
            if (price && price > 0) {
                const duration = Date.now() - startTime;
                this.priceUpdateStats.fallback.successes++;
                this.priceUpdateStats.fallback.totalTime += duration;
                this.stats.fallbackPriceUpdates++;
                
                logger.debug(`🪐 Fallback price for ${position.symbol}: ${price.toFixed(12)} SOL (${duration}ms)`);
                return price;
            }
            
            return null;
            
        } catch (error) {
            logger.debug(`Fallback price failed for ${position.symbol}: ${error.message}`);
            return null;
        }
    }

    // Update position price with source tracking
    async updatePositionPrice(position, newPrice, source = 'unknown') {
        const remainingTokens = parseFloat(position.remainingQuantity);
        const currentValue = remainingTokens * newPrice;
        const investedValue = (remainingTokens / parseFloat(position.quantity)) * position.investedAmount;
        const unrealizedPnL = currentValue - investedValue;
        const priceChange = ((newPrice - position.entryPrice) / position.entryPrice) * 100;

        // Track price history
        if (!position.priceHistory) {
            position.priceHistory = [];
        }
        
        position.priceHistory.push({
            timestamp: Date.now(),
            price: newPrice,
            source: source
        });
        
        // Keep only last 100 price updates
        if (position.priceHistory.length > 100) {
            position.priceHistory = position.priceHistory.slice(-100);
        }

        position.currentPrice = newPrice;
        position.currentValue = currentValue;
        position.unrealizedPnL = unrealizedPnL;
        position.priceChange = priceChange;
        position.lastPriceUpdate = Date.now();
        position.lastPriceSource = source;

        this.positions.set(position.id, position);
        this.stats.priceUpdates++;
        
        // Enhanced logging with source information
        const sourceIcon = source === 'pool_based' ? '🔧' : source === 'fallback' ? '🪐' : '❓';
        const changeIcon = priceChange > 0 ? '📈' : priceChange < 0 ? '📉' : '➡️';
        
        logger.info(`${changeIcon} ${sourceIcon} ${position.symbol}: ${newPrice.toFixed(8)} SOL (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%) via ${source}`);
    }

    // 🚀 ENHANCED: Check stop loss with LIVE execution
    async checkStopLossWithLiveExecution(position) {
        if (!position.stopLossPrice || !position.currentPrice) return;
        
        if (position.currentPrice <= position.stopLossPrice) {
            const lossPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice * 100);
            
            logger.warn(`🛑 STOP LOSS TRIGGERED: ${position.symbol} at ${position.currentPrice.toFixed(8)} SOL (${lossPercent.toFixed(1)}%)`);
            
            try {
                if (this.tradingBot.config.tradingMode === 'live') {
                    // 🚀 EXECUTE LIVE PUMPSWAP SELL
                    logger.info(`🚀 Executing LIVE stop loss sell for ${position.symbol}...`);
                    
                    const sellResult = await this.tradingBot.executePumpSwapSell(
                        position, 
                        100, // Sell 100% on stop loss
                        `Stop Loss (-${Math.abs(lossPercent).toFixed(1)}%)`
                    );
                    
                    if (sellResult.success) {
                        logger.info(`✅ LIVE STOP LOSS EXECUTED: ${sellResult.solReceived.toFixed(6)} SOL received`);
                        logger.info(`📊 PnL: ${sellResult.pnl > 0 ? '+' : ''}${sellResult.pnl.toFixed(6)} SOL (${sellResult.pnlPercentage.toFixed(2)}%)`);
                        
                        this.stats.liveSellsExecuted++;
                        this.stats.stopLossExecutions++;
                        this.stats.totalLivePnL += sellResult.pnl;
                    }
                } else {
                    // Paper trading - simulate the sell
                    await this.simulatePartialSell(position, 100, `Stop Loss (-${Math.abs(lossPercent).toFixed(1)}%)`);
                    this.stats.paperSellsExecuted++;
                    this.stats.stopLossExecutions++;
                }
                
                this.stats.stopLossTriggered++;
                
                this.emit('stopLossTriggered', {
                    position: position,
                    triggerPrice: position.currentPrice,
                    lossPercentage: Math.abs(lossPercent),
                    priceSource: position.lastPriceSource,
                    executionMode: this.tradingBot.config.tradingMode
                });
                
            } catch (error) {
                logger.error(`❌ Stop loss execution failed for ${position.symbol}: ${error.message}`);
                // Mark position for manual intervention
                position.status = 'STOP_LOSS_FAILED';
                position.errorMessage = error.message;
            }
        }
    }

    // 🚀 ENHANCED: Check take profits with LIVE execution
    async checkTakeProfitsWithLiveExecution(position) {
        if (!position.takeProfitLevels || !position.currentPrice) return;
        
        for (const tp of position.takeProfitLevels) {
            if (tp.triggered || !tp.targetPrice) continue;
            
            if (position.currentPrice >= tp.targetPrice) {
                const gainPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice * 100);
                
                logger.info(`🎯 TAKE PROFIT ${tp.level} TRIGGERED: ${position.symbol} at ${position.currentPrice.toFixed(8)} SOL (+${gainPercent.toFixed(1)}%)`);
                
                tp.triggered = true;
                
                try {
                    if (this.tradingBot.config.tradingMode === 'live') {
                        // 🚀 EXECUTE LIVE PUMPSWAP SELL
                        logger.info(`🚀 Executing LIVE take profit ${tp.level} sell for ${position.symbol} (${tp.sellPercentage}%)...`);
                        
                        const sellResult = await this.tradingBot.executePumpSwapSell(
                            position, 
                            tp.sellPercentage,
                            `Take Profit ${tp.level} (+${gainPercent.toFixed(1)}%)`
                        );
                        
                        if (sellResult.success) {
                            logger.info(`✅ LIVE TAKE PROFIT ${tp.level} EXECUTED: ${sellResult.solReceived.toFixed(6)} SOL received`);
                            logger.info(`📊 PnL: +${sellResult.pnl.toFixed(6)} SOL (+${sellResult.pnlPercentage.toFixed(2)}%)`);
                            
                            this.stats.liveSellsExecuted++;
                            this.stats.takeProfitExecutions++;
                            this.stats.totalLivePnL += sellResult.pnl;
                        }
                    } else {
                        // Paper trading - simulate the sell
                        await this.simulatePartialSell(position, tp.sellPercentage, `Take Profit ${tp.level} (+${gainPercent.toFixed(1)}%)`);
                        this.stats.paperSellsExecuted++;
                        this.stats.takeProfitExecutions++;
                    }
                    
                    this.stats.takeProfitTriggered++;
                    
                    this.emit('takeProfitTriggered', {
                        position: position,
                        level: tp.level,
                        triggerPrice: position.currentPrice,
                        gainPercentage: gainPercent,
                        sellPercentage: tp.sellPercentage,
                        priceSource: position.lastPriceSource,
                        executionMode: this.tradingBot.config.tradingMode
                    });
                    
                } catch (error) {
                    logger.error(`❌ Take profit ${tp.level} execution failed for ${position.symbol}: ${error.message}`);
                    tp.triggered = false; // Reset so it can try again
                    tp.status = 'EXECUTION_FAILED';
                    tp.errorMessage = error.message;
                }
            }
        }
    }

    // Simulate partial sell for paper trading
    async simulatePartialSell(position, sellPercentage, reason) {
        const sellQuantity = (parseFloat(position.remainingQuantity) * sellPercentage / 100);
        const soldValue = sellQuantity * position.currentPrice;
        const originalInvestment = (sellQuantity / parseFloat(position.quantity)) * position.investedAmount;
        const pnl = soldValue - originalInvestment;
        
        logger.info(`📝 Paper sell: ${sellQuantity.toFixed(6)} ${position.symbol} for ${soldValue.toFixed(6)} SOL`);
        logger.info(`📊 Paper PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${((pnl / originalInvestment) * 100).toFixed(2)}%)`);
        
        await this.updatePositionAfterSell(
            position.id,
            sellQuantity,
            soldValue,
            pnl,
            'PAPER_SELL_' + Date.now(),
            reason
        );
    }

    // Close position completely
    async closePosition(positionId, reason = 'Manual Close') {
        const position = this.positions.get(positionId);
        if (!position) throw new Error(`Position ${positionId} not found`);
        
        const remainingQuantity = parseFloat(position.remainingQuantity);
        const currentValue = remainingQuantity * (position.currentPrice || position.entryPrice);
        const originalInvestment = (remainingQuantity / parseFloat(position.quantity)) * position.investedAmount;
        const finalPnL = currentValue - originalInvestment;
        
        if (this.tradingBot.config.tradingMode === 'live') {
            // Execute live sell
            try {
                const sellResult = await this.tradingBot.executePumpSwapSell(position, 100, reason);
                if (sellResult.success) {
                    logger.info(`✅ LIVE POSITION CLOSED: ${position.symbol} - ${sellResult.solReceived.toFixed(6)} SOL received`);
                    this.stats.liveSellsExecuted++;
                    this.stats.totalLivePnL += sellResult.pnl;
                }
            } catch (error) {
                logger.error(`❌ Live position close failed for ${position.symbol}: ${error.message}`);
                // Fall back to paper close
                await this.updatePositionAfterSell(
                    positionId,
                    remainingQuantity,
                    currentValue,
                    finalPnL,
                    'MANUAL_CLOSE_' + Date.now(),
                    reason + ' (Live close failed)'
                );
            }
        } else {
            // Paper close
            await this.updatePositionAfterSell(
                positionId,
                remainingQuantity,
                currentValue,
                finalPnL,
                'PAPER_CLOSE_' + Date.now(),
                reason
            );
        }
    }

    // Add new position (enhanced with price source tracking)
    async addPosition(position) {
        this.validatePosition(position);
        
        if (this.positions.size >= this.config.maxPositions) {
            throw new Error(`Maximum positions limit: ${this.config.maxPositions}`);
        }
        
        const enhancedPosition = {
            ...position,
            createdAt: Date.now(),
            status: 'ACTIVE',
            totalPnL: 0,
            currentPrice: position.entryPrice,
            currentValue: position.investedAmount,
            unrealizedPnL: 0,
            priceChange: 0,
            lastPriceUpdate: Date.now(),
            lastPriceSource: position.priceSource || 'entry',
            priceHistory: [{
                timestamp: Date.now(),
                price: position.entryPrice,
                source: 'entry'
            }]
        };
        
        this.positions.set(position.id, enhancedPosition);
        await this.savePositions();
        
        const priceSourceInfo = position.priceSource ? ` (${position.priceSource})` : '';
        const tradingModeInfo = position.paperTrade ? ' [PAPER]' : ' [LIVE]';
        
        logger.info(`📈 Position: ${position.symbol} @ ${position.entryPrice.toFixed(8)} SOL${priceSourceInfo}${tradingModeInfo}`);
        if (position.stopLossPrice) {
            logger.info(`📉 Stop Loss: ${position.stopLossPrice.toFixed(8)} SOL`);
        }
        if (position.takeProfitLevels?.length > 0) {
            logger.info(`🎯 Take Profits: ${position.takeProfitLevels.map(tp => `${tp.targetPrice.toFixed(8)} SOL`).join(', ')}`);
        }
        
        this.emit('positionAdded', enhancedPosition);
        return enhancedPosition;
    }

    // Update position after sell (handles both live and paper)
    async updatePositionAfterSell(positionId, sellQuantity, soldValue, pnl, txHash, reason = 'Manual') {
        const position = this.positions.get(positionId);
        if (!position) throw new Error(`Position ${positionId} not found`);

        const newRemainingQuantity = parseFloat(position.remainingQuantity) - sellQuantity;

        const updatedPosition = {
            ...position,
            remainingQuantity: newRemainingQuantity.toString(),
            totalPnL: position.totalPnL + pnl,
            updatedAt: Date.now()
        };

        // Close position if fully sold
        if (newRemainingQuantity <= 0.001) {
            updatedPosition.status = 'CLOSED';
            updatedPosition.closedAt = Date.now();
            updatedPosition.closeReason = reason;

            this.closedPositions.set(positionId, updatedPosition);
            this.positions.delete(positionId);

            const priceSourceInfo = position.lastPriceSource ? ` (${position.lastPriceSource})` : '';
            const tradingModeInfo = position.paperTrade ? ' [PAPER]' : ' [LIVE]';
            
            logger.info(`📉 CLOSED: ${position.symbol} - PnL: ${updatedPosition.totalPnL.toFixed(4)} SOL${priceSourceInfo}${tradingModeInfo}`);
            this.emit('positionClosed', updatedPosition);
        } else {
            this.positions.set(positionId, updatedPosition);
            logger.info(`📊 SOLD: ${sellQuantity.toFixed(6)} ${position.symbol} - ${newRemainingQuantity.toFixed(2)} remaining`);
            this.emit('positionUpdated', updatedPosition);
        }

        await this.savePositions();
        return updatedPosition;
    }

    // Get enhanced performance summary
    getPerformanceStats() {
        const activePositions = Array.from(this.positions.values());
        const closedPositions = Array.from(this.closedPositions.values());
        const allPositions = [...activePositions, ...closedPositions];
        
        const totalTrades = allPositions.length;
        const profitableTrades = allPositions.filter(pos => (pos.totalPnL || 0) > 0).length;
        const winRate = totalTrades > 0 ? (profitableTrades / totalTrades * 100).toFixed(1) : '0';
        
        const totalInvested = activePositions.reduce((sum, pos) => {
            const ratio = parseFloat(pos.remainingQuantity) / parseFloat(pos.quantity);
            return sum + (pos.investedAmount * ratio);
        }, 0);
        
        const totalUnrealizedPnL = activePositions.reduce((sum, pos) => sum + (pos.unrealizedPnL || 0), 0);
        const totalRealizedPnL = [...activePositions, ...closedPositions].reduce((sum, pos) => sum + pos.totalPnL, 0);

        // Calculate price source distribution
        const poolBasedPositions = activePositions.filter(pos => pos.lastPriceSource === 'pool_based').length;
        const fallbackPositions = activePositions.filter(pos => pos.lastPriceSource === 'fallback').length;

        return {
            totalPositions: totalTrades,
            activePositions: activePositions.length,
            closedPositions: closedPositions.length,
            winRate: winRate + '%',
            totalInvested: totalInvested.toFixed(4) + ' SOL',
            totalUnrealizedPnL: totalUnrealizedPnL.toFixed(4) + ' SOL',
            totalRealizedPnL: totalRealizedPnL.toFixed(4) + ' SOL',
            
            // Enhanced stats
            priceUpdates: {
                total: this.stats.priceUpdates,
                poolBased: this.stats.poolBasedPriceUpdates,
                fallback: this.stats.fallbackPriceUpdates,
                failures: this.stats.priceUpdateFailures
            },
            
            currentPriceSources: {
                poolBased: poolBasedPositions,
                fallback: fallbackPositions,
                unknown: activePositions.length - poolBasedPositions - fallbackPositions
            },
            
            triggers: {
                stopLossTriggered: this.stats.stopLossTriggered,
                takeProfitTriggered: this.stats.takeProfitTriggered
            },
            
            // 🚀 NEW: Live trading execution stats
            liveTrading: {
                liveSellsExecuted: this.stats.liveSellsExecuted,
                paperSellsExecuted: this.stats.paperSellsExecuted,
                stopLossExecutions: this.stats.stopLossExecutions,
                takeProfitExecutions: this.stats.takeProfitExecutions,
                totalLivePnL: this.stats.totalLivePnL.toFixed(6) + ' SOL'
            }
        };
    }

    // Save/load positions
    async savePositions() {
        try {
            const data = {
                active: Object.fromEntries(this.positions),
                closed: Object.fromEntries(this.closedPositions),
                lastSaved: new Date().toISOString(),
                stats: this.stats,
                priceUpdateStats: this.priceUpdateStats
            };
            
            await fs.writeFile(path.resolve(this.config.positionsFile), JSON.stringify(data, null, 2));
        } catch (error) {
            logger.error('Save positions failed:', error);
        }
    }

    async loadPositions() {
        try {
            const data = await fs.readFile(path.resolve(this.config.positionsFile), 'utf8');
            const savedData = JSON.parse(data);
            
            if (savedData.active) {
                for (const [id, position] of Object.entries(savedData.active)) {
                    this.positions.set(id, position);
                }
            }
            
            if (savedData.closed) {
                for (const [id, position] of Object.entries(savedData.closed)) {
                    this.closedPositions.set(id, position);
                }
            }
            
            if (savedData.stats) {
                this.stats = { ...this.stats, ...savedData.stats };
            }
            
            logger.info(`📊 Loaded ${this.positions.size} active, ${this.closedPositions.size} closed positions`);
            
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error('Load positions failed:', error);
            }
        }
    }

    validatePosition(position) {
        const required = ['id', 'tokenAddress', 'symbol', 'entryPrice', 'quantity', 'investedAmount'];
        for (const field of required) {
            if (!position[field]) throw new Error(`Missing field: ${field}`);
        }
        if (parseFloat(position.quantity) <= 0) throw new Error('Quantity must be > 0');
        if (parseFloat(position.investedAmount) <= 0) throw new Error('Investment must be > 0');
    }

    // Helper methods
    hasPosition(tokenAddress) {
        return Array.from(this.positions.values()).some(pos => pos.tokenAddress === tokenAddress);
    }

    getActivePositions() {
        return Array.from(this.positions.values());
    }

    getActivePositionsCount() {
        return this.positions.size;
    }

    // Get detailed position info with price history
    getPositionDetails(positionId) {
        const position = this.positions.get(positionId) || this.closedPositions.get(positionId);
        
        if (!position) {
            return null;
        }

        return {
            ...position,
            priceHistory: position.priceHistory || [],
            priceSourceDistribution: this.calculatePriceSourceDistribution(position.priceHistory || [])
        };
    }

    // Calculate price source distribution for a position
    calculatePriceSourceDistribution(priceHistory) {
        const sources = priceHistory.reduce((acc, update) => {
            acc[update.source] = (acc[update.source] || 0) + 1;
            return acc;
        }, {});

        const total = priceHistory.length;
        const distribution = {};
        
        for (const [source, count] of Object.entries(sources)) {
            distribution[source] = {
                count: count,
                percentage: total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '0%'
            };
        }

        return distribution;
    }

    // 🚀 NEW: Manual position close (for emergency situations)
    async forceClosePosition(positionId, reason = 'Force Close') {
        const position = this.positions.get(positionId);
        if (!position) throw new Error(`Position ${positionId} not found`);
        
        logger.warn(`⚠️ Force closing position: ${position.symbol} - ${reason}`);
        
        try {
            await this.closePosition(positionId, reason);
            logger.info(`✅ Position ${position.symbol} force closed successfully`);
        } catch (error) {
            logger.error(`❌ Force close failed for ${position.symbol}: ${error.message}`);
            
            // Mark as failed for manual intervention
            position.status = 'FORCE_CLOSE_FAILED';
            position.errorMessage = error.message;
            position.closeReason = reason;
            this.positions.set(positionId, position);
            await this.savePositions();
            
            throw error;
        }
    }

    // 🚀 NEW: Get positions by status
    getPositionsByStatus(status) {
        return Array.from(this.positions.values()).filter(pos => pos.status === status);
    }

    // 🚀 NEW: Get failed positions that need manual intervention
    getFailedPositions() {
        return Array.from(this.positions.values()).filter(pos => 
            pos.status?.includes('FAILED') || 
            pos.takeProfitLevels?.some(tp => tp.status === 'EXECUTION_FAILED')
        );
    }

    // 🚀 NEW: Retry failed take profit executions
    async retryFailedTakeProfits(positionId) {
        const position = this.positions.get(positionId);
        if (!position) throw new Error(`Position ${positionId} not found`);
        
        const failedTPs = position.takeProfitLevels?.filter(tp => tp.status === 'EXECUTION_FAILED') || [];
        
        if (failedTPs.length === 0) {
            logger.info(`No failed take profits to retry for ${position.symbol}`);
            return;
        }
        
        logger.info(`🔄 Retrying ${failedTPs.length} failed take profits for ${position.symbol}...`);
        
        for (const tp of failedTPs) {
            // Reset the failed status
            tp.status = undefined;
            tp.errorMessage = undefined;
            tp.triggered = false; // Allow it to trigger again
        }
        
        // Force a price check to potentially trigger the TPs again
        await this.checkTakeProfitsWithLiveExecution(position);
        
        await this.savePositions();
    }

    // 🚀 NEW: Emergency stop all positions
    async emergencyStopAllPositions(reason = 'Emergency Stop') {
        const activePositions = this.getActivePositions();
        
        if (activePositions.length === 0) {
            logger.info('No active positions to stop');
            return;
        }
        
        logger.warn(`🚨 EMERGENCY STOP: Closing ${activePositions.length} active positions - ${reason}`);
        
        const results = [];
        
        for (const position of activePositions) {
            try {
                await this.forceClosePosition(position.id, reason);
                results.push({ symbol: position.symbol, success: true });
                logger.info(`✅ Emergency closed: ${position.symbol}`);
            } catch (error) {
                results.push({ symbol: position.symbol, success: false, error: error.message });
                logger.error(`❌ Emergency close failed: ${position.symbol} - ${error.message}`);
            }
        }
        
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        
        logger.warn(`🚨 EMERGENCY STOP COMPLETE: ${successful} closed, ${failed} failed`);
        
        return results;
    }

    // 🚀 NEW: Get real-time position summary
    getRealTimePositionSummary() {
        const activePositions = this.getActivePositions();
        
        if (activePositions.length === 0) {
            return {
                totalPositions: 0,
                totalInvested: 0,
                totalCurrentValue: 0,
                totalUnrealizedPnL: 0,
                positions: []
            };
        }
        
        const summary = {
            totalPositions: activePositions.length,
            totalInvested: 0,
            totalCurrentValue: 0,
            totalUnrealizedPnL: 0,
            positions: []
        };
        
        for (const pos of activePositions) {
            const currentPrice = pos.currentPrice || pos.entryPrice;
            const remainingTokens = parseFloat(pos.remainingQuantity);
            const currentValue = remainingTokens * currentPrice;
            const investedValue = (remainingTokens / parseFloat(pos.quantity)) * pos.investedAmount;
            const unrealizedPnL = currentValue - investedValue;
            const priceChange = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
            
            summary.totalInvested += investedValue;
            summary.totalCurrentValue += currentValue;
            summary.totalUnrealizedPnL += unrealizedPnL;
            
            summary.positions.push({
                symbol: pos.symbol,
                entryPrice: pos.entryPrice,
                currentPrice: currentPrice,
                priceChange: priceChange,
                remainingTokens: remainingTokens,
                investedValue: investedValue,
                currentValue: currentValue,
                unrealizedPnL: unrealizedPnL,
                stopLossDistance: pos.stopLossPrice ? ((currentPrice - pos.stopLossPrice) / currentPrice * 100) : null,
                nextTakeProfitDistance: pos.takeProfitLevels ? 
                    this.getNextTakeProfitDistance(pos, currentPrice) : null,
                status: pos.status,
                tradingMode: pos.paperTrade ? 'paper' : 'live'
            });
        }
        
        return summary;
    }
    
    // Helper for next take profit distance
    getNextTakeProfitDistance(position, currentPrice) {
        const nextTP = position.takeProfitLevels?.find(tp => !tp.triggered && tp.targetPrice > currentPrice);
        if (!nextTP) return null;
        
        return ((nextTP.targetPrice - currentPrice) / currentPrice * 100);
    }
}

module.exports = PositionManager;