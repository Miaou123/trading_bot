// src/bot/positionManager.js - UPDATED: Clean separation of active positions and trade history
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
            tradesHistoryFile: config.tradesHistoryFile || './trades_history.json',
            maxPositions: config.maxPositions || 20,
            fastUpdateInterval: config.fastUpdateInterval || 1000,
            slowUpdateInterval: config.slowUpdateInterval || 60000,
            ...config
        };

        // Only active positions - NO closed positions here
        this.positions = new Map();
        
        // Trade history is handled separately
        this.tradingBot = null;
        
        // Track price source performance
        this.priceUpdateStats = {
            poolBased: { attempts: 0, successes: 0, totalTime: 0 },
            fallback: { attempts: 0, successes: 0, totalTime: 0 },
            lastUpdate: Date.now()
        };
        
        // Session stats (reset when bot restarts)
        this.sessionStats = {
            stopLossTriggered: 0,
            takeProfitTriggered: 0,
            priceUpdates: 0,
            poolBasedPriceUpdates: 0,
            fallbackPriceUpdates: 0,
            priceUpdateFailures: 0,
            liveSellsExecuted: 0,
            paperSellsExecuted: 0,
            stopLossExecutions: 0,
            takeProfitExecutions: 0,
            sessionPnL: 0
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
                logger.debug(`🔄 Starting fast price update cycle for ${this.positions.size} positions`);
                await this.updateAllPositionsFast();
            }
        }, this.config.fastUpdateInterval);
        
        // Slower fallback updates (1 minute)
        setInterval(async () => {
            if (this.positions.size > 0 && this.tradingBot) {
                logger.debug(`🔄 Starting fallback price update cycle for ${this.positions.size} positions`);
                await this.updateAllPositionsSlow();
            }
        }, this.config.slowUpdateInterval);
        
        logger.info(`📊 Enhanced price monitoring started:`);
        logger.info(`   🔧 Pool-based: ${this.config.fastUpdateInterval}ms intervals`);
        logger.info(`   🪐 Fallback: ${this.config.slowUpdateInterval}ms intervals`);
    }

    // Enhanced price stats logging with position monitoring
    startPriceStatsLogging() {
        setInterval(() => {
            const poolBased = this.priceUpdateStats.poolBased;
            const fallback = this.priceUpdateStats.fallback;
            
            // Show current positions and prices in one compact line
            if (this.positions.size > 0) {
                const positionSummaries = Array.from(this.positions.values()).map(pos => {
                    const currentPrice = pos.currentPrice || pos.entryPrice;
                    const priceChange = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100);
                    const changeIcon = priceChange > 0 ? '↗' : priceChange < 0 ? '↘' : '→';
                    const source = pos.lastPriceSource === 'pool_based' ? 'P' : 
                                  pos.lastPriceSource === 'fallback' ? 'F' : 'U';
                    
                    return `${pos.symbol || pos.tokenAddress.slice(0,8)}:${currentPrice.toFixed(8)}${changeIcon}${priceChange.toFixed(1)}%[${source}]`;
                });
                
                logger.info(`📊 ACTIVE POSITIONS: ${positionSummaries.join(' | ')}`);
            }
            
            // Show detailed stats if there were price updates
            if (poolBased.attempts > 0 || fallback.attempts > 0) {
                const poolSuccess = poolBased.attempts > 0 ? ((poolBased.successes / poolBased.attempts) * 100).toFixed(1) : '0';
                const fallbackSuccess = fallback.attempts > 0 ? ((fallback.successes / fallback.attempts) * 100).toFixed(1) : '0';
                const poolAvg = poolBased.successes > 0 ? (poolBased.totalTime / poolBased.successes).toFixed(0) : 'N/A';
                const fallbackAvg = fallback.successes > 0 ? (fallback.totalTime / fallback.successes).toFixed(0) : 'N/A';
                
                logger.info('📊 PRICE UPDATE STATS:');
                logger.info(`   🔧 Pool-based: ${poolBased.successes}/${poolBased.attempts} (${poolSuccess}%) avg: ${poolAvg}ms`);
                logger.info(`   🪐 Fallback: ${fallback.successes}/${fallback.attempts} (${fallbackSuccess}%) avg: ${fallbackAvg}ms`);
                
                if (this.sessionStats.liveSellsExecuted > 0 || this.sessionStats.paperSellsExecuted > 0) {
                    logger.info('💰 SESSION TRADING STATS:');
                    logger.info(`   🚀 Live sells: ${this.sessionStats.liveSellsExecuted}`);
                    logger.info(`   📝 Paper sells: ${this.sessionStats.paperSellsExecuted}`);
                    logger.info(`   🛑 Stop losses: ${this.sessionStats.stopLossExecutions}`);
                    logger.info(`   🎯 Take profits: ${this.sessionStats.takeProfitExecutions}`);
                    logger.info(`   💎 Session PnL: ${this.sessionStats.sessionPnL.toFixed(6)} SOL`);
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
                logger.debug(`🔧 Fast update for ${position.symbol} (${position.tokenAddress.slice(0,8)})`);
                
                const currentPrice = await this.getPositionPricePoolBased(position);
                
                if (currentPrice && currentPrice !== position.currentPrice) {
                    logger.debug(`✅ Price update successful for ${position.symbol}: ${position.currentPrice} → ${currentPrice}`);
                    await this.updatePositionPrice(position, currentPrice, 'pool_based');
                    
                    // Check triggers after price update with live execution
                    await this.checkStopLossWithLiveExecution(position);
                    await this.checkTakeProfitsWithLiveExecution(position);
                } else if (currentPrice === position.currentPrice) {
                    logger.debug(`📊 Price unchanged for ${position.symbol}: ${currentPrice}`);
                } else {
                    logger.debug(`❌ No price returned for ${position.symbol}`);
                }
                
            } catch (error) {
                logger.debug(`❌ Fast price update failed for ${position.symbol}: ${error.message}`);
            }
        }
    }

    // SLOW: Update all positions using fallback method
    async updateAllPositionsSlow() {
        for (const position of this.positions.values()) {
            try {
                const timeSinceLastUpdate = Date.now() - (position.lastPriceUpdate || 0);
                
                if (timeSinceLastUpdate > 30000) { // If no update in 30 seconds
                    logger.debug(`📡 Using fallback for ${position.symbol} (no recent pool-based update - ${Math.round(timeSinceLastUpdate/1000)}s ago)`);
                    
                    const currentPrice = await this.getPositionPriceFallback(position);
                    
                    if (currentPrice && currentPrice !== position.currentPrice) {
                        logger.debug(`✅ Fallback price update successful for ${position.symbol}: ${position.currentPrice} → ${currentPrice}`);
                        await this.updatePositionPrice(position, currentPrice, 'fallback');
                        
                        await this.checkStopLossWithLiveExecution(position);
                        await this.checkTakeProfitsWithLiveExecution(position);
                    }
                } else {
                    logger.debug(`⏭️ Skipping fallback for ${position.symbol} (recent update ${Math.round(timeSinceLastUpdate/1000)}s ago)`);
                }
                
            } catch (error) {
                logger.debug(`❌ Fallback price update failed for ${position.symbol}: ${error.message}`);
            }
        }
    }

    // Get position price using pool-based method
    async getPositionPricePoolBased(position) {
        const startTime = Date.now();
        this.priceUpdateStats.poolBased.attempts++;
        
        try {
            const tokenAddress = position.tokenAddress;
            const poolAddress = position.poolAddress || position.migrationPool;
            
            if (!this.tradingBot) {
                throw new Error('TradingBot not available');
            }
            
            const priceInfo = await this.tradingBot.getTokenPrice(
                tokenAddress, 
                true,
                poolAddress
            );
            
            let price;
            if (typeof priceInfo === 'object' && priceInfo.price) {
                price = priceInfo.price;
            } else if (typeof priceInfo === 'number') {
                price = priceInfo;
            } else {
                throw new Error(`Invalid price format returned: ${typeof priceInfo}`);
            }
            
            if (price && price > 0) {
                const duration = Date.now() - startTime;
                this.priceUpdateStats.poolBased.successes++;
                this.priceUpdateStats.poolBased.totalTime += duration;
                this.sessionStats.poolBasedPriceUpdates++;
                
                logger.debug(`✅ Pool-based price for ${position.symbol}: ${price.toFixed(12)} SOL (${duration}ms)`);
                return price;
            } else {
                throw new Error(`Invalid price value: ${price}`);
            }
            
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.debug(`❌ Pool-based price failed for ${position.symbol} (${duration}ms): ${error.message}`);
            return null;
        }
    }

    // Get position price using fallback method
    async getPositionPriceFallback(position) {
        const startTime = Date.now();
        this.priceUpdateStats.fallback.attempts++;
        
        try {
            if (!position.poolAddress && this.tradingBot.derivePoolAddress) {
                const derivedPool = this.tradingBot.derivePoolAddress(position.tokenAddress);
                if (derivedPool) {
                    position.poolAddress = derivedPool;
                    logger.debug(`   📍 Derived pool for ${position.symbol}: ${derivedPool}`);
                }
            }
            
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
                throw new Error(`Invalid fallback price format: ${typeof priceInfo}`);
            }
            
            if (price && price > 0) {
                const duration = Date.now() - startTime;
                this.priceUpdateStats.fallback.successes++;
                this.priceUpdateStats.fallback.totalTime += duration;
                this.sessionStats.fallbackPriceUpdates++;
                
                logger.debug(`✅ Fallback price for ${position.symbol}: ${price.toFixed(12)} SOL (${duration}ms)`);
                return price;
            } else {
                throw new Error(`Invalid fallback price value: ${price}`);
            }
            
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.debug(`❌ Fallback price failed for ${position.symbol} (${duration}ms): ${error.message}`);
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
        this.sessionStats.priceUpdates++;
        
        logger.debug(`${position.symbol}: ${newPrice.toFixed(8)} SOL (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%) via ${source}`);
    }

    // Check stop loss with LIVE execution
    async checkStopLossWithLiveExecution(position) {
        if (!position.stopLossPrice || !position.currentPrice) return;
        
        if (position.currentPrice <= position.stopLossPrice) {
            const lossPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice * 100);
            
            logger.warn(`🛑 STOP LOSS TRIGGERED: ${position.symbol} at ${position.currentPrice.toFixed(8)} SOL (${lossPercent.toFixed(1)}%)`);
            
            try {
                if (this.tradingBot.config.tradingMode === 'live') {
                    const sellResult = await this.tradingBot.executePumpSwapSell(
                        position, 
                        100,
                        `Stop Loss (${lossPercent.toFixed(1)}%)`
                    );
                    
                    if (sellResult.success) {
                        logger.info(`✅ LIVE STOP LOSS EXECUTED: ${sellResult.solReceived.toFixed(6)} SOL received`);
                        this.sessionStats.liveSellsExecuted++;
                        this.sessionStats.stopLossExecutions++;
                        this.sessionStats.sessionPnL += sellResult.pnl;
                    }
                } else {
                    await this.simulatePartialSell(position, 100, `Stop Loss (${lossPercent.toFixed(1)}%)`);
                    this.sessionStats.paperSellsExecuted++;
                    this.sessionStats.stopLossExecutions++;
                }
                
                this.sessionStats.stopLossTriggered++;
                
                this.emit('stopLossTriggered', {
                    position: position,
                    triggerPrice: position.currentPrice,
                    lossPercentage: Math.abs(lossPercent),
                    priceSource: position.lastPriceSource,
                    executionMode: this.tradingBot.config.tradingMode
                });
                
            } catch (error) {
                logger.error(`❌ Stop loss execution failed for ${position.symbol}: ${error.message}`);
                position.status = 'STOP_LOSS_FAILED';
                position.errorMessage = error.message;
            }
        }
    }

    // Check take profits with LIVE execution
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
                        const sellResult = await this.tradingBot.executePumpSwapSell(
                            position, 
                            tp.sellPercentage,
                            `Take Profit ${tp.level} (+${gainPercent.toFixed(1)}%)`
                        );
                        
                        if (sellResult.success) {
                            logger.info(`✅ LIVE TAKE PROFIT ${tp.level} EXECUTED: ${sellResult.solReceived.toFixed(6)} SOL received`);
                            this.sessionStats.liveSellsExecuted++;
                            this.sessionStats.takeProfitExecutions++;
                            this.sessionStats.sessionPnL += sellResult.pnl;
                        }
                    } else {
                        await this.simulatePartialSell(position, tp.sellPercentage, `Take Profit ${tp.level} (+${gainPercent.toFixed(1)}%)`);
                        this.sessionStats.paperSellsExecuted++;
                        this.sessionStats.takeProfitExecutions++;
                    }
                    
                    this.sessionStats.takeProfitTriggered++;
                    
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
                    tp.triggered = false;
                    tp.status = 'EXECUTION_FAILED';
                    tp.errorMessage = error.message;
                }
            }
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
        
        logger.info(`📈 Position created: ${position.symbol}`);
        logger.debug(`   Position details: ${JSON.stringify({
            tokenAddress: position.tokenAddress,
            poolAddress: position.poolAddress,
            migrationPool: position.migrationPool,
            priceSource: position.priceSource,
            eventType: position.eventType,
            isMigration: position.isMigration
        }, null, 2)}`);
        
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

    // 🔥 NEW: Update position after sell - handles moving to trade history
    async updatePositionAfterSell(positionId, sellQuantity, soldValue, pnl, txHash, reason = 'Manual') {
        const position = this.positions.get(positionId);
        if (!position) throw new Error(`Position ${positionId} not found`);

        const newRemainingQuantity = parseFloat(position.remainingQuantity) - sellQuantity;

        const updatedPosition = {
            ...position,
            remainingQuantity: newRemainingQuantity.toString(),
            updatedAt: Date.now()
        };

        // If position is fully closed, move to trade history
        if (newRemainingQuantity <= 0.001) {
            updatedPosition.status = 'CLOSED';
            updatedPosition.closedAt = Date.now();
            updatedPosition.closeReason = reason;
            updatedPosition.finalPnL = pnl;
            updatedPosition.exitTxHash = txHash;

            // 🔥 MOVE TO TRADE HISTORY instead of keeping in positions
            await this.movePositionToHistory(updatedPosition);
            
            // Remove from active positions
            this.positions.delete(positionId);

            const priceSourceInfo = position.lastPriceSource ? ` (${position.lastPriceSource})` : '';
            const tradingModeInfo = position.paperTrade ? ' [PAPER]' : ' [LIVE]';
            
            logger.info(`📉 CLOSED: ${position.symbol} - PnL: ${pnl.toFixed(4)} SOL${priceSourceInfo}${tradingModeInfo}`);
            this.emit('positionClosed', updatedPosition);
        } else {
            // Partial sell - keep in active positions
            this.positions.set(positionId, updatedPosition);
            logger.info(`📊 SOLD: ${sellQuantity.toFixed(6)} ${position.symbol} - ${newRemainingQuantity.toFixed(2)} remaining`);
            this.emit('positionUpdated', updatedPosition);
        }

        await this.savePositions();
        return updatedPosition;
    }

    // 🔥 NEW: Move completed position to trade history
    async movePositionToHistory(closedPosition) {
        try {
            // Create simplified trade record
            const trade = {
                id: closedPosition.id,
                tokenAddress: closedPosition.tokenAddress,
                symbol: closedPosition.symbol,
                entryTime: closedPosition.entryTime,
                exitTime: closedPosition.closedAt,
                entryPrice: closedPosition.entryPrice,
                exitPrice: closedPosition.currentPrice || closedPosition.entryPrice,
                quantity: closedPosition.quantity,
                investedAmount: closedPosition.investedAmount,
                pnl: closedPosition.finalPnL,
                pnlPercentage: ((closedPosition.finalPnL / closedPosition.investedAmount) * 100),
                exitReason: closedPosition.closeReason,
                duration: closedPosition.closedAt - closedPosition.entryTime,
                tradingMode: closedPosition.paperTrade ? 'paper' : 'live',
                entryTxHash: closedPosition.txHash,
                exitTxHash: closedPosition.exitTxHash,
                eventType: closedPosition.eventType,
                twitterLikes: closedPosition.alert?.twitter?.likes,
                priceSource: closedPosition.lastPriceSource
            };

            // Load existing trade history
            let tradesHistory;
            try {
                const historyPath = path.resolve(this.config.tradesHistoryFile);
                const data = await fs.readFile(historyPath, 'utf8');
                tradesHistory = JSON.parse(data);
            } catch (error) {
                // Create new history file if it doesn't exist
                tradesHistory = {
                    trades: [],
                    summary: {
                        totalTrades: 0,
                        totalPnL: 0,
                        winRate: 0,
                        lastUpdated: new Date().toISOString()
                    }
                };
            }

            // Add trade to history
            tradesHistory.trades.push(trade);
            
            // Update summary
            tradesHistory.summary.totalTrades = tradesHistory.trades.length;
            tradesHistory.summary.totalPnL = tradesHistory.trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
            const profitableTrades = tradesHistory.trades.filter(t => (t.pnl || 0) > 0).length;
            tradesHistory.summary.winRate = tradesHistory.trades.length > 0 ? 
                (profitableTrades / tradesHistory.trades.length * 100) : 0;
            tradesHistory.summary.lastUpdated = new Date().toISOString();

            // Save trade history
            const historyPath = path.resolve(this.config.tradesHistoryFile);
            await fs.writeFile(historyPath, JSON.stringify(tradesHistory, null, 2));
            
            logger.info(`💾 Trade moved to history: ${closedPosition.symbol} (${tradesHistory.trades.length} total trades)`);
            
        } catch (error) {
            logger.error('❌ Failed to move position to trade history:', error.message);
            // Don't throw - we don't want to break position closing if history fails
        }
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
            try {
                const sellResult = await this.tradingBot.executePumpSwapSell(position, 100, reason);
                if (sellResult.success) {
                    logger.info(`✅ LIVE POSITION CLOSED: ${position.symbol} - ${sellResult.solReceived.toFixed(6)} SOL received`);
                    this.sessionStats.liveSellsExecuted++;
                    this.sessionStats.sessionPnL += sellResult.pnl;
                }
            } catch (error) {
                logger.error(`❌ Live position close failed for ${position.symbol}: ${error.message}`);
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

    // Get enhanced performance summary
    getPerformanceStats() {
        const activePositions = Array.from(this.positions.values());
        
        const totalInvested = activePositions.reduce((sum, pos) => {
            const ratio = parseFloat(pos.remainingQuantity) / parseFloat(pos.quantity);
            return sum + (pos.investedAmount * ratio);
        }, 0);
        
        const totalUnrealizedPnL = activePositions.reduce((sum, pos) => sum + (pos.unrealizedPnL || 0), 0);

        // Calculate price source distribution
        const poolBasedPositions = activePositions.filter(pos => pos.lastPriceSource === 'pool_based').length;
        const fallbackPositions = activePositions.filter(pos => pos.lastPriceSource === 'fallback').length;

        return {
            activePositions: activePositions.length,
            totalInvested: totalInvested.toFixed(4) + ' SOL',
            totalUnrealizedPnL: totalUnrealizedPnL.toFixed(4) + ' SOL',
            
            // Session stats only
            sessionStats: {
                priceUpdates: this.sessionStats.priceUpdates,
                poolBasedUpdates: this.sessionStats.poolBasedPriceUpdates,
                fallbackUpdates: this.sessionStats.fallbackPriceUpdates,
                failures: this.sessionStats.priceUpdateFailures,
                stopLossTriggered: this.sessionStats.stopLossTriggered,
                takeProfitTriggered: this.sessionStats.takeProfitTriggered,
                liveSells: this.sessionStats.liveSellsExecuted,
                paperSells: this.sessionStats.paperSellsExecuted,
                sessionPnL: this.sessionStats.sessionPnL.toFixed(6) + ' SOL'
            },
            
            currentPriceSources: {
                poolBased: poolBasedPositions,
                fallback: fallbackPositions,
                unknown: activePositions.length - poolBasedPositions - fallbackPositions
            }
        };
    }

    // 🔥 UPDATED: Save only active positions (no closed positions)
    async savePositions() {
        try {
            const data = {
                active: Object.fromEntries(this.positions),
                sessionStats: this.sessionStats,
                priceUpdateStats: this.priceUpdateStats,
                lastSaved: new Date().toISOString()
            };
            
            await fs.writeFile(path.resolve(this.config.positionsFile), JSON.stringify(data, null, 2));
        } catch (error) {
            logger.error('Save positions failed:', error);
        }
    }

    // 🔥 UPDATED: Load only active positions
    async loadPositions() {
        try {
            const data = await fs.readFile(path.resolve(this.config.positionsFile), 'utf8');
            const savedData = JSON.parse(data);
            
            if (savedData.active) {
                for (const [id, position] of Object.entries(savedData.active)) {
                    this.positions.set(id, position);
                }
            }
            
            if (savedData.sessionStats) {
                this.sessionStats = { ...this.sessionStats, ...savedData.sessionStats };
            }
            
            logger.info(`📊 Loaded ${this.positions.size} active positions`);
            
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
        const position = this.positions.get(positionId);
        
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

    // Manual position close (for emergency situations)
    async forceClosePosition(positionId, reason = 'Force Close') {
        const position = this.positions.get(positionId);
        if (!position) throw new Error(`Position ${positionId} not found`);
        
        logger.warn(`⚠️ Force closing position: ${position.symbol} - ${reason}`);
        
        try {
            await this.closePosition(positionId, reason);
            logger.info(`✅ Position ${position.symbol} force closed successfully`);
        } catch (error) {
            logger.error(`❌ Force close failed for ${position.symbol}: ${error.message}`);
            
            position.status = 'FORCE_CLOSE_FAILED';
            position.errorMessage = error.message;
            position.closeReason = reason;
            this.positions.set(positionId, position);
            await this.savePositions();
            
            throw error;
        }
    }

    // Get positions by status
    getPositionsByStatus(status) {
        return Array.from(this.positions.values()).filter(pos => pos.status === status);
    }

    // Get failed positions that need manual intervention
    getFailedPositions() {
        return Array.from(this.positions.values()).filter(pos => 
            pos.status?.includes('FAILED') || 
            pos.takeProfitLevels?.some(tp => tp.status === 'EXECUTION_FAILED')
        );
    }

    // Emergency stop all positions
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

    // Get real-time position summary
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