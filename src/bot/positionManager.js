// src/bot/positionManager.js - Enhanced with precise price updates
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const Big = require('big.js');

class PositionManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            tradingMode: config.tradingMode || 'paper',
            positionsFile: config.positionsFile || './positions.json',
            maxPositions: config.maxPositions || 20,
            priceUpdateInterval: config.priceUpdateInterval || 30000, // 30 seconds
            ...config
        };

        this.positions = new Map(); // Active positions
        this.closedPositions = new Map(); // Historical positions
        this.riskManager = config.riskManager;
        this.tradingBot = config.tradingBot; // 🔥 NEW: Reference to trading bot for price fetching
        
        // Price update tracking
        this.lastPriceUpdateTime = 0;
        this.priceUpdateStats = {
            successful: 0,
            failed: 0,
            avgUpdateTime: 0
        };
        
        this.loadPositions();
    }

    // 🔥 NEW: Set trading bot reference for price fetching
    setTradingBot(tradingBot) {
        this.tradingBot = tradingBot;
        logger.info('📊 Trading bot reference set for precise price updates');
    }

    async loadPositions() {
        try {
            const positionsPath = path.resolve(this.config.positionsFile);
            const data = await fs.readFile(positionsPath, 'utf8');
            const savedData = JSON.parse(data);
            
            // Load active positions
            if (savedData.active) {
                for (const [id, position] of Object.entries(savedData.active)) {
                    this.positions.set(id, position);
                }
            }
            
            // Load closed positions
            if (savedData.closed) {
                for (const [id, position] of Object.entries(savedData.closed)) {
                    this.closedPositions.set(id, position);
                }
            }
            
            logger.info(`📊 Loaded ${this.positions.size} active positions and ${this.closedPositions.size} closed positions`);
            
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error('Error loading positions:', error);
            } else {
                logger.info('📊 No existing positions file found, starting fresh');
            }
        }
    }

    async savePositions() {
        try {
            const data = {
                active: Object.fromEntries(this.positions),
                closed: Object.fromEntries(this.closedPositions),
                lastSaved: new Date().toISOString(),
                priceUpdateStats: this.priceUpdateStats
            };
            
            const positionsPath = path.resolve(this.config.positionsFile);
            await fs.writeFile(positionsPath, JSON.stringify(data, null, 2));
            
            logger.debug('💾 Positions saved to disk');
            
        } catch (error) {
            logger.error('Error saving positions:', error);
        }
    }

    async addPosition(position) {
        try {
            // Validate position data
            this.validatePosition(position);
            
            // Check position limits
            if (this.positions.size >= this.config.maxPositions) {
                throw new Error(`Maximum positions limit reached (${this.config.maxPositions})`);
            }
            
            // Add position with enhanced tracking
            this.positions.set(position.id, {
                ...position,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                status: 'ACTIVE',
                totalPnL: 0,
                sellOrders: [],
                // 🔥 NEW: Price tracking fields
                currentPrice: position.entryPrice,
                currentValue: position.investedAmount,
                unrealizedPnL: 0,
                totalCurrentPnL: 0,
                lastPriceUpdate: Date.now(),
                priceHistory: [{
                    timestamp: Date.now(),
                    price: position.entryPrice,
                    source: 'entry'
                }]
            });
            
            // Save to disk
            await this.savePositions();
            
            logger.info(`📈 Position added: ${position.symbol} (${position.id}) @ ${position.entryPrice.toFixed(8)} SOL`);
            
            this.emit('positionAdded', position);
            
            return position;
            
        } catch (error) {
            logger.error(`Error adding position for ${position.symbol}:`, error);
            throw error;
        }
    }

    // 🔥 ENHANCED: Update all positions with precise prices
    async updateAllPositions() {
        try {
            if (this.positions.size === 0) return;
            
            const updateStart = Date.now();
            logger.debug(`🔄 Updating ${this.positions.size} positions with precise prices...`);
            
            const updatePromises = Array.from(this.positions.values()).map(position => 
                this.updateSinglePositionWithPrecisePrice(position)
            );
            
            const results = await Promise.allSettled(updatePromises);
            
            const successful = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.filter(r => r.status === 'rejected').length;
            
            // Update statistics
            this.priceUpdateStats.successful += successful;
            this.priceUpdateStats.failed += failed;
            
            const updateTime = Date.now() - updateStart;
            this.priceUpdateStats.avgUpdateTime = this.priceUpdateStats.avgUpdateTime > 0 ?
                (this.priceUpdateStats.avgUpdateTime + updateTime) / 2 : updateTime;
            
            this.lastPriceUpdateTime = Date.now();
            
            if (failed > 0) {
                logger.warn(`⚠️ Position updates: ${successful} successful, ${failed} failed (${updateTime}ms)`);
            } else {
                logger.debug(`✅ All ${successful} positions updated successfully (${updateTime}ms)`);
            }
            
        } catch (error) {
            logger.error('Error updating positions:', error);
            this.priceUpdateStats.failed++;
        }
    }

    // 🔥 NEW: Update single position with adaptive priority pricing
    async updateSinglePositionWithPrecisePrice(position) {
        try {
            const updateStart = Date.now();
            
            // Determine update priority based on position risk
            const priority = this.calculateUpdatePriority(position);
            
            // Get current price from trading bot with priority
            let currentPrice = null;
            if (this.tradingBot && this.tradingBot.getTokenPrice) {
                currentPrice = await this.tradingBot.getTokenPrice(
                    position.tokenAddress, 
                    true, // use cache
                    priority // priority level
                );
            }
            
            // Fallback to mock price for paper trading
            if (!currentPrice) {
                currentPrice = await this.getMockPrice(position);
            }
            
            if (!currentPrice) {
                logger.debug(`⏭️ No price data for ${position.symbol}, skipping update`);
                return;
            }
            
            // Calculate values with precise price
            const remainingTokens = parseFloat(position.remainingQuantity);
            const currentValue = remainingTokens * currentPrice;
            const investedValue = (remainingTokens / parseFloat(position.quantity)) * position.investedAmount;
            const unrealizedPnL = currentValue - investedValue;
            const totalPnL = position.totalPnL + unrealizedPnL;
            
            // Calculate percentage changes
            const priceChange = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
            const valueChange = ((currentValue - investedValue) / investedValue) * 100;
            
            // Update position with current data
            const updatedPosition = {
                ...position,
                currentPrice: currentPrice,
                currentValue: currentValue,
                unrealizedPnL: unrealizedPnL,
                totalCurrentPnL: totalPnL,
                lastPriceUpdate: Date.now(),
                priceChange: priceChange,
                valueChange: valueChange,
                updatedAt: Date.now()
            };
            
            // Add to price history (keep last 100 entries)
            if (!updatedPosition.priceHistory) {
                updatedPosition.priceHistory = [];
            }
            
            updatedPosition.priceHistory.push({
                timestamp: Date.now(),
                price: currentPrice,
                source: 'update',
                pnl: unrealizedPnL
            });
            
            // Keep only last 100 price points
            if (updatedPosition.priceHistory.length > 100) {
                updatedPosition.priceHistory = updatedPosition.priceHistory.slice(-100);
            }

            this.positions.set(position.id, updatedPosition);

            const updateTime = Date.now() - updateStart;
            logger.debug(`💰 ${position.symbol}: ${currentPrice.toFixed(8)} SOL (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%) - PnL: ${unrealizedPnL.toFixed(4)} SOL (${updateTime}ms)`);

            // Check for stop loss trigger
            await this.checkStopLoss(updatedPosition);
            
            // Check for take profit triggers
            await this.checkTakeProfits(updatedPosition);
            
        } catch (error) {
            logger.error(`Error updating position ${position.symbol}:`, error);
            throw error;
        }
    }

    // 🔥 NEW: Calculate update priority based on position risk
    calculateUpdatePriority(position) {
        try {
            if (!position.currentPrice || !position.stopLoss) {
                return 'high'; // New position needs frequent updates
            }
            
            const currentPrice = position.currentPrice;
            const stopLoss = position.stopLoss;
            
            // Calculate distance to stop loss
            const stopLossDistance = Math.abs(currentPrice - stopLoss) / currentPrice;
            
            // Calculate distance to next take profit
            let takeProfitDistance = 1;
            if (position.takeProfitLevels) {
                const nextLevel = position.takeProfitLevels.find(level => !level.triggered);
                if (nextLevel) {
                    const targetPrice = nextLevel.targetValue / parseFloat(position.remainingQuantity);
                    takeProfitDistance = Math.abs(currentPrice - targetPrice) / currentPrice;
                }
            }
            
            const minDistance = Math.min(stopLossDistance, takeProfitDistance);
            
            // Determine priority
            if (minDistance < 0.01) return 'critical';  // Within 1% = critical
            if (minDistance < 0.03) return 'high';      // Within 3% = high  
            if (minDistance < 0.05) return 'normal';    // Within 5% = normal
            return 'low';                               // Safe distance = low
            
        } catch (error) {
            return 'normal'; // Default to normal on error
        }
    }

    // 🔥 NEW: Mock price for paper trading with realistic movement
    async getMockPrice(position) {
        try {
            if (!position.priceHistory || position.priceHistory.length === 0) {
                return position.entryPrice;
            }
            
            // Get last price
            const lastPrice = position.priceHistory[position.priceHistory.length - 1].price;
            
            // Simulate realistic price movement
            const volatility = 0.05; // 5% max movement per update
            const randomChange = (Math.random() - 0.5) * 2 * volatility; // -5% to +5%
            
            // Add some trend bias based on time held
            const holdTime = Date.now() - position.entryTime;
            const holdDays = holdTime / (1000 * 60 * 60 * 24);
            
            // Slight upward bias for tokens held longer (simulating growing projects)
            const trendBias = Math.min(holdDays * 0.01, 0.02); // Up to 2% daily bias
            
            const newPrice = lastPrice * (1 + randomChange + trendBias);
            
            // Don't let price go below 10% of entry price or above 1000% of entry price
            const minPrice = position.entryPrice * 0.1;
            const maxPrice = position.entryPrice * 10;
            
            return Math.max(minPrice, Math.min(maxPrice, newPrice));
            
        } catch (error) {
            logger.debug(`Error generating mock price for ${position.symbol}:`, error);
            return position.entryPrice;
        }
    }

    // 🔥 ENHANCED: Stop loss check with precise price
    async checkStopLoss(position) {
        try {
            const stopLossValue = position.stopLoss;
            
            if (position.currentValue <= stopLossValue) {
                logger.warn(`🚨 Stop loss triggered for ${position.symbol}: ${position.currentValue.toFixed(4)} SOL <= ${stopLossValue.toFixed(4)} SOL (${position.priceChange.toFixed(2)}% change)`);
                
                // Execute emergency sell
                await this.executeEmergencySell(position, 'STOP_LOSS');
            }
        } catch (error) {
            logger.error(`Error checking stop loss for ${position.symbol}:`, error);
        }
    }

    // 🔥 ENHANCED: Take profit check with precise price
    async checkTakeProfits(position) {
        try {
            for (let i = 0; i < position.takeProfitLevels.length; i++) {
                const level = position.takeProfitLevels[i];
                
                if (!level.triggered && position.currentValue >= level.targetValue) {
                    const profitPercentage = ((position.currentValue - position.investedAmount) / position.investedAmount * 100).toFixed(2);
                    
                    logger.info(`🎯 Take profit ${i + 1} triggered for ${position.symbol}: ${position.currentValue.toFixed(4)} SOL >= ${level.targetValue.toFixed(4)} SOL (+${profitPercentage}% profit)`);
                    
                    // Calculate sell quantity
                    const sellPercentage = level.sellPercentage / 100;
                    const sellQuantity = new Big(position.remainingQuantity).times(sellPercentage);
                    
                    // Execute partial sell
                    await this.executePartialSell(position, sellQuantity.toString(), `TAKE_PROFIT_${i + 1}`);
                    
                    // Mark level as triggered
                    position.takeProfitLevels[i].triggered = true;
                    position.takeProfitLevels[i].triggeredAt = Date.now();
                    position.takeProfitLevels[i].triggeredPrice = position.currentPrice;
                    this.positions.set(position.id, position);
                }
            }
        } catch (error) {
            logger.error(`Error checking take profits for ${position.symbol}:`, error);
        }
    }

    async updatePositionAfterSell(positionId, sellQuantity, soldValue, pnl, txHash, reason = 'Manual') {
        try {
            const position = this.positions.get(positionId);
            if (!position) {
                throw new Error(`Position ${positionId} not found`);
            }

            const sellAmount = new Big(sellQuantity);
            const remainingQuantity = new Big(position.remainingQuantity).minus(sellAmount);
            
            // Record the sell order with enhanced data
            const sellOrder = {
                timestamp: Date.now(),
                quantity: sellQuantity,
                value: soldValue,
                pnl: pnl,
                txHash: txHash,
                reason: reason,
                priceAtSale: position.currentPrice,
                priceChange: position.priceChange
            };
            
            // Update position
            const updatedPosition = {
                ...position,
                remainingQuantity: remainingQuantity.toString(),
                totalPnL: position.totalPnL + pnl,
                updatedAt: Date.now(),
                sellOrders: [...position.sellOrders, sellOrder]
            };
            
            // Recalculate current values for remaining position
            if (remainingQuantity.gt(0)) {
                const remainingTokens = parseFloat(remainingQuantity.toString());
                const newCurrentValue = remainingTokens * position.currentPrice;
                const newInvestedValue = (remainingTokens / parseFloat(position.quantity)) * position.investedAmount;
                const newUnrealizedPnL = newCurrentValue - newInvestedValue;
                
                updatedPosition.currentValue = newCurrentValue;
                updatedPosition.unrealizedPnL = newUnrealizedPnL;
                updatedPosition.totalCurrentPnL = updatedPosition.totalPnL + newUnrealizedPnL;
            }
            
            // Check if position is fully closed
            if (remainingQuantity.lte(0)) {
                updatedPosition.status = 'CLOSED';
                updatedPosition.closedAt = Date.now();
                updatedPosition.holdTime = updatedPosition.closedAt - position.entryTime;
                updatedPosition.finalPrice = position.currentPrice;
                updatedPosition.finalPriceChange = position.priceChange;
                
                // Move to closed positions
                this.closedPositions.set(positionId, updatedPosition);
                this.positions.delete(positionId);
                
                logger.info(`📊 Position closed: ${position.symbol} | Total PnL: ${updatedPosition.totalPnL.toFixed(4)} SOL | Price change: ${position.priceChange.toFixed(2)}% | Hold: ${this.formatDuration(updatedPosition.holdTime)}`);
                
                this.emit('positionClosed', updatedPosition);
            } else {
                this.positions.set(positionId, updatedPosition);
                logger.info(`📊 Position updated: ${position.symbol} | Remaining: ${remainingQuantity} | PnL: ${pnl.toFixed(4)} SOL | Total PnL: ${updatedPosition.totalCurrentPnL.toFixed(4)} SOL`);
                
                this.emit('positionUpdated', updatedPosition);
            }
            
            // Save to disk
            await this.savePositions();
            
            return updatedPosition;
            
        } catch (error) {
            logger.error(`Error updating position ${positionId}:`, error);
            throw error;
        }
    }

    // Rest of the methods remain the same but with enhanced logging...
    async executeEmergencySell(position, reason) {
        try {
            logger.warn(`🚨 Executing emergency sell for ${position.symbol}: ${reason} (Current: ${position.currentPrice.toFixed(8)} SOL, Change: ${position.priceChange.toFixed(2)}%)`);
            
            // Sell entire remaining position
            await this.requestSell(position.id, position.remainingQuantity, reason);
            
        } catch (error) {
            logger.error(`Error executing emergency sell for ${position.symbol}:`, error);
        }
    }

    async executePartialSell(position, sellQuantity, reason) {
        try {
            const sellPercentage = (parseFloat(sellQuantity) / parseFloat(position.remainingQuantity) * 100).toFixed(1);
            logger.info(`💰 Executing partial sell for ${position.symbol}: ${sellQuantity} tokens (${sellPercentage}%) at ${position.currentPrice.toFixed(8)} SOL (${reason})`);
            
            await this.requestSell(position.id, sellQuantity, reason);
            
        } catch (error) {
            logger.error(`Error executing partial sell for ${position.symbol}:`, error);
        }
    }

    async requestSell(positionId, sellQuantity, reason) {
        try {
            // Emit sell request to trading bot
            this.emit('sellRequest', {
                positionId,
                sellQuantity,
                reason,
                timestamp: Date.now()
            });
            
        } catch (error) {
            logger.error(`Error requesting sell for position ${positionId}:`, error);
        }
    }

    // 🔥 ENHANCED: Performance stats with price tracking
    getPerformanceStats() {
        const activePositions = this.getActivePositions();
        const closedPositions = this.getClosedPositions();
        const allPositions = [...activePositions, ...closedPositions];
        
        const totalTrades = allPositions.length;
        const profitableTrades = allPositions.filter(pos => (pos.totalCurrentPnL || pos.totalPnL) > 0).length;
        const winRate = totalTrades > 0 ? (profitableTrades / totalTrades * 100).toFixed(1) : '0';
        
        const avgHoldTime = closedPositions.length > 0 ? 
            closedPositions.reduce((sum, pos) => sum + (pos.holdTime || 0), 0) / closedPositions.length : 0;
        
        // Calculate best and worst performing positions
        const bestPosition = allPositions.reduce((best, pos) => {
            const pnl = pos.totalCurrentPnL || pos.totalPnL || 0;
            return (!best || pnl > (best.totalCurrentPnL || best.totalPnL || 0)) ? pos : best;
        }, null);
        
        const worstPosition = allPositions.reduce((worst, pos) => {
            const pnl = pos.totalCurrentPnL || pos.totalPnL || 0;
            return (!worst || pnl < (worst.totalCurrentPnL || worst.totalPnL || 0)) ? pos : worst;
        }, null);
        
        return {
            totalPositions: totalTrades,
            activePositions: activePositions.length,
            closedPositions: closedPositions.length,
            profitableTrades,
            winRate: winRate + '%',
            totalInvested: this.getTotalInvestedAmount(),
            totalUnrealizedPnL: this.getTotalUnrealizedPnL(),
            totalRealizedPnL: this.getTotalRealizedPnL(),
            avgHoldTime: this.formatDuration(avgHoldTime),
            priceUpdateStats: {
                ...this.priceUpdateStats,
                lastUpdate: new Date(this.lastPriceUpdateTime).toISOString(),
                successRate: this.priceUpdateStats.successful > 0 ? 
                    ((this.priceUpdateStats.successful / (this.priceUpdateStats.successful + this.priceUpdateStats.failed)) * 100).toFixed(1) + '%' : '0%'
            },
            bestPosition: bestPosition ? {
                symbol: bestPosition.symbol,
                pnl: (bestPosition.totalCurrentPnL || bestPosition.totalPnL || 0).toFixed(4) + ' SOL',
                priceChange: bestPosition.priceChange ? bestPosition.priceChange.toFixed(2) + '%' : 'N/A'
            } : null,
            worstPosition: worstPosition ? {
                symbol: worstPosition.symbol,
                pnl: (worstPosition.totalCurrentPnL || worstPosition.totalPnL || 0).toFixed(4) + ' SOL',
                priceChange: worstPosition.priceChange ? worstPosition.priceChange.toFixed(2) + '%' : 'N/A'
            } : null
        };
    }

    // 🔥 ENHANCED: Position summary with precise price data
    getPositionSummary() {
        const positions = this.getActivePositions();
        
        return positions.map(pos => ({
            id: pos.id,
            symbol: pos.symbol,
            entryPrice: pos.entryPrice.toFixed(8) + ' SOL',
            currentPrice: pos.currentPrice ? pos.currentPrice.toFixed(8) + ' SOL' : 'N/A',
            priceChange: pos.priceChange ? (pos.priceChange > 0 ? '+' : '') + pos.priceChange.toFixed(2) + '%' : 'N/A',
            quantity: parseFloat(pos.remainingQuantity).toFixed(2),
            invested: pos.investedAmount.toFixed(4) + ' SOL',
            currentValue: pos.currentValue ? pos.currentValue.toFixed(4) + ' SOL' : 'N/A',
            unrealizedPnL: pos.unrealizedPnL ? 
                (pos.unrealizedPnL > 0 ? '+' : '') + pos.unrealizedPnL.toFixed(4) + ' SOL' : 'N/A',
            totalPnL: (pos.totalCurrentPnL || pos.totalPnL || 0).toFixed(4) + ' SOL',
            holdTime: this.formatDuration(Date.now() - pos.entryTime),
            status: pos.status || 'ACTIVE',
            lastPriceUpdate: pos.lastPriceUpdate ? 
                new Date(pos.lastPriceUpdate).toLocaleTimeString() : 'Never'
        }));
    }

    // All other existing methods remain the same...
    validatePosition(position) {
        const required = ['id', 'tokenAddress', 'symbol', 'entryPrice', 'quantity', 'investedAmount'];
        
        for (const field of required) {
            if (!position[field]) {
                throw new Error(`Position missing required field: ${field}`);
            }
        }
        
        if (parseFloat(position.quantity) <= 0) {
            throw new Error('Position quantity must be greater than 0');
        }
        
        if (parseFloat(position.investedAmount) <= 0) {
            throw new Error('Position invested amount must be greater than 0');
        }
    }

    hasPosition(tokenAddress) {
        return Array.from(this.positions.values()).some(pos => pos.tokenAddress === tokenAddress);
    }

    getPosition(positionId) {
        return this.positions.get(positionId);
    }

    getActivePositions() {
        return Array.from(this.positions.values());
    }

    getActivePositionsCount() {
        return this.positions.size;
    }

    getClosedPositions() {
        return Array.from(this.closedPositions.values());
    }

    getPositionsBySymbol(symbol) {
        return Array.from(this.positions.values()).filter(pos => pos.symbol === symbol);
    }

    getTotalInvestedAmount() {
        return Array.from(this.positions.values())
            .reduce((total, pos) => {
                const remainingRatio = parseFloat(pos.remainingQuantity) / parseFloat(pos.quantity);
                return total + (pos.investedAmount * remainingRatio);
            }, 0);
    }

    getTotalUnrealizedPnL() {
        return Array.from(this.positions.values())
            .reduce((total, pos) => total + (pos.unrealizedPnL || 0), 0);
    }

    getTotalRealizedPnL() {
        const activePnL = Array.from(this.positions.values())
            .reduce((total, pos) => total + pos.totalPnL, 0);
        
        const closedPnL = Array.from(this.closedPositions.values())
            .reduce((total, pos) => total + pos.totalPnL, 0);
        
        return activePnL + closedPnL;
    }

    formatDuration(ms) {
        if (!ms || ms <= 0) return '0s';
        
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m`;
        return `${seconds}s`;
    }

    async closeAllPositions(reason = 'SHUTDOWN') {
        try {
            logger.info(`🛑 Closing all ${this.positions.size} positions (${reason})`);
            
            const closePromises = Array.from(this.positions.keys()).map(positionId => 
                this.closePosition(positionId, reason)
            );
            
            const results = await Promise.allSettled(closePromises);
            
            const successful = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.filter(r => r.status === 'rejected').length;
            
            logger.info(`📊 Position closure complete: ${successful} successful, ${failed} failed`);
            
        } catch (error) {
            logger.error('Error closing all positions:', error);
        }
    }

    async closePosition(positionId, reason = 'MANUAL') {
        try {
            const position = this.positions.get(positionId);
            if (!position) {
                throw new Error(`Position ${positionId} not found`);
            }
            
            // Request full sell
            await this.requestSell(positionId, position.remainingQuantity, reason);
            
        } catch (error) {
            logger.error(`Error closing position ${positionId}:`, error);
            throw error;
        }
    }

    // Cleanup old closed positions (keep last 100)
    cleanupClosedPositions() {
        if (this.closedPositions.size > 100) {
            const positions = Array.from(this.closedPositions.entries())
                .sort((a, b) => (b[1].closedAt || 0) - (a[1].closedAt || 0));
            
            // Keep only the most recent 100
            const toKeep = positions.slice(0, 100);
            this.closedPositions = new Map(toKeep);
            
            logger.info(`🧹 Cleaned up old closed positions, kept ${toKeep.length}`);
        }
    }
}

module.exports = PositionManager;