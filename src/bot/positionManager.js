// src/bot/positionManager.js - ENHANCED: Transaction confirmation tracking with clean state management
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const TelegramService = require('../services/telegramService');

class PositionManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            positionsFile: config.positionsFile || './positions.json',
            tradesHistoryFile: config.tradesHistoryFile || './trades_history.json',
            maxPositions: config.maxPositions || 20,
            fastUpdateInterval: config.fastUpdateInterval || 1000,
            slowUpdateInterval: config.slowUpdateInterval || 60000,
            confirmationDelay: config.confirmationDelay || 5000, // 5 seconds
            maxRetries: config.maxRetries || 3,
            ...config
        };

        // Only ACTIVE and PENDING_SELL positions
        this.positions = new Map();
        
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
            stopLossExecutions: 0,
            takeProfitExecutions: 0,
            sessionPnL: 0,
            confirmationChecks: 0,
            confirmationSuccesses: 0,
            confirmationFailures: 0,
            retryAttempts: 0,
            manualReviewCount: 0
        };

        // Initialize Telegram service
        this.telegramService = new TelegramService();
        
        this.loadPositions();
        this.startEnhancedPriceUpdates();
        this.startPriceStatsLogging();
    }

    setTradingBot(tradingBot) {
        this.tradingBot = tradingBot;
        logger.info('📊 Enhanced TradingBot connected with transaction confirmation tracking');
    }

    // Enhanced price updates with live monitoring
    startEnhancedPriceUpdates() {
        // Fast updates for ACTIVE positions only (not pending)
        setInterval(async () => {
            const activePositions = this.getActivePositions();
            if (activePositions.length > 0 && this.tradingBot) {
                logger.debug(`🔄 Starting fast price update cycle for ${activePositions.length} active positions`);
                await this.updateAllPositionsFast();
            }
        }, this.config.fastUpdateInterval);
        
        // Slower fallback updates
        setInterval(async () => {
            const activePositions = this.getActivePositions();
            if (activePositions.length > 0 && this.tradingBot) {
                logger.debug(`🔄 Starting fallback price update cycle for ${activePositions.length} active positions`);
                await this.updateAllPositionsSlow();
            }
        }, this.config.slowUpdateInterval);
        
        logger.info(`📊 Enhanced price monitoring started:`);
        logger.info(`   🔧 Pool-based: ${this.config.fastUpdateInterval}ms intervals`);
        logger.info(`   🪐 Fallback: ${this.config.slowUpdateInterval}ms intervals`);
        logger.info(`   🔍 Confirmation delay: ${this.config.confirmationDelay}ms`);
        logger.info(`   🔄 Max retries: ${this.config.maxRetries}`);
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
                    const statusIcon = pos.status === 'PENDING_SELL' ? '⏳' : '🔵';
                    
                    return `${statusIcon}${pos.symbol || pos.tokenAddress.slice(0,8)}:${currentPrice.toFixed(8)}${changeIcon}${priceChange.toFixed(1)}%[${source}]`;
                });
                
                logger.info(`📊 POSITIONS: ${positionSummaries.join(' | ')}`);
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
                
                if (this.sessionStats.liveSellsExecuted > 0) {
                    logger.info('💰 SESSION TRADING STATS:');
                    logger.info(`   🚀 Live sells: ${this.sessionStats.liveSellsExecuted}`);
                    logger.info(`   🛑 Stop losses: ${this.sessionStats.stopLossExecutions}`);
                    logger.info(`   🎯 Take profits: ${this.sessionStats.takeProfitExecutions}`);
                    logger.info(`   💎 Session PnL: ${this.sessionStats.sessionPnL.toFixed(6)} SOL`);
                    logger.info(`   🔍 Confirmations: ${this.sessionStats.confirmationSuccesses}/${this.sessionStats.confirmationChecks}`);
                    logger.info(`   🔄 Retries: ${this.sessionStats.retryAttempts}`);
                    logger.info(`   ⚠️ Manual reviews: ${this.sessionStats.manualReviewCount}`);
                }
                
                // Reset stats
                this.priceUpdateStats.poolBased = { attempts: 0, successes: 0, totalTime: 0 };
                this.priceUpdateStats.fallback = { attempts: 0, successes: 0, totalTime: 0 };
            }
        }, 60000); // Every minute
    }

    // FAST: Update all ACTIVE positions only (skip pending)
    async updateAllPositionsFast() {
        const activePositions = this.getActivePositions();
        for (const position of activePositions) {
            try {
                logger.debug(`🔧 Fast update for ${position.symbol} (${position.tokenAddress.slice(0,8)})`);
                
                const currentPrice = await this.getPositionPricePoolBased(position);
                
                if (currentPrice && currentPrice !== position.currentPrice) {
                    logger.debug(`✅ Price update successful for ${position.symbol}: ${position.currentPrice} → ${currentPrice}`);
                    await this.updatePositionPrice(position, currentPrice, 'pool_based');
                    
                    // Check triggers after price update
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

    // SLOW: Update all ACTIVE positions using fallback method
    async updateAllPositionsSlow() {
        const activePositions = this.getActivePositions();
        for (const position of activePositions) {
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


    async executePumpSwapSell(position, sellPercentage, reason = 'Manual Sell') {
        try {
            // Prevent double-selling
            if (position.status === 'PENDING_SELL') {
                logger.warn(`⚠️ Position ${position.symbol} already has pending sell`);
                return { success: false, error: 'Sell already pending' };
            }

            // Update position to pending
            position.status = 'PENDING_SELL';
            position.pendingReason = reason;
            position.pendingSellPercentage = sellPercentage;
            position.pendingStartTime = Date.now();
            position.pendingTokenAmount = (parseFloat(position.quantity) * sellPercentage / 100);
            position.retryCount = (position.retryCount || 0);
            
            this.positions.set(position.id, position);
            await this.savePositions();

            logger.info(`⏳ Position ${position.symbol} set to PENDING_SELL`);
            logger.info(`🚀 Executing LIVE sell: ${position.pendingTokenAmount} ${position.symbol} (${reason})`);
            
            // 🔥 CORRECT: Call the trading bot's method, not PumpSwap service directly
            if (!this.tradingBot) {
                throw new Error('Trading bot not connected to position manager');
            }

            const sellResult = await this.tradingBot.executePumpSwapSell(position, sellPercentage, reason);

            if (sellResult && sellResult.success && sellResult.signature) {
                logger.info(`✅ Live sell submitted: ${sellResult.signature}`);
                return sellResult;
            } else {
                throw new Error('Sell transaction failed - no signature returned');
            }

        } catch (error) {
            logger.error(`❌ Live sell execution failed:`, error.message);
            
            // Enhanced error handling with verification system
            position.retryCount = (position.retryCount || 0) + 1;
            
            if (position.retryCount >= 3 && error.message.includes('insufficient funds')) {
                logger.warn(`🔍 INSUFFICIENT FUNDS after ${position.retryCount} attempts - verifying tokens...`);
                
                try {
                    const recovered = await this.verifyTokensAndRecoverPosition(position, error.message);
                    if (recovered) {
                        logger.info(`✅ Position ${position.symbol} recovered successfully`);
                        return { success: true, recovered: true };
                    }
                } catch (verifyError) {
                    logger.error(`❌ Verification failed: ${verifyError.message}`);
                }
            }
            
            // Handle retries or move to manual review
            if (position.retryCount >= this.config.maxRetries) {
                await this.moveToManualReview(position, `Max retries exceeded: ${error.message}`);
            } else {
                // Reset position to ACTIVE for retry
                position.status = 'ACTIVE';
                position.lastRetryError = error.message;
                this.positions.set(position.id, position);
                await this.savePositions();
                
                logger.warn(`⚠️ Sell failed (attempt ${position.retryCount}/${this.config.maxRetries}), resetting to ACTIVE`);
            }
            
            throw error;
        }
    }

    // Schedule confirmation check after delay
    scheduleConfirmationCheck(positionId, txHash) {
        setTimeout(async () => {
            await this.checkTransactionConfirmation(positionId, txHash);
        }, this.config.confirmationDelay);
    }

    // Check if transaction was confirmed on-chain
    async checkTransactionConfirmation(positionId, txHash) {
        try {
            const position = this.positions.get(positionId);
            if (!position || position.status !== 'PENDING_SELL') {
                logger.debug(`Position ${positionId} no longer pending, skipping confirmation check`);
                return;
            }

            this.sessionStats.confirmationChecks++;
            logger.info(`🔍 Checking confirmation for ${position.symbol}: ${txHash}`);
            
            // Check transaction status on-chain
            const confirmed = await this.isTransactionConfirmed(txHash);
            
            if (confirmed) {
                logger.info(`✅ Transaction confirmed: ${txHash}`);
                this.sessionStats.confirmationSuccesses++;
                
                // Calculate final results
                const tokenAmount = position.pendingTokenAmount;
                const originalInvestment = (tokenAmount / parseFloat(position.quantity)) * position.investedAmount;
                const pnl = confirmed.solReceived - originalInvestment;
                
                await this.completeSell(positionId, {
                    tokenAmount,
                    solReceived: confirmed.solReceived,
                    pnl,
                    signature: txHash,
                    reason: position.pendingReason
                });
                
                this.sessionStats.liveSellsExecuted++;
                this.sessionStats.sessionPnL += pnl;
                
            } else {
                logger.warn(`⚠️ Transaction not confirmed: ${txHash}`);
                this.sessionStats.confirmationFailures++;
                
                // Increment retry count and retry or move to manual review
                position.retryCount = (position.retryCount || 0) + 1;
                this.sessionStats.retryAttempts++;
                
                if (position.retryCount >= this.config.maxRetries) {
                    await this.moveToManualReview(position, `Transaction not confirmed after ${this.config.maxRetries} attempts`);
                } else {
                    // Reset position for retry
                    position.status = 'ACTIVE';
                    position.lastRetryReason = 'Transaction not confirmed';
                    this.positions.set(positionId, position);
                    await this.savePositions();
                    
                    logger.info(`🔄 Retrying sell for ${position.symbol} (attempt ${position.retryCount + 1}/${this.config.maxRetries})`);
                    
                    // Trigger another sell attempt after a short delay
                    setTimeout(() => {
                        this.executePumpSwapSell(position, position.pendingSellPercentage, position.pendingReason);
                    }, 2000);
                }
            }
            
        } catch (error) {
            logger.error(`❌ Confirmation check failed for ${positionId}: ${error.message}`);
            this.sessionStats.confirmationFailures++;
            
            const position = this.positions.get(positionId);
            if (position) {
                await this.moveToManualReview(position, `Confirmation check error: ${error.message}`);
            }
        }
    }

 // Check if transaction is confirmed on blockchain - FIXED for versioned transactions
 async isTransactionConfirmed(txHash) {
    try {
        if (!this.tradingBot?.pumpSwapService?.connection) {
            throw new Error('No connection available');
        }

        const connection = this.tradingBot.pumpSwapService.connection;
        
        // 🔥 FIX: Add maxSupportedTransactionVersion for versioned transactions
        const status = await connection.getSignatureStatus(txHash, {
            searchTransactionHistory: true
        });
        
        if (status?.value?.confirmationStatus === 'confirmed' || 
            status?.value?.confirmationStatus === 'finalized') {
            
            // 🔥 FIX: Add maxSupportedTransactionVersion to getTransaction
            const txDetails = await connection.getTransaction(txHash, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0  // Support versioned transactions
            });
            
            if (txDetails) {
                // Extract actual SOL received from transaction
                const solReceived = this.extractSolFromTransaction(txDetails);
                return { confirmed: true, solReceived };
            }
            
            // If we can't get transaction details but status is confirmed, assume success
            logger.warn(`Transaction confirmed but couldn't get details: ${txHash}`);
            return { confirmed: true, solReceived: 0 };
        }
        
        return false;
        
    } catch (error) {
        logger.error(`Transaction confirmation check failed: ${error.message}`);
        return false;
    }
}

    // Extract SOL received from transaction details
    extractSolFromTransaction(txDetails) {
        try {
            // This would need to be implemented based on your transaction structure
            // For now, return estimated amount based on current price
            const postBalances = txDetails.meta?.postBalances || [];
            const preBalances = txDetails.meta?.preBalances || [];
            
            // Calculate SOL difference (simplified)
            if (postBalances.length > 0 && preBalances.length > 0) {
                const solDiff = (postBalances[0] - preBalances[0]) / 1e9;
                return Math.abs(solDiff);
            }
            
            return 0;
        } catch (error) {
            logger.error('Failed to extract SOL from transaction:', error.message);
            return 0;
        }
    }

    async completeSell(positionId, sellData) {
        const position = this.positions.get(positionId);
        if (!position) return;
    
        const originalQuantity = parseFloat(position.quantity);
        const currentRemainingQuantity = parseFloat(position.remainingQuantity);
        const soldQuantity = sellData.tokenAmount;
        const newRemainingQuantity = currentRemainingQuantity - soldQuantity;
        
        // Calculate what percentage of original position was sold
        const soldPercentage = (soldQuantity / originalQuantity) * 100;
        const remainingPercentage = (newRemainingQuantity / originalQuantity) * 100;
        
        logger.info(`📊 SELL COMPLETED: ${position.symbol}`);
        logger.info(`   Sold: ${soldQuantity.toFixed(6)} tokens (${soldPercentage.toFixed(1)}% of original)`);
        logger.info(`   Remaining: ${newRemainingQuantity.toFixed(6)} tokens (${remainingPercentage.toFixed(1)}% of original)`);
        logger.info(`   PnL: ${sellData.pnl.toFixed(6)} SOL`);
        
        // 🔥 FIXED: Use a smaller threshold and better logic for determining if position should stay open
        const minTokenThreshold = 0.001; // Very small threshold
        const minPercentageThreshold = 0.1; // 0.1% minimum remaining to keep position open
        
        if (newRemainingQuantity > minTokenThreshold && remainingPercentage > minPercentageThreshold) {
            // PARTIAL SELL - Keep position ACTIVE
            const updatedPosition = {
                ...position,
                remainingQuantity: newRemainingQuantity.toString(),
                status: 'ACTIVE', // 🔥 CRITICAL: Reset to ACTIVE for partial sells
                totalRealizedPnL: (position.totalRealizedPnL || 0) + sellData.pnl,
                partialSells: (position.partialSells || []).concat({
                    timestamp: Date.now(),
                    soldQuantity: soldQuantity,
                    solReceived: sellData.solReceived,
                    pnl: sellData.pnl,
                    reason: sellData.reason,
                    signature: sellData.signature,
                    soldPercentage: soldPercentage
                }),
                updatedAt: Date.now(),
                lastSellAt: Date.now(),
                // 🔥 IMPORTANT: Clear pending status and retry info
                pendingReason: undefined,
                pendingSellPercentage: undefined,
                pendingStartTime: undefined,
                pendingTxHash: undefined,
                pendingTokenAmount: undefined,
                retryCount: 0,
                lastRetryError: undefined,
                lastRetryReason: undefined
            };
            
            this.positions.set(positionId, updatedPosition);
            await this.savePositions();
            
            logger.info(`🔄 PARTIAL SELL COMPLETED: ${position.symbol} - ${remainingPercentage.toFixed(1)}% position remaining [ACTIVE]`);
            logger.info(`💰 Realized PnL so far: ${updatedPosition.totalRealizedPnL.toFixed(6)} SOL`);
            
            this.emit('partialSell', {
                position: updatedPosition,
                sellData: sellData,
                remainingPercentage: remainingPercentage
            });
            
        } else {
            // FULL CLOSE - Move to trade history
            const totalPnL = (position.totalRealizedPnL || 0) + sellData.pnl;
            
            const finalPosition = {
                ...position,
                remainingQuantity: "0",
                status: 'CLOSED',
                closedAt: Date.now(),
                closeReason: sellData.reason,
                finalTxHash: sellData.signature,
                solReceived: sellData.solReceived,
                finalPnL: totalPnL,
                updatedAt: Date.now(),
                // Add the final sell to partialSells array for complete history
                partialSells: (position.partialSells || []).concat({
                    timestamp: Date.now(),
                    soldQuantity: soldQuantity,
                    solReceived: sellData.solReceived,
                    pnl: sellData.pnl,
                    reason: sellData.reason,
                    signature: sellData.signature,
                    soldPercentage: soldPercentage,
                    finalSell: true
                })
            };
    
            // Move to trade history and remove from active
            await this.movePositionToHistory(finalPosition);
            this.positions.delete(positionId);
            await this.savePositions();
            
            logger.info(`✅ POSITION FULLY CLOSED: ${position.symbol} - Total PnL: ${finalPosition.finalPnL.toFixed(6)} SOL`);
            
            this.emit('positionClosed', finalPosition);
        }
    }

    async updatePositionAfterSell(positionId, tokensSold, solReceived, pnl, signature, reason) {
        try {
            const position = this.positions.get(positionId);
            if (!position) {
                logger.error(`Position ${positionId} not found for update after sell`);
                return;
            }
    
            logger.info(`🔄 UPDATING POSITION AFTER SELL: ${position.symbol}`);
            logger.info(`   Tokens Sold: ${tokensSold.toLocaleString()}`);
            logger.info(`   SOL Received: ${solReceived.toFixed(6)} SOL`);
            logger.info(`   PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL`);
            logger.info(`   Signature: ${signature}`);
    
            // Calculate new remaining quantity using EXACT transaction data
            const currentRemainingQuantity = parseFloat(position.remainingQuantity);
            const newRemainingQuantity = currentRemainingQuantity - tokensSold;
            
            // Calculate percentages
            const originalQuantity = parseFloat(position.quantity);
            const soldPercentageOfOriginal = (tokensSold / originalQuantity) * 100;
            const remainingPercentageOfOriginal = (newRemainingQuantity / originalQuantity) * 100;
            const soldPercentageOfRemaining = (tokensSold / currentRemainingQuantity) * 100;
    
            logger.info(`📊 POSITION UPDATE CALCULATIONS:`);
            logger.info(`   Original Quantity: ${originalQuantity.toLocaleString()} tokens`);
            logger.info(`   Previous Remaining: ${currentRemainingQuantity.toLocaleString()} tokens`);
            logger.info(`   Tokens Sold: ${tokensSold.toLocaleString()} tokens (${soldPercentageOfRemaining.toFixed(1)}% of remaining)`);
            logger.info(`   New Remaining: ${newRemainingQuantity.toLocaleString()} tokens (${remainingPercentageOfOriginal.toFixed(1)}% of original)`);
    
            // Update position with new remaining quantity
            const updatedPosition = {
                ...position,
                remainingQuantity: newRemainingQuantity.toString(),
                totalRealizedPnL: (position.totalRealizedPnL || 0) + pnl,
                partialSells: (position.partialSells || []).concat({
                    timestamp: Date.now(),
                    soldQuantity: tokensSold,
                    solReceived: solReceived,
                    pnl: pnl,
                    reason: reason,
                    signature: signature,
                    soldPercentageOfOriginal: soldPercentageOfOriginal,
                    soldPercentageOfRemaining: soldPercentageOfRemaining,
                    remainingAfterSell: newRemainingQuantity
                }),
                updatedAt: Date.now(),
                lastSellAt: Date.now(),
                status: newRemainingQuantity > 0.001 ? 'ACTIVE' : 'CLOSED' // Close if very small amount remaining
            };
    
            // Clear any pending transaction data since we're completing the transaction
            delete updatedPosition.pendingReason;
            delete updatedPosition.pendingSellPercentage;
            delete updatedPosition.pendingStartTime;
            delete updatedPosition.pendingTxHash;
            delete updatedPosition.pendingTokenAmount;
            updatedPosition.retryCount = 0;
            delete updatedPosition.lastRetryError;
            delete updatedPosition.lastRetryReason;
    
            // If position is effectively closed, handle it
            if (newRemainingQuantity <= 0.001 || remainingPercentageOfOriginal < 0.1) {
                logger.info(`✅ POSITION FULLY CLOSED: ${position.symbol}`);
                updatedPosition.status = 'CLOSED';
                updatedPosition.closedAt = Date.now();
                updatedPosition.closeReason = reason;
                updatedPosition.remainingQuantity = "0";
                
                // Move to trade history
                await this.movePositionToHistory(updatedPosition);
                this.positions.delete(positionId);
                
                this.emit('positionClosed', updatedPosition);
            } else {
                // Keep position active
                this.positions.set(positionId, updatedPosition);
                
                this.emit('partialSell', {
                    position: updatedPosition,
                    sellData: {
                        tokenAmount: tokensSold,
                        solReceived: solReceived,
                        pnl: pnl,
                        signature: signature,
                        reason: reason
                    },
                    remainingPercentage: remainingPercentageOfOriginal
                });
            }
    
            await this.savePositions();
    
            // 🔥 Send Telegram notification with EXACT transaction data
            if (this.telegramService && this.telegramService.isEnabled()) {
                try {
                    // Check if this was a take profit sell by looking at the reason
                    const tpMatch = reason.match(/Take Profit (\d+)/);
                    if (tpMatch) {
                        const tpLevel = parseInt(tpMatch[1]);
                        const gainPercentage = ((position.currentPrice - position.entryPrice) / position.entryPrice * 100);
                        
                        // Get trailing stop loss info if available
                        let trailingStopLoss = null;
                        if (position.pendingTakeProfitData && position.pendingTakeProfitData.trailingStopLoss) {
                            trailingStopLoss = position.pendingTakeProfitData.trailingStopLoss;
                        }
                        
                        const tpData = {
                            level: tpLevel,
                            triggerPrice: position.currentPrice,
                            gainPercentage: gainPercentage,
                            sellPercentage: soldPercentageOfRemaining,
                            tokensSold: tokensSold,
                            solReceived: solReceived,
                            transactionPnL: pnl,
                            priceSource: position.lastPriceSource,
                            executionMode: this.config.tradingMode,
                            trailingStopLoss: trailingStopLoss
                        };
    
                        await this.telegramService.sendTakeProfitAlert(updatedPosition, tpData);
                        
                        // Clear pending TP data after sending alert
                        if (updatedPosition.pendingTakeProfitData) {
                            delete updatedPosition.pendingTakeProfitData;
                            this.positions.set(positionId, updatedPosition);
                            await this.savePositions();
                        }
                    }
                } catch (error) {
                    logger.error('❌ Failed to send Telegram alert:', error.message);
                }
            }
    
            logger.info(`✅ POSITION UPDATE COMPLETED: ${position.symbol}`);
            logger.info(`   Total Realized PnL: ${updatedPosition.totalRealizedPnL.toFixed(6)} SOL`);
            logger.info(`   Remaining: ${newRemainingQuantity.toLocaleString()} tokens (${remainingPercentageOfOriginal.toFixed(1)}% of original)`);
            
        } catch (error) {
            logger.error(`❌ Failed to update position after sell: ${error.message}`);
            throw error;
        }
    }

    async moveToManualReview(position, reason) {
        logger.info(`🔧 DEBUG: Moving position ${position.symbol} (ID: ${position.id}) to manual review`);
        logger.info(`🔧 DEBUG: Position map size before: ${this.positions.size}`);
        
        position.status = 'MANUAL_REVIEW_NEEDED';
        position.reviewReason = reason;
        position.reviewCreatedAt = Date.now();
        
        await this.movePositionToHistory(position);
        
        // 🔥 DEBUG: Check if position exists before deleting
        if (this.positions.has(position.id)) {
            this.positions.delete(position.id);
            logger.info(`🔧 DEBUG: Position ${position.symbol} deleted from map`);
        } else {
            logger.error(`🔧 DEBUG: Position ${position.symbol} NOT FOUND in map! Keys: ${Array.from(this.positions.keys())}`);
        }
        
        logger.info(`🔧 DEBUG: Position map size after: ${this.positions.size}`);
        
        await this.savePositions();
        
        this.sessionStats.manualReviewCount++;
        logger.error(`⚠️ MANUAL REVIEW NEEDED: ${position.symbol} - ${reason}`);
        this.emit('manualReviewNeeded', position);
    }

    async verifyTokensAndRecoverPosition(position, failureReason) {
        try {
            logger.info(`🔍 VERIFYING: Checking if ${position.symbol} tokens actually exist in wallet`);
            
            // Step 1: Check actual token balance on-chain
            const currentBalance = await this.getActualTokenBalance(position.tokenAddress);
            
            if (currentBalance > 0) {
                logger.warn(`⚠️ Tokens still exist! Balance: ${currentBalance.toFixed(6)} - This shouldn't happen`);
                // Update position with correct balance and try again later
                position.remainingQuantity = currentBalance.toString();
                position.status = 'ACTIVE';
                position.lastError = failureReason;
                this.positions.set(position.id, position);
                await this.savePositions();
                return false; // Don't move to manual review yet
            }
            
            logger.info(`✅ CONFIRMED: No tokens in wallet - looking for sell transaction`);
            
            // Step 2: Find the actual sell transaction
            const sellTxData = await this.findLastSellTransaction(position.tokenAddress);
            
            if (!sellTxData) {
                logger.error(`❌ Could not find sell transaction for ${position.symbol}`);
                // Move to manual review as last resort
                await this.moveToManualReview(position, `Tokens not found and no sell transaction located: ${failureReason}`);
                return true;
            }
            
            logger.info(`🎯 FOUND SELL TRANSACTION: ${sellTxData.signature}`);
            logger.info(`   Tokens Sold: ${sellTxData.tokensSold.toLocaleString()}`);
            logger.info(`   SOL Received: ${sellTxData.solReceived.toFixed(6)} SOL`);
            logger.info(`   Transaction Time: ${new Date(sellTxData.timestamp).toLocaleString()}`);
            
            // Step 3: Close position with recovered data
            await this.closePositionWithRecoveredData(position, sellTxData);
            
            return true;
            
        } catch (error) {
            logger.error(`❌ Token verification failed for ${position.symbol}: ${error.message}`);
            // Fall back to manual review
            await this.moveToManualReview(position, `Verification failed: ${error.message}`);
            return true;
        }
    }
    
    async getActualTokenBalance(tokenAddress) {
        try {
            if (!this.tradingBot?.pumpSwapService?.connection) {
                throw new Error('No connection available');
            }
            
            const connection = this.tradingBot.pumpSwapService.connection;
            const mintPubkey = new PublicKey(tokenAddress);
            const tokenAccount = getAssociatedTokenAddressSync(mintPubkey, this.tradingBot.pumpSwapService.wallet.publicKey);
            
            const balance = await connection.getTokenAccountBalance(tokenAccount);
            return parseFloat(balance.value.amount) / Math.pow(10, balance.value.decimals);
            
        } catch (error) {
            // If account doesn't exist, balance is 0
            if (error.message.includes('could not find account')) {
                return 0;
            }
            logger.debug(`Token balance check error: ${error.message}`);
            return 0;
        }
    }
    
    async findLastSellTransaction(tokenAddress) {
        try {
            if (!this.tradingBot?.pumpSwapService?.connection) {
                throw new Error('No connection available');
            }
            
            const connection = this.tradingBot.pumpSwapService.connection;
            const walletPubkey = this.tradingBot.pumpSwapService.wallet.publicKey;
            
            logger.info(`🔍 Searching transaction history for ${tokenAddress} sells...`);
            
            // Get recent transaction signatures for the wallet
            const signatures = await connection.getSignaturesForAddress(walletPubkey, {
                limit: 50 // Check last 50 transactions
            });
            
            logger.info(`📊 Checking ${signatures.length} recent transactions...`);
            
            // Check each transaction for our token sell
            for (const sigInfo of signatures) {
                try {
                    const tx = await connection.getTransaction(sigInfo.signature, {
                        commitment: 'confirmed',
                        maxSupportedTransactionVersion: 0
                    });
                    
                    if (!tx || !tx.meta) continue;
                    
                    // Look for sell transaction patterns
                    const sellData = this.extractSellDataFromTransaction(tx, tokenAddress);
                    if (sellData) {
                        logger.info(`✅ Found sell transaction: ${sigInfo.signature}`);
                        return {
                            signature: sigInfo.signature,
                            timestamp: sigInfo.blockTime * 1000,
                            ...sellData
                        };
                    }
                    
                } catch (error) {
                    logger.debug(`Error checking transaction ${sigInfo.signature}: ${error.message}`);
                    continue;
                }
            }
            
            logger.warn(`❌ No sell transaction found in last ${signatures.length} transactions`);
            return null;
            
        } catch (error) {
            logger.error(`Error searching transaction history: ${error.message}`);
            return null;
        }
    }
    
    extractSellDataFromTransaction(tx, tokenAddress) {
        try {
            // Method 1: Check token balance changes
            const preTokenBalances = tx.meta.preTokenBalances || [];
            const postTokenBalances = tx.meta.postTokenBalances || [];
            
            // Find our token in pre/post balances
            const preBalance = preTokenBalances.find(balance => 
                balance.mint === tokenAddress && 
                balance.owner === this.tradingBot.pumpSwapService.wallet.publicKey.toString()
            );
            
            const postBalance = postTokenBalances.find(balance => 
                balance.mint === tokenAddress && 
                balance.owner === this.tradingBot.pumpSwapService.wallet.publicKey.toString()
            );
            
            if (preBalance && (!postBalance || postBalance.uiTokenAmount.uiAmount === 0)) {
                // Tokens decreased to zero - this is likely our sell
                const tokensSold = preBalance.uiTokenAmount.uiAmount;
                
                // Method 2: Look for SOL increase
                const preSOL = tx.meta.preBalances[0]; // Wallet is usually first account
                const postSOL = tx.meta.postBalances[0];
                const solReceived = (postSOL - preSOL) / 1e9; // Convert lamports to SOL
                
                if (tokensSold > 0 && solReceived > 0) {
                    logger.info(`📊 Extracted from balance changes: ${tokensSold} tokens → ${solReceived.toFixed(6)} SOL`);
                    return {
                        tokensSold: tokensSold,
                        solReceived: solReceived,
                        method: 'balance_analysis'
                    };
                }
            }
            
            // Method 3: Parse event data from logs (if available)
            const eventData = this.parseEventDataFromLogs(tx.meta.logMessages || [], 'sell');
            if (eventData) {
                logger.info(`📊 Extracted from event data: ${eventData.tokensSold} tokens → ${eventData.solReceived.toFixed(6)} SOL`);
                return eventData;
            }
            
            return null;
            
        } catch (error) {
            logger.debug(`Error extracting sell data: ${error.message}`);
            return null;
        }
    }
    
    parseEventDataFromLogs(logMessages, eventType) {
        try {
            // Use the same event parsing logic from your PumpSwapService
            const sellEventDiscriminator = [62, 47, 55, 10, 165, 3, 220, 42];
            
            const programDataLogs = logMessages.filter(log => 
                log.startsWith('Program data:')
            );
            
            for (const log of programDataLogs) {
                try {
                    const dataString = log.substring('Program data: '.length).trim();
                    if (!dataString || dataString.length < 20) continue;
                    
                    const eventData = Buffer.from(dataString, 'base64');
                    if (eventData.length < 8) continue;
                    
                    const discriminator = Array.from(eventData.slice(0, 8));
                    
                    if (this.arraysEqual(discriminator, sellEventDiscriminator)) {
                        return this.parseSellEventFromBuffer(eventData);
                    }
                    
                } catch (parseError) {
                    continue;
                }
            }
            
            return null;
            
        } catch (error) {
            logger.debug(`Error parsing event data: ${error.message}`);
            return null;
        }
    }
    
    parseSellEventFromBuffer(eventData) {
        try {
            let offset = 8; // Skip discriminator
            
            const timestamp = eventData.readBigInt64LE(offset); offset += 8;
            const baseAmountIn = eventData.readBigUInt64LE(offset); offset += 8;
            const minQuoteAmountOut = eventData.readBigUInt64LE(offset); offset += 8;
            
            // Skip user reserves
            offset += 16; // userBaseTokenReserves + userQuoteTokenReserves
            
            // Skip pool reserves  
            offset += 16; // poolBaseTokenReserves + poolQuoteTokenReserves
            
            const quoteAmountOut = eventData.readBigUInt64LE(offset); offset += 8;
            const lpFeeBasisPoints = eventData.readBigUInt64LE(offset); offset += 8;
            const lpFee = eventData.readBigUInt64LE(offset); offset += 8;
            const protocolFeeBasisPoints = eventData.readBigUInt64LE(offset); offset += 8;
            const protocolFee = eventData.readBigUInt64LE(offset); offset += 8;
            const quoteAmountOutWithoutLpFee = eventData.readBigUInt64LE(offset); offset += 8;
            const userQuoteAmountOut = eventData.readBigUInt64LE(offset); offset += 8;
            
            return {
                tokensSold: Number(baseAmountIn) / 1e6,
                solReceived: Number(userQuoteAmountOut) / 1e9,
                method: 'event_parsing'
            };
            
        } catch (error) {
            logger.debug(`Error parsing sell event buffer: ${error.message}`);
            return null;
        }
    }
    
    arraysEqual(a, b) {
        return a.length === b.length && a.every((val, i) => val === b[i]);
    }
    
    async closePositionWithRecoveredData(position, sellTxData) {
        try {
            logger.info(`🔄 CLOSING POSITION with recovered data: ${position.symbol}`);
            
            // Calculate PnL based on recovered data
            const originalInvestment = position.investedAmount;
            const pnl = sellTxData.solReceived - originalInvestment;
            const pnlPercentage = (pnl / originalInvestment) * 100;
            
            const finalPosition = {
                ...position,
                remainingQuantity: "0",
                status: 'CLOSED',
                closedAt: sellTxData.timestamp,
                closeReason: 'Recovered from blockchain data',
                finalTxHash: sellTxData.signature,
                solReceived: sellTxData.solReceived,
                finalPnL: pnl,
                recoveredData: true,
                recoveryMethod: sellTxData.method,
                updatedAt: Date.now()
            };
    
            // Update session stats
            this.sessionStats.sessionPnL += pnl;
            this.sessionStats.liveSellsExecuted++;
            
            // Move to trade history
            await this.movePositionToHistory(finalPosition);
            this.positions.delete(position.id);
            await this.savePositions();
            
            logger.info(`✅ POSITION RECOVERED & CLOSED: ${position.symbol}`);
            logger.info(`   Recovery Method: ${sellTxData.method}`);
            logger.info(`   Tokens Sold: ${sellTxData.tokensSold.toLocaleString()}`);
            logger.info(`   SOL Received: ${sellTxData.solReceived.toFixed(6)} SOL`);
            logger.info(`   Final PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPercentage >= 0 ? '+' : ''}${pnlPercentage.toFixed(1)}%)`);
            logger.info(`   Transaction: ${sellTxData.signature}`);
            
            // Send telegram notification for recovered position
            if (this.telegramService && this.telegramService.isEnabled()) {
                try {
                    await this.telegramService.sendRecoveredPositionAlert(finalPosition, sellTxData);
                } catch (error) {
                    logger.error('❌ Failed to send Telegram recovery alert:', error.message);
                }
            }
            
            this.emit('positionRecovered', {
                position: finalPosition,
                sellData: sellTxData
            });
            
        } catch (error) {
            logger.error(`❌ Failed to close position with recovered data: ${error.message}`);
            throw error;
        }
    }
    

    // Enhanced stop loss check that respects pending status
    async checkStopLossWithLiveExecution(position) {
        if (!position.stopLossPrice || !position.currentPrice) return;
        if (position.status !== 'ACTIVE') return; // Don't trigger if pending
        
        if (position.currentPrice <= position.stopLossPrice) {
            const lossPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice * 100);
            
            logger.warn(`🛑 STOP LOSS TRIGGERED: ${position.symbol} at ${position.currentPrice.toFixed(8)} SOL (${lossPercent.toFixed(1)}%)`);
            
            try {
                await this.executePumpSwapSell(position, 100, `Stop Loss (${lossPercent.toFixed(1)}%)`);
                this.sessionStats.stopLossTriggered++;
                this.sessionStats.stopLossExecutions++;
                
                const slEventData = {
                    position: position,
                    triggerPrice: position.currentPrice,
                    lossPercentage: Math.abs(lossPercent),
                    priceSource: position.lastPriceSource,
                    executionMode: this.config.tradingMode
                };
                
                // 🔥 NEW: Send Telegram notification for stop loss
                if (this.telegramService && this.telegramService.isEnabled()) {
                    try {
                        await this.telegramService.sendStopLossAlert(position, slEventData);
                    } catch (error) {
                        logger.error('❌ Failed to send Telegram stop loss alert:', error.message);
                    }
                }
                
                this.emit('stopLossTriggered', slEventData);
                
            } catch (error) {
                logger.error(`❌ Stop loss execution failed for ${position.symbol}: ${error.message}`);
            }
        }
    }

    async checkTakeProfitsWithLiveExecution(position) {
        if (!position.takeProfitLevels || !position.currentPrice) return;
        if (position.status !== 'ACTIVE') return; // Don't trigger if pending
        
        for (const tp of position.takeProfitLevels) {
            if (tp.triggered || !tp.targetPrice) continue;
            
            if (position.currentPrice >= tp.targetPrice) {
                const gainPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice * 100);
                
                logger.info(`🎯 TAKE PROFIT ${tp.level} TRIGGERED: ${position.symbol} at ${position.currentPrice.toFixed(8)} SOL (+${gainPercent.toFixed(1)}%)`);
                
                tp.triggered = true;
                
                try {
                    await this.executePumpSwapSell(position, tp.sellPercentage, `Take Profit ${tp.level} (+${gainPercent.toFixed(1)}%)`);
                    this.sessionStats.takeProfitTriggered++;
                    this.sessionStats.takeProfitExecutions++;
                    
                    // 🔥 TRAILING STOP LOSS IMPLEMENTATION
                    let newStopLossPrice = position.stopLossPrice;
                    let stopLossInfo = '';
                    const oldStopLoss = position.stopLossPrice;
                    
                    switch(tp.level) {
                        case 1: // TP1 at +100% - Move SL to entry price (breakeven)
                            newStopLossPrice = position.entryPrice;
                            stopLossInfo = 'moved to breakeven (entry price)';
                            logger.info(`📈 TRAILING STOP: ${position.symbol} SL moved to breakeven @ ${newStopLossPrice.toFixed(8)} SOL`);
                            break;
                            
                        case 2: // TP2 at +300% - Move SL to +100% gain
                            newStopLossPrice = position.entryPrice * 2.0; // +100% gain
                            stopLossInfo = 'moved to +100% gain';
                            logger.info(`📈 TRAILING STOP: ${position.symbol} SL moved to +100% @ ${newStopLossPrice.toFixed(8)} SOL`);
                            break;
                            
                        case 3: // TP3 at +900% - Move SL to +500% gain
                            newStopLossPrice = position.entryPrice * 6.0; // +500% gain
                            stopLossInfo = 'moved to +500% gain';
                            logger.info(`📈 TRAILING STOP: ${position.symbol} SL moved to +500% @ ${newStopLossPrice.toFixed(8)} SOL`);
                            break;
                    }
                    
                    // Update the stop loss price if it changed
                    if (newStopLossPrice !== position.stopLossPrice) {
                        position.stopLossPrice = newStopLossPrice;
                        
                        // Save the updated position
                        this.positions.set(position.id, position);
                        await this.savePositions();
                        
                        logger.info(`🛡️ STOP LOSS UPDATED: ${position.symbol} from ${oldStopLoss.toFixed(8)} SOL to ${newStopLossPrice.toFixed(8)} SOL (${stopLossInfo})`);
                    }
                    
                    const tpEventData = {
                        position: position,
                        level: tp.level,
                        triggerPrice: position.currentPrice,
                        gainPercentage: gainPercent,
                        sellPercentage: tp.sellPercentage,
                        priceSource: position.lastPriceSource,
                        executionMode: this.config.tradingMode,
                        // Add trailing stop loss info to the event
                        trailingStopLoss: {
                            oldStopLoss: oldStopLoss,
                            newStopLoss: newStopLossPrice,
                            stopLossInfo: stopLossInfo
                        }
                    };
                    
                    // 🔥 NEW: Send Telegram notification for take profit
                    if (this.telegramService && this.telegramService.isEnabled()) {
                        try {
                            await this.telegramService.sendTakeProfitAlert(position, tpEventData);
                        } catch (error) {
                            logger.error('❌ Failed to send Telegram take profit alert:', error.message);
                        }
                    }
                    
                    this.emit('takeProfitTriggered', tpEventData);
                    
                } catch (error) {
                    logger.error(`❌ Take profit ${tp.level} execution failed for ${position.symbol}: ${error.message}`);
                    tp.triggered = false; // Reset on error
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
            status: 'ACTIVE', // Always start as ACTIVE
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
            }],
            retryCount: 0
        };
        
        this.positions.set(position.id, enhancedPosition);
        await this.savePositions();
        
        logger.info(`📈 Position created: ${position.symbol} [ACTIVE]`);

        // 🔥 NEW: Send Telegram notification for new position
        try {
            await this.telegramService.sendNewPositionAlert(enhancedPosition, position.alertData || {});
        } catch (error) {
            logger.error('❌ Failed to send Telegram new position alert:', error.message);
        }
        
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

    // Move completed position to trade history
    async movePositionToHistory(closedPosition) {
        try {
            // Create simplified trade record
            const trade = {
                id: closedPosition.id,
                tokenAddress: closedPosition.tokenAddress,
                symbol: closedPosition.symbol,
                entryTime: closedPosition.entryTime || closedPosition.createdAt,
                exitTime: closedPosition.closedAt || Date.now(),
                entryPrice: closedPosition.entryPrice,
                exitPrice: closedPosition.currentPrice || closedPosition.entryPrice,
                quantity: closedPosition.quantity,
                investedAmount: closedPosition.investedAmount,
                pnl: closedPosition.finalPnL || 0,
                pnlPercentage: closedPosition.finalPnL ? 
                    ((closedPosition.finalPnL / closedPosition.investedAmount) * 100) : 0,
                exitReason: closedPosition.closeReason || closedPosition.reviewReason,
                duration: (closedPosition.closedAt || Date.now()) - (closedPosition.entryTime || closedPosition.createdAt),
                entryTxHash: closedPosition.txHash,
                exitTxHash: closedPosition.finalTxHash,
                eventType: closedPosition.eventType,
                twitterLikes: closedPosition.alert?.twitter?.likes,
                priceSource: closedPosition.lastPriceSource,
                status: closedPosition.status, // CLOSED or MANUAL_REVIEW_NEEDED
                retryCount: closedPosition.retryCount || 0,
                reviewReason: closedPosition.reviewReason
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
            const closedTrades = tradesHistory.trades.filter(t => t.status === 'CLOSED');
            tradesHistory.summary.totalTrades = closedTrades.length;
            tradesHistory.summary.totalPnL = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
            const profitableTrades = closedTrades.filter(t => (t.pnl || 0) > 0).length;
            tradesHistory.summary.winRate = closedTrades.length > 0 ? 
                (profitableTrades / closedTrades.length * 100) : 0;
            tradesHistory.summary.lastUpdated = new Date().toISOString();
            
            // Count manual reviews
            const manualReviews = tradesHistory.trades.filter(t => t.status === 'MANUAL_REVIEW_NEEDED').length;
            tradesHistory.summary.manualReviews = manualReviews;

            // Save trade history
            const historyPath = path.resolve(this.config.tradesHistoryFile);
            await fs.writeFile(historyPath, JSON.stringify(tradesHistory, null, 2));
            
            const statusText = closedPosition.status === 'MANUAL_REVIEW_NEEDED' ? 'for manual review' : 'as closed';
            logger.info(`💾 Trade moved to history ${statusText}: ${closedPosition.symbol} (${tradesHistory.trades.length} total)`);
            
        } catch (error) {
            logger.error('❌ Failed to move position to trade history:', error.message);
            // Don't throw - we don't want to break position closing if history fails
        }
    }

    // Get performance summary
    getPerformanceStats() {
        const activePositions = this.getActivePositions();
        const pendingPositions = this.getPendingPositions();
        
        const totalInvested = activePositions.reduce((sum, pos) => {
            const ratio = parseFloat(pos.remainingQuantity) / parseFloat(pos.quantity);
            return sum + (pos.investedAmount * ratio);
        }, 0);
        
        const totalUnrealizedPnL = activePositions.reduce((sum, pos) => sum + (pos.unrealizedPnL || 0), 0);

        // Calculate price source distribution
        const allPositions = [...activePositions, ...pendingPositions];
        const poolBasedPositions = allPositions.filter(pos => pos.lastPriceSource === 'pool_based').length;
        const fallbackPositions = allPositions.filter(pos => pos.lastPriceSource === 'fallback').length;

        return {
            activePositions: activePositions.length,
            pendingPositions: pendingPositions.length,
            totalPositions: this.positions.size,
            totalInvested: totalInvested.toFixed(4) + ' SOL',
            totalUnrealizedPnL: totalUnrealizedPnL.toFixed(4) + ' SOL',
            availableSlots: this.config.maxPositions - this.positions.size,
            
            // Session stats
            sessionStats: {
                ...this.sessionStats,
                sessionPnL: this.sessionStats.sessionPnL.toFixed(6) + ' SOL',
                confirmationRate: this.sessionStats.confirmationChecks > 0 ? 
                    ((this.sessionStats.confirmationSuccesses / this.sessionStats.confirmationChecks) * 100).toFixed(1) + '%' : '0%'
            },
            
            currentPriceSources: {
                poolBased: poolBasedPositions,
                fallback: fallbackPositions,
                unknown: allPositions.length - poolBasedPositions - fallbackPositions
            }
        };
    }

    // Save only active and pending positions
    async savePositions() {
        try {
            const data = {
                active: Object.fromEntries(this.positions),
                sessionStats: this.sessionStats,
                priceUpdateStats: this.priceUpdateStats,
                lastSaved: new Date().toISOString(),
                positionCount: this.positions.size
            };
            
            await fs.writeFile(path.resolve(this.config.positionsFile), JSON.stringify(data, null, 2));
        } catch (error) {
            logger.error('Save positions failed:', error);
        }
    }

    // Load only active and pending positions
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
            
            const activeCount = this.getActivePositions().length;
            const pendingCount = this.getPendingPositions().length;
            
            logger.info(`📊 Loaded ${this.positions.size} positions (${activeCount} active, ${pendingCount} pending)`);
            
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

    // Helper methods - filter by status
    hasPosition(tokenAddress) {
        return Array.from(this.positions.values()).some(pos => pos.tokenAddress === tokenAddress);
    }

    getActivePositions() {
        return Array.from(this.positions.values()).filter(pos => pos.status === 'ACTIVE');
    }

    getPendingPositions() {
        return Array.from(this.positions.values()).filter(pos => pos.status === 'PENDING_SELL');
    }

    getAllPositions() {
        return Array.from(this.positions.values());
    }

    getActivePositionsCount() {
        return this.getActivePositions().length;
    }

    // Manual intervention methods
    async forceClosePosition(positionId, reason = 'Force Close') {
        const position = this.positions.get(positionId);
        if (!position) throw new Error(`Position ${positionId} not found`);
        
        logger.warn(`⚠️ Force closing position: ${position.symbol} - ${reason}`);
        
        // Force move to closed status
        position.status = 'CLOSED';
        position.closedAt = Date.now();
        position.closeReason = reason;
        position.forceClosed = true;
        position.finalPnL = position.unrealizedPnL || 0;
        
        await this.movePositionToHistory(position);
        this.positions.delete(positionId);
        
        await this.savePositions();
        
        logger.warn(`⚠️ FORCE CLOSED: ${position.symbol} - ${reason}`);
    }

    // Emergency stop all positions
    async emergencyStopAllPositions(reason = 'Emergency Stop') {
        const allPositions = this.getAllPositions();
        
        if (allPositions.length === 0) {
            logger.info('No positions to stop');
            return;
        }
        
        logger.warn(`🚨 EMERGENCY STOP: Processing ${allPositions.length} positions - ${reason}`);
        
        const results = [];
        
        for (const position of allPositions) {
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
}

module.exports = PositionManager;