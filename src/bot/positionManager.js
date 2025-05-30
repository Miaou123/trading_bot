// src/bot/positionManager.js - Manages all trading positions
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
            ...config
        };

        this.positions = new Map(); // Active positions
        this.closedPositions = new Map(); // Historical positions
        this.riskManager = config.riskManager;
        
        this.loadPositions();
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
                lastSaved: new Date().toISOString()
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
            
            // Add position
            this.positions.set(position.id, {
                ...position,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                status: 'ACTIVE',
                totalPnL: 0,
                sellOrders: []
            });
            
            // Save to disk
            await this.savePositions();
            
            logger.info(`📈 Position added: ${position.symbol} (${position.id})`);
            
            this.emit('positionAdded', position);
            
            return position;
            
        } catch (error) {
            logger.error(`Error adding position for ${position.symbol}:`, error);
            throw error;
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
            
            // Record the sell order
            const sellOrder = {
                timestamp: Date.now(),
                quantity: sellQuantity,
                value: soldValue,
                pnl: pnl,
                txHash: txHash,
                reason: reason
            };
            
            // Update position
            const updatedPosition = {
                ...position,
                remainingQuantity: remainingQuantity.toString(),
                totalPnL: position.totalPnL + pnl,
                updatedAt: Date.now(),
                sellOrders: [...position.sellOrders, sellOrder]
            };
            
            // Check if position is fully closed
            if (remainingQuantity.lte(0)) {
                updatedPosition.status = 'CLOSED';
                updatedPosition.closedAt = Date.now();
                updatedPosition.holdTime = updatedPosition.closedAt - position.entryTime;
                
                // Move to closed positions
                this.closedPositions.set(positionId, updatedPosition);
                this.positions.delete(positionId);
                
                logger.info(`📊 Position closed: ${position.symbol} | PnL: ${updatedPosition.totalPnL.toFixed(4)} SOL | Hold: ${this.formatDuration(updatedPosition.holdTime)}`);
                
                this.emit('positionClosed', updatedPosition);
            } else {
                this.positions.set(positionId, updatedPosition);
                logger.info(`📊 Position updated: ${position.symbol} | Remaining: ${remainingQuantity} | PnL: ${pnl.toFixed(4)} SOL`);
                
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

    async updateAllPositions() {
        try {
            if (this.positions.size === 0) return;
            
            logger.debug(`🔄 Updating ${this.positions.size} positions...`);
            
            const updatePromises = Array.from(this.positions.values()).map(position => 
                this.updateSinglePosition(position)
            );
            
            const results = await Promise.allSettled(updatePromises);
            
            const successful = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.filter(r => r.status === 'rejected').length;
            
            if (failed > 0) {
                logger.warn(`⚠️ Position updates: ${successful} successful, ${failed} failed`);
            }
            
        } catch (error) {
            logger.error('Error updating positions:', error);
        }
    }

    async updateSinglePosition(position) {
        try {
            // Get current price (mock for now - implement real price fetching)
            const currentPrice = await this.getCurrentPrice(position.tokenAddress);
            
            if (!currentPrice) {
                logger.debug(`⏭️ No price data for ${position.symbol}, skipping update`);
                return;
            }
            
            const currentValue = parseFloat(position.remainingQuantity) * currentPrice;
            const investedValue = (parseFloat(position.remainingQuantity) / parseFloat(position.quantity)) * position.investedAmount;
            const unrealizedPnL = currentValue - investedValue;
            const totalPnL = position.totalPnL + unrealizedPnL;
            
            // Update position with current data
            const updatedPosition = {
                ...position,
                currentPrice: currentPrice,
                currentValue: currentValue,
                unrealizedPnL: unrealizedPnL,
                totalCurrentPnL: totalPnL,
                lastPriceUpdate: Date.now()
            };

            this.positions.set(position.id, updatedPosition);

            // Check for stop loss trigger
            await this.checkStopLoss(updatedPosition);
            
            // Check for take profit triggers
            await this.checkTakeProfits(updatedPosition);
            
        } catch (error) {
            logger.error(`Error updating position ${position.symbol}:`, error);
            throw error;
        }
    }

    async getCurrentPrice(tokenAddress) {
        try {
            // Mock price for now - implement real price fetching using PumpAmmSdk
            if (this.config.tradingMode === 'paper') {
                // Simulate price movement for paper trading
                const basePrice = 0.0001;
                const randomChange = (Math.random() - 0.5) * 0.1; // ±5% movement
                return basePrice * (1 + randomChange);
            }
            
            // TODO: Implement real price fetching
            // const pool = await this.findTokenPool(tokenAddress);
            // const price = await this.calculateCurrentPrice(pool);
            // return price;
            
            logger.debug(`Mock price used for ${tokenAddress}`);
            return null;
            
        } catch (error) {
            logger.error(`Error getting current price for ${tokenAddress}:`, error);
            return null;
        }
    }

    async checkStopLoss(position) {
        try {
            if (position.currentValue <= position.stopLoss) {
                logger.warn(`🚨 Stop loss triggered for ${position.symbol}: ${position.currentValue.toFixed(4)} <= ${position.stopLoss.toFixed(4)}`);
                
                // Execute emergency sell
                await this.executeEmergencySell(position, 'STOP_LOSS');
            }
        } catch (error) {
            logger.error(`Error checking stop loss for ${position.symbol}:`, error);
        }
    }

    async checkTakeProfits(position) {
        try {
            for (let i = 0; i < position.takeProfitLevels.length; i++) {
                const level = position.takeProfitLevels[i];
                
                if (!level.triggered && position.currentValue >= level.targetValue) {
                    logger.info(`🎯 Take profit ${i + 1} triggered for ${position.symbol}: ${position.currentValue.toFixed(4)} >= ${level.targetValue.toFixed(4)}`);
                    
                    // Calculate sell quantity
                    const sellPercentage = level.sellPercentage / 100;
                    const sellQuantity = new Big(position.remainingQuantity).times(sellPercentage);
                    
                    // Execute partial sell
                    await this.executePartialSell(position, sellQuantity.toString(), `TAKE_PROFIT_${i + 1}`);
                    
                    // Mark level as triggered
                    position.takeProfitLevels[i].triggered = true;
                    this.positions.set(position.id, position);
                }
            }
        } catch (error) {
            logger.error(`Error checking take profits for ${position.symbol}:`, error);
        }
    }

    async executeEmergencySell(position, reason) {
        try {
            logger.warn(`🚨 Executing emergency sell for ${position.symbol}: ${reason}`);
            
            // Sell entire remaining position
            await this.requestSell(position.id, position.remainingQuantity, reason);
            
        } catch (error) {
            logger.error(`Error executing emergency sell for ${position.symbol}:`, error);
        }
    }

    async executePartialSell(position, sellQuantity, reason) {
        try {
            logger.info(`💰 Executing partial sell for ${position.symbol}: ${sellQuantity} tokens (${reason})`);
            
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

    getPerformanceStats() {
        const activePositions = this.getActivePositions();
        const closedPositions = this.getClosedPositions();
        const allPositions = [...activePositions, ...closedPositions];
        
        const totalTrades = allPositions.length;
        const profitableTrades = allPositions.filter(pos => (pos.totalCurrentPnL || pos.totalPnL) > 0).length;
        const winRate = totalTrades > 0 ? (profitableTrades / totalTrades * 100).toFixed(1) : '0';
        
        const avgHoldTime = closedPositions.length > 0 ? 
            closedPositions.reduce((sum, pos) => sum + (pos.holdTime || 0), 0) / closedPositions.length : 0;
        
        return {
            totalPositions: totalTrades,
            activePositions: activePositions.length,
            closedPositions: closedPositions.length,
            profitableTrades,
            winRate: winRate + '%',
            totalInvested: this.getTotalInvestedAmount(),
            totalUnrealizedPnL: this.getTotalUnrealizedPnL(),
            totalRealizedPnL: this.getTotalRealizedPnL(),
            avgHoldTime: this.formatDuration(avgHoldTime)
        };
    }

    getPositionSummary() {
        const positions = this.getActivePositions();
        
        return positions.map(pos => ({
            id: pos.id,
            symbol: pos.symbol,
            entryPrice: pos.entryPrice,
            currentPrice: pos.currentPrice || 'N/A',
            quantity: parseFloat(pos.remainingQuantity).toFixed(2),
            invested: pos.investedAmount.toFixed(4) + ' SOL',
            currentValue: pos.currentValue ? pos.currentValue.toFixed(4) + ' SOL' : 'N/A',
            unrealizedPnL: pos.unrealizedPnL ? pos.unrealizedPnL.toFixed(4) + ' SOL' : 'N/A',
            totalPnL: (pos.totalPnL + (pos.unrealizedPnL || 0)).toFixed(4) + ' SOL',
            holdTime: this.formatDuration(Date.now() - pos.entryTime),
            status: pos.status || 'ACTIVE'
        }));
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