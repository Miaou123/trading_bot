// src/bot/positionManager.js - ENHANCED: Fast manual price updates with Jupiter fallback
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
            // 🚀 ENHANCED: Different update intervals for different price sources
            fastUpdateInterval: config.fastUpdateInterval || 1000,  // 1s for manual RPC
            slowUpdateInterval: config.slowUpdateInterval || 60000, // 1min for Jupiter fallback
            ...config
        };

        this.positions = new Map();
        this.closedPositions = new Map();
        this.tradingBot = null;
        
        // 🚀 ENHANCED: Track price source performance
        this.priceUpdateStats = {
            manual: { attempts: 0, successes: 0, totalTime: 0 },
            jupiter: { attempts: 0, successes: 0, totalTime: 0 },
            lastUpdate: Date.now()
        };
        
        this.stats = {
            stopLossTriggered: 0,
            takeProfitTriggered: 0,
            priceUpdates: 0,
            manualPriceUpdates: 0,
            jupiterPriceUpdates: 0,
            priceUpdateFailures: 0
        };
        
        this.loadPositions();
        this.startEnhancedPriceUpdates();
        this.startPriceStatsLogging();
    }

    setTradingBot(tradingBot) {
        this.tradingBot = tradingBot;
        logger.info('📊 Enhanced TradingBot connected for dual-speed price updates');
    }

    // 🚀 ENHANCED: Fast updates for manual RPC, slower for Jupiter fallback
    startEnhancedPriceUpdates() {
        // Fast updates using manual RPC (1 second)
        setInterval(async () => {
            if (this.positions.size > 0 && this.tradingBot) {
                await this.updateAllPositionsFast();
            }
        }, this.config.fastUpdateInterval);
        
        // Slower fallback updates using Jupiter (1 minute)
        setInterval(async () => {
            if (this.positions.size > 0 && this.tradingBot) {
                await this.updateAllPositionsSlow();
            }
        }, this.config.slowUpdateInterval);
        
        logger.info(`📊 Enhanced price monitoring started:`);
        logger.info(`   🔧 Manual RPC: ${this.config.fastUpdateInterval}ms intervals`);
        logger.info(`   🪐 Jupiter fallback: ${this.config.slowUpdateInterval}ms intervals`);
    }

    // 🚀 NEW: Log price source stats every minute
    startPriceStatsLogging() {
        setInterval(() => {
            const manual = this.priceUpdateStats.manual;
            const jupiter = this.priceUpdateStats.jupiter;
            
            if (manual.attempts > 0 || jupiter.attempts > 0) {
                const manualSuccess = manual.attempts > 0 ? ((manual.successes / manual.attempts) * 100).toFixed(1) : '0';
                const jupiterSuccess = jupiter.attempts > 0 ? ((jupiter.successes / jupiter.attempts) * 100).toFixed(1) : '0';
                const manualAvg = manual.successes > 0 ? (manual.totalTime / manual.successes).toFixed(0) : 'N/A';
                const jupiterAvg = jupiter.successes > 0 ? (jupiter.totalTime / jupiter.successes).toFixed(0) : 'N/A';
                
                logger.info('📊 POSITION PRICE UPDATE STATS:');
                logger.info(`   🔧 Manual: ${manual.successes}/${manual.attempts} (${manualSuccess}%) avg: ${manualAvg}ms`);
                logger.info(`   🪐 Jupiter: ${jupiter.successes}/${jupiter.attempts} (${jupiterSuccess}%) avg: ${jupiterAvg}ms`);
                
                // Reset stats
                this.priceUpdateStats.manual = { attempts: 0, successes: 0, totalTime: 0 };
                this.priceUpdateStats.jupiter = { attempts: 0, successes: 0, totalTime: 0 };
            }
        }, 60000); // Every minute
    }

    // 🚀 FAST: Update all positions using manual RPC method
    async updateAllPositionsFast() {
        for (const position of this.positions.values()) {
            try {
                // Try manual price calculation first (fast)
                const currentPrice = await this.getPositionPriceManual(position);
                
                if (currentPrice && currentPrice !== position.currentPrice) {
                    await this.updatePositionPrice(position, currentPrice, 'manual');
                    
                    // Check triggers after price update
                    await this.checkStopLoss(position);
                    await this.checkTakeProfits(position);
                }
                
            } catch (error) {
                logger.debug(`Fast price update failed for ${position.symbol}: ${error.message}`);
            }
        }
    }

    // 🪐 SLOW: Update all positions using Jupiter fallback (if manual failed recently)
    async updateAllPositionsSlow() {
        for (const position of this.positions.values()) {
            try {
                // Only use Jupiter if manual method hasn't updated recently
                const timeSinceLastUpdate = Date.now() - (position.lastPriceUpdate || 0);
                
                if (timeSinceLastUpdate > 30000) { // If no update in 30 seconds
                    logger.debug(`📡 Using Jupiter fallback for ${position.symbol} (no recent manual update)`);
                    
                    const currentPrice = await this.getPositionPriceJupiter(position);
                    
                    if (currentPrice && currentPrice !== position.currentPrice) {
                        await this.updatePositionPrice(position, currentPrice, 'jupiter');
                        
                        // Check triggers after price update
                        await this.checkStopLoss(position);
                        await this.checkTakeProfits(position);
                    }
                }
                
            } catch (error) {
                logger.debug(`Jupiter fallback price update failed for ${position.symbol}: ${error.message}`);
            }
        }
    }

    // 🔧 Get position price using WORKING manual RPC method from debugPrice.js
    async getPositionPriceManual(position) {
        const startTime = Date.now();
        this.priceUpdateStats.manual.attempts++;
        
        try {
            // Use the WORKING manual price method from debugPrice.js
            // Note: This requires poolAddress to be stored in position data
            const poolAddress = position.poolAddress || position.alert?.poolAddress;
            
            if (!poolAddress) {
                // If no pool address, fall back to Jupiter method
                logger.debug(`No pool address for ${position.symbol}, skipping manual method`);
                return null;
            }
            
            const price = await this.tradingBot.getTokenPriceViaManualRPC(position.tokenAddress, poolAddress);
            
            if (price) {
                const duration = Date.now() - startTime;
                this.priceUpdateStats.manual.successes++;
                this.priceUpdateStats.manual.totalTime += duration;
                this.stats.manualPriceUpdates++;
                
                logger.debug(`🔧 Manual price for ${position.symbol}: ${price.toFixed(8)} SOL (${duration}ms)`);
                return price;
            }
            
            return null;
            
        } catch (error) {
            logger.debug(`Manual price failed for ${position.symbol}: ${error.message}`);
            return null;
        }
    }

    // 🪐 Get position price using Jupiter fallback
    async getPositionPriceJupiter(position) {
        const startTime = Date.now();
        this.priceUpdateStats.jupiter.attempts++;
        
        try {
            // Use enhanced trading bot's Jupiter price method
            const price = await this.tradingBot.getTokenPriceViaJupiter(position.tokenAddress);
            
            if (price) {
                const duration = Date.now() - startTime;
                this.priceUpdateStats.jupiter.successes++;
                this.priceUpdateStats.jupiter.totalTime += duration;
                this.stats.jupiterPriceUpdates++;
                
                logger.debug(`🪐 Jupiter price for ${position.symbol}: ${price.toFixed(8)} SOL (${duration}ms)`);
                return price;
            }
            
            return null;
            
        } catch (error) {
            logger.debug(`Jupiter price failed for ${position.symbol}: ${error.message}`);
            return null;
        }
    }

    // 🚀 ENHANCED: Update position price with source tracking
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
        const sourceIcon = source === 'manual' ? '🔧' : source === 'jupiter' ? '🪐' : '❓';
        logger.debug(`${sourceIcon} ${position.symbol}: ${newPrice.toFixed(8)} SOL (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%) via ${source}`);
    }

    // Check stop loss trigger (unchanged)
    async checkStopLoss(position) {
        if (!position.stopLossPrice || !position.currentPrice) return;
        
        if (position.currentPrice <= position.stopLossPrice) {
            const lossPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice * 100);
            
            logger.warn(`🛑 STOP LOSS: ${position.symbol} at ${position.currentPrice.toFixed(8)} SOL (${lossPercent.toFixed(1)}%)`);
            
            try {
                await this.tradingBot.sellPosition(position.id, 100, 'Stop Loss');
                this.stats.stopLossTriggered++;
                
                this.emit('stopLossTriggered', {
                    position: position,
                    triggerPrice: position.currentPrice,
                    lossPercentage: Math.abs(lossPercent),
                    priceSource: position.lastPriceSource
                });
                
            } catch (error) {
                logger.error(`Stop loss sell failed: ${error.message}`);
            }
        }
    }

    // Check take profit triggers (unchanged)
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
                    
                    this.emit('takeProfitTriggered', {
                        position: position,
                        level: tp.level,
                        triggerPrice: position.currentPrice,
                        gainPercentage: gainPercent,
                        sellPercentage: tp.sellPercentage,
                        priceSource: position.lastPriceSource
                    });
                    
                } catch (error) {
                    logger.error(`Take profit sell failed: ${error.message}`);
                    tp.triggered = false;
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
        logger.info(`📈 Position: ${position.symbol} @ ${position.entryPrice.toFixed(8)} SOL${priceSourceInfo}`);
        if (position.stopLossPrice) {
            logger.info(`📉 Stop Loss: ${position.stopLossPrice.toFixed(8)} SOL`);
        }
        if (position.takeProfitLevels?.length > 0) {
            logger.info(`🎯 Take Profits: ${position.takeProfitLevels.map(tp => `${tp.targetPrice.toFixed(8)} SOL`).join(', ')}`);
        }
        
        this.emit('positionAdded', enhancedPosition);
        return enhancedPosition;
    }

    // Update position after sell (unchanged but with enhanced logging)
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
            logger.info(`📉 CLOSED: ${position.symbol} - PnL: ${updatedPosition.totalPnL.toFixed(4)} SOL${priceSourceInfo}`);
            this.emit('positionClosed', updatedPosition);
        } else {
            this.positions.set(positionId, updatedPosition);
            logger.info(`📊 SOLD: ${sellQuantity} ${position.symbol} - ${newRemainingQuantity.toFixed(2)} remaining`);
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
        const manualPricePositions = activePositions.filter(pos => pos.lastPriceSource === 'manual').length;
        const jupiterPricePositions = activePositions.filter(pos => pos.lastPriceSource === 'jupiter').length;

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
                manual: this.stats.manualPriceUpdates,
                jupiter: this.stats.jupiterPriceUpdates,
                failures: this.stats.priceUpdateFailures
            },
            
            currentPriceSources: {
                manual: manualPricePositions,
                jupiter: jupiterPricePositions,
                unknown: activePositions.length - manualPricePositions - jupiterPricePositions
            },
            
            triggers: {
                stopLossTriggered: this.stats.stopLossTriggered,
                takeProfitTriggered: this.stats.takeProfitTriggered
            }
        };
    }

    // Save/load positions (unchanged)
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

    // Helper methods (unchanged)
    hasPosition(tokenAddress) {
        return Array.from(this.positions.values()).some(pos => pos.tokenAddress === tokenAddress);
    }

    getActivePositions() {
        return Array.from(this.positions.values());
    }

    getActivePositionsCount() {
        return this.positions.size;
    }

    // 🚀 NEW: Get detailed position info with price history
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

    // 🚀 NEW: Calculate price source distribution for a position
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
}

module.exports = PositionManager;