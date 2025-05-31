// src/bot/positionManager.js - Clean version with essential features only
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
            fastUpdateInterval: config.fastUpdateInterval || 5000,  // 1s updates
            ...config
        };

        this.positions = new Map();
        this.closedPositions = new Map();
        this.tradingBot = null;
        
        this.stats = {
            stopLossTriggered: 0,
            takeProfitTriggered: 0,
            priceUpdates: 0
        };
        
        this.loadPositions();
        this.startPriceUpdates();
    }

    setTradingBot(tradingBot) {
        this.tradingBot = tradingBot;
        logger.info('📊 TradingBot connected for price updates');
    }

    // Monitor all positions for price changes and triggers
    startPriceUpdates() {
        setInterval(async () => {
            if (this.positions.size > 0 && this.tradingBot) {
                await this.updateAllPositions();
            }
        }, this.config.fastUpdateInterval);
        
        logger.info(`📊 Price monitoring started (${this.config.fastUpdateInterval}ms intervals)`);
    }

    async updateAllPositions() {
        for (const position of this.positions.values()) {
            try {
                // Get current price from Jupiter
                const currentPrice = await this.tradingBot.getTokenPriceManual(position.tokenAddress);
                
                if (currentPrice && currentPrice !== position.currentPrice) {
                    await this.updatePositionPrice(position, currentPrice);
                    this.stats.priceUpdates++;
                    
                    // Check triggers
                    await this.checkStopLoss(position);
                    await this.checkTakeProfits(position);
                }
                
            } catch (error) {
                logger.debug(`Price update failed for ${position.symbol}: ${error.message}`);
            }
        }
    }

    async updatePositionPrice(position, newPrice) {
        const remainingTokens = parseFloat(position.remainingQuantity);
        const currentValue = remainingTokens * newPrice;
        const investedValue = (remainingTokens / parseFloat(position.quantity)) * position.investedAmount;
        const unrealizedPnL = currentValue - investedValue;
        const priceChange = ((newPrice - position.entryPrice) / position.entryPrice) * 100;

        position.currentPrice = newPrice;
        position.currentValue = currentValue;
        position.unrealizedPnL = unrealizedPnL;
        position.priceChange = priceChange;
        position.lastPriceUpdate = Date.now();

        this.positions.set(position.id, position);
        
        logger.debug(`💰 ${position.symbol}: ${newPrice.toFixed(8)} SOL (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%)`);
    }

    // Check stop loss trigger
    async checkStopLoss(position) {
        if (!position.stopLossPrice || !position.currentPrice) return;
        
        if (position.currentPrice <= position.stopLossPrice) {
            const lossPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice * 100);
            
            logger.warn(`🛑 STOP LOSS: ${position.symbol} at ${position.currentPrice.toFixed(8)} SOL (${lossPercent.toFixed(1)}%)`);
            
            try {
                await this.tradingBot.sellPosition(position.id, 100, 'Stop Loss');
                this.stats.stopLossTriggered++;
            } catch (error) {
                logger.error(`Stop loss sell failed: ${error.message}`);
            }
        }
    }

    // Check take profit triggers
    async checkTakeProfits(position) {
        if (!position.takeProfitLevels || !position.currentPrice) return;
        
        for (const tp of position.takeProfitLevels) {
            if (tp.triggered || !tp.targetPrice) continue;
            
            if (position.currentPrice >= tp.targetPrice) {
                const gainPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice * 100);
                
                logger.info(`🎯 TAKE PROFIT: ${position.symbol} at ${position.currentPrice.toFixed(8)} SOL (+${gainPercent.toFixed(1)}%)`);
                
                tp.triggered = true;
                
                try {
                    await this.tradingBot.sellPosition(position.id, tp.sellPercentage, `Take Profit (+${tp.percentage}%)`);
                    this.stats.takeProfitTriggered++;
                } catch (error) {
                    logger.error(`Take profit sell failed: ${error.message}`);
                    tp.triggered = false;
                }
            }
        }
    }

    // Add new position
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
            lastPriceUpdate: Date.now()
        };
        
        this.positions.set(position.id, enhancedPosition);
        await this.savePositions();
        
        logger.info(`📈 Position: ${position.symbol} @ ${position.entryPrice.toFixed(8)} SOL`);
        if (position.stopLossPrice) {
            logger.info(`📉 Stop Loss: ${position.stopLossPrice.toFixed(8)} SOL`);
        }
        if (position.takeProfitLevels?.length > 0) {
            logger.info(`🎯 Take Profits: ${position.takeProfitLevels.map(tp => `${tp.targetPrice.toFixed(8)} SOL`).join(', ')}`);
        }
        
        this.emit('positionAdded', enhancedPosition);
        return enhancedPosition;
    }

    // Update position after sell
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

            logger.info(`📉 CLOSED: ${position.symbol} - PnL: ${updatedPosition.totalPnL.toFixed(4)} SOL`);
            this.emit('positionClosed', updatedPosition);
        } else {
            this.positions.set(positionId, updatedPosition);
            logger.info(`📊 SOLD: ${sellQuantity} ${position.symbol} - ${newRemainingQuantity.toFixed(2)} remaining`);
            this.emit('positionUpdated', updatedPosition);
        }

        await this.savePositions();
        return updatedPosition;
    }

    // Get performance summary
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

        return {
            totalPositions: totalTrades,
            activePositions: activePositions.length,
            closedPositions: closedPositions.length,
            winRate: winRate + '%',
            totalInvested: totalInvested.toFixed(4) + ' SOL',
            totalUnrealizedPnL: totalUnrealizedPnL.toFixed(4) + ' SOL',
            totalRealizedPnL: totalRealizedPnL.toFixed(4) + ' SOL',
            stopLossTriggered: this.stats.stopLossTriggered,
            takeProfitTriggered: this.stats.takeProfitTriggered,
            priceUpdates: this.stats.priceUpdates
        };
    }

    // Save/load positions
    async savePositions() {
        try {
            const data = {
                active: Object.fromEntries(this.positions),
                closed: Object.fromEntries(this.closedPositions),
                lastSaved: new Date().toISOString()
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
}

module.exports = PositionManager;