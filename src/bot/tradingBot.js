// src/bot/tradingBot.js - Core Trading Bot with Conservative Strategy
const { PumpAmmSdk, Direction } = require('@pump-fun/pump-swap-sdk');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const Big = require('big.js');

class TradingBot extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            tradingMode: config.tradingMode || 'paper',
            initialInvestment: config.initialInvestment || 0.1,
            stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE) || 50,
            takeProfitLevels: [
                {
                    percentage: parseFloat(process.env.TAKE_PROFIT_1_PERCENTAGE) || 100, // 2x
                    sellPercentage: parseFloat(process.env.TAKE_PROFIT_1_SELL_PERCENTAGE) || 50 // Sell 50%
                },
                {
                    percentage: parseFloat(process.env.TAKE_PROFIT_2_PERCENTAGE) || 300, // 4x
                    sellPercentage: parseFloat(process.env.TAKE_PROFIT_2_SELL_PERCENTAGE) || 25 // Sell 25%
                }
            ],
            slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 5,
            ...config
        };

        // Initialize Solana connection and wallet
        this.connection = new Connection(
            process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL,
            'confirmed'
        );

        this.wallet = this.initializeWallet();
        this.pumpSdk = new PumpAmmSdk();
        
        this.positionManager = config.positionManager;
        this.riskManager = config.riskManager;
        
        this.isTradingEnabled = true;
        this.isInitialized = false;
        
        // Trading statistics
        this.stats = {
            alertsProcessed: 0,
            tradesExecuted: 0,
            buyOrders: 0,
            sellOrders: 0,
            profitableTrades: 0,
            totalPnL: 0,
            totalVolume: 0,
            errors: 0
        };

        this.initialize();
    }

    initializeWallet() {
        try {
            const privateKeyString = process.env.PRIVATE_KEY;
            if (!privateKeyString) {
                throw new Error('PRIVATE_KEY environment variable is required');
            }

            // Support both base58 and array formats
            let privateKeyArray;
            try {
                // Try parsing as JSON array first
                privateKeyArray = JSON.parse(privateKeyString);
            } catch {
                // Assume it's base58 encoded
                const bs58 = require('bs58');
                privateKeyArray = bs58.decode(privateKeyString);
            }

            const wallet = Keypair.fromSecretKey(new Uint8Array(privateKeyArray));
            logger.info(`💼 Wallet initialized: ${wallet.publicKey.toString()}`);
            
            return wallet;
        } catch (error) {
            logger.error('❌ Failed to initialize wallet:', error);
            throw new Error('Failed to initialize wallet. Check your PRIVATE_KEY configuration.');
        }
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing trading bot...');
            
            // Check wallet balance
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const solBalance = balance / 1e9;
            
            logger.info(`💰 Wallet balance: ${solBalance.toFixed(4)} SOL`);
            
            if (solBalance < this.config.initialInvestment) {
                logger.warn(`⚠️ Low wallet balance! Required: ${this.config.initialInvestment} SOL, Available: ${solBalance.toFixed(4)} SOL`);
                
                if (this.config.tradingMode === 'live') {
                    throw new Error('Insufficient SOL balance for trading');
                }
            }

            this.isInitialized = true;
            logger.info('✅ Trading bot initialized successfully');
            
        } catch (error) {
            logger.error('❌ Failed to initialize trading bot:', error);
            throw error;
        }
    }

    async processAlert(alert) {
        if (!this.isTradingEnabled) {
            logger.debug('Trading is disabled, skipping alert');
            return;
        }

        if (!this.isInitialized) {
            logger.warn('Trading bot not initialized, skipping alert');
            return;
        }

        try {
            this.stats.alertsProcessed++;
            logger.info(`🔔 Processing alert: ${alert.token.symbol} (${alert.confidence})`);

            // Risk management checks
            const riskCheck = await this.riskManager.checkAlert(alert);
            if (!riskCheck.approved) {
                logger.info(`🚫 Alert rejected by risk management: ${riskCheck.reason}`);
                return;
            }

            // Check if we already have a position in this token
            if (this.positionManager.hasPosition(alert.token.address)) {
                logger.info(`⏭️ Already have position in ${alert.token.symbol}, skipping`);
                return;
            }

            // Execute initial buy
            await this.executeBuy(alert);

        } catch (error) {
            logger.error(`❌ Error processing alert for ${alert.token.symbol}:`, error);
            this.stats.errors++;
        }
    }

    async executeBuy(alert) {
        try {
            const tokenAddress = alert.token.address;
            const symbol = alert.token.symbol;
            const investmentAmount = this.calculateInvestmentAmount(alert);
            
            logger.info(`💰 Executing BUY: ${investmentAmount} SOL → ${symbol}`);

            if (this.config.tradingMode === 'paper') {
                return await this.executePaperBuy(alert, investmentAmount);
            }

            // Get pool information
            const pool = await this.findTokenPool(tokenAddress);
            if (!pool) {
                throw new Error(`No pool found for token ${symbol}`);
            }

            // Calculate expected tokens
            const expectedTokens = await this.pumpSdk.swapAutocompleteBaseFromQuote(
                pool,
                new Big(investmentAmount),
                this.config.slippageTolerance,
                Direction.QuoteToBase
            );

            // Create swap instructions
            const swapInstructions = await this.pumpSdk.swapInstructions(
                pool,
                expectedTokens,
                this.config.slippageTolerance,
                Direction.QuoteToBase,
                this.wallet.publicKey
            );

            // Execute transaction
            const transaction = this.transactionFromInstructions(swapInstructions);
            const signature = await this.sendAndConfirmTransaction(transaction);

            // Record position
            const position = {
                id: this.generatePositionId(),
                tokenAddress,
                symbol,
                side: 'LONG',
                entryPrice: this.calculateEntryPrice(pool, investmentAmount, expectedTokens),
                quantity: expectedTokens.toString(),
                investedAmount: investmentAmount,
                entryTime: Date.now(),
                txHash: signature,
                stopLoss: this.calculateStopLoss(investmentAmount),
                takeProfitLevels: this.calculateTakeProfitLevels(investmentAmount),
                remainingQuantity: expectedTokens.toString(),
                alert: alert
            };

            await this.positionManager.addPosition(position);

            this.stats.tradesExecuted++;
            this.stats.buyOrders++;
            this.stats.totalVolume += investmentAmount;

            logger.info(`✅ BUY executed: ${expectedTokens} ${symbol} for ${investmentAmount} SOL (${signature})`);
            
            this.emit('tradeExecuted', {
                type: 'BUY',
                symbol,
                amount: expectedTokens.toString(),
                price: position.entryPrice,
                signature
            });

            return position;

        } catch (error) {
            logger.error(`❌ Buy execution failed for ${alert.token.symbol}:`, error);
            this.stats.errors++;
            throw error;
        }
    }

    async executePaperBuy(alert, investmentAmount) {
        // Simulate paper trading
        const mockPrice = Math.random() * 0.001 + 0.0001; // Mock token price
        const expectedTokens = investmentAmount / mockPrice;
        
        const position = {
            id: this.generatePositionId(),
            tokenAddress: alert.token.address,
            symbol: alert.token.symbol,
            side: 'LONG',
            entryPrice: mockPrice,
            quantity: expectedTokens.toString(),
            investedAmount: investmentAmount,
            entryTime: Date.now(),
            txHash: 'PAPER_TRADE_' + Date.now(),
            stopLoss: this.calculateStopLoss(investmentAmount),
            takeProfitLevels: this.calculateTakeProfitLevels(investmentAmount),
            remainingQuantity: expectedTokens.toString(),
            alert: alert,
            paperTrade: true
        };

        await this.positionManager.addPosition(position);

        this.stats.tradesExecuted++;
        this.stats.buyOrders++;
        this.stats.totalVolume += investmentAmount;

        logger.info(`📝 PAPER BUY: ${expectedTokens.toFixed(2)} ${alert.token.symbol} for ${investmentAmount} SOL`);
        
        this.emit('tradeExecuted', {
            type: 'PAPER_BUY',
            symbol: alert.token.symbol,
            amount: expectedTokens.toString(),
            price: mockPrice,
            signature: position.txHash
        });

        return position;
    }

    async executeSell(position, sellQuantity, reason = 'Manual') {
        try {
            const sellAmount = new Big(sellQuantity);
            
            logger.info(`💸 Executing SELL: ${sellAmount} ${position.symbol} (${reason})`);

            if (position.paperTrade || this.config.tradingMode === 'paper') {
                return await this.executePaperSell(position, sellAmount, reason);
            }

            // Get current pool
            const pool = await this.findTokenPool(position.tokenAddress);
            if (!pool) {
                throw new Error(`No pool found for token ${position.symbol}`);
            }

            // Calculate expected SOL
            const expectedSol = await this.pumpSdk.swapAutocompleteQuoteFromBase(
                pool,
                sellAmount,
                this.config.slippageTolerance,
                Direction.BaseToQuote
            );

            // Create swap instructions
            const swapInstructions = await this.pumpSdk.swapInstructions(
                pool,
                sellAmount,
                this.config.slippageTolerance,
                Direction.BaseToQuote,
                this.wallet.publicKey
            );

            // Execute transaction
            const transaction = this.transactionFromInstructions(swapInstructions);
            const signature = await this.sendAndConfirmTransaction(transaction);

            // Calculate PnL
            const soldValue = parseFloat(expectedSol.toString());
            const costBasis = (parseFloat(sellAmount.toString()) / parseFloat(position.quantity)) * position.investedAmount;
            const pnl = soldValue - costBasis;

            // Update position
            const updatedPosition = await this.positionManager.updatePositionAfterSell(
                position.id,
                sellAmount.toString(),
                soldValue,
                pnl,
                signature,
                reason
            );

            this.stats.sellOrders++;
            this.stats.totalVolume += soldValue;
            this.stats.totalPnL += pnl;
            
            if (pnl > 0) {
                this.stats.profitableTrades++;
            }

            logger.info(`✅ SELL executed: ${sellAmount} ${position.symbol} for ${soldValue} SOL (PnL: ${pnl.toFixed(4)}) [${signature}]`);
            
            this.emit('tradeExecuted', {
                type: 'SELL',
                symbol: position.symbol,
                amount: sellAmount.toString(),
                value: soldValue,
                pnl,
                signature
            });

            // Check if position is fully closed
            if (parseFloat(updatedPosition.remainingQuantity) <= 0) {
                this.emit('positionClosed', {
                    symbol: position.symbol,
                    pnl: updatedPosition.totalPnL,
                    holdTime: Date.now() - position.entryTime
                });
            }

            return { soldValue, pnl, signature };

        } catch (error) {
            logger.error(`❌ Sell execution failed for ${position.symbol}:`, error);
            this.stats.errors++;
            throw error;
        }
    }

    async executePaperSell(position, sellAmount, reason) {
        // Simulate current price movement
        const priceChange = (Math.random() - 0.5) * 0.4; // ±20% random movement
        const currentPrice = position.entryPrice * (1 + priceChange);
        const soldValue = parseFloat(sellAmount.toString()) * currentPrice;
        
        const costBasis = (parseFloat(sellAmount.toString()) / parseFloat(position.quantity)) * position.investedAmount;
        const pnl = soldValue - costBasis;

        const signature = 'PAPER_SELL_' + Date.now();

        // Update position
        const updatedPosition = await this.positionManager.updatePositionAfterSell(
            position.id,
            sellAmount.toString(),
            soldValue,
            pnl,
            signature,
            reason
        );

        this.stats.sellOrders++;
        this.stats.totalVolume += soldValue;
        this.stats.totalPnL += pnl;
        
        if (pnl > 0) {
            this.stats.profitableTrades++;
        }

        logger.info(`📝 PAPER SELL: ${sellAmount} ${position.symbol} for ${soldValue.toFixed(4)} SOL (PnL: ${pnl.toFixed(4)})`);

        this.emit('tradeExecuted', {
            type: 'PAPER_SELL',
            symbol: position.symbol,
            amount: sellAmount.toString(),
            value: soldValue,
            pnl,
            signature
        });

        if (parseFloat(updatedPosition.remainingQuantity) <= 0) {
            this.emit('positionClosed', {
                symbol: position.symbol,
                pnl: updatedPosition.totalPnL,
                holdTime: Date.now() - position.entryTime
            });
        }

        return { soldValue, pnl, signature };
    }

    calculateInvestmentAmount(alert) {
        // Base investment amount
        let amount = this.config.initialInvestment;
        
        // Adjust based on confidence level
        switch (alert.confidence) {
            case 'HIGH':
                amount *= 1.5;
                break;
            case 'MEDIUM':
                amount *= 1.0;
                break;
            case 'LOW':
                amount *= 0.7;
                break;
            case 'VERY_LOW':
                amount *= 0.5;
                break;
        }

        // Adjust based on Twitter engagement
        if (alert.twitter.likes >= 1000) amount *= 1.2;
        if (alert.twitter.views >= 1000000) amount *= 1.3;

        // Reduce for risk factors
        if (alert.analysis.bundleDetected) amount *= 0.8;
        if (alert.analysis.riskLevel === 'HIGH') amount *= 0.7;

        // Cap the maximum investment
        return Math.min(amount, this.config.initialInvestment * 2);
    }

    calculateStopLoss(investedAmount) {
        return investedAmount * (1 - this.config.stopLossPercentage / 100);
    }

    calculateTakeProfitLevels(investedAmount) {
        return this.config.takeProfitLevels.map(level => ({
            targetValue: investedAmount * (1 + level.percentage / 100),
            sellPercentage: level.sellPercentage,
            triggered: false
        }));
    }

    calculateEntryPrice(pool, investedAmount, expectedTokens) {
        // Simplified price calculation
        return investedAmount / parseFloat(expectedTokens.toString());
    }

    generatePositionId() {
        return 'pos_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    async findTokenPool(tokenAddress) {
        // This would need to be implemented based on the PumpAmmSdk documentation
        // For now, we'll return a mock pool structure
        logger.warn('findTokenPool not implemented - using mock pool');
        return {
            address: 'mock_pool_' + tokenAddress,
            baseMint: tokenAddress,
            quoteMint: 'So11111111111111111111111111111111111111112' // SOL
        };
    }

    transactionFromInstructions(instructions) {
        // Helper method to build transaction from instructions
        // Implementation depends on Solana web3.js patterns
        logger.warn('transactionFromInstructions not fully implemented');
        return null;
    }

    async sendAndConfirmTransaction(transaction) {
        // Send and confirm transaction
        // Implementation depends on your preference for confirmation levels
        logger.warn('sendAndConfirmTransaction not fully implemented');
        return 'mock_signature_' + Date.now();
    }

    pauseTrading() {
        this.isTradingEnabled = false;
        logger.info('⏸️ Trading paused');
    }

    resumeTrading() {
        this.isTradingEnabled = true;
        logger.info('▶️ Trading resumed');
    }

    isTradingEnabled() {
        return this.isTradingEnabled;
    }

    getStats() {
        const winRate = this.stats.tradesExecuted > 0 ? 
            (this.stats.profitableTrades / this.stats.tradesExecuted * 100).toFixed(1) : '0';

        return {
            ...this.stats,
            winRate: winRate + '%',
            avgPnL: this.stats.tradesExecuted > 0 ? 
                (this.stats.totalPnL / this.stats.tradesExecuted).toFixed(4) : '0',
            config: {
                mode: this.config.tradingMode,
                initialInvestment: this.config.initialInvestment,
                stopLoss: this.config.stopLossPercentage + '%',
                takeProfits: this.config.takeProfitLevels.map(tp => 
                    `${tp.percentage}% (sell ${tp.sellPercentage}%)`
                )
            }
        };
    }

    async stop() {
        this.pauseTrading();
        logger.info('🛑 Trading bot stopped');
    }
}

module.exports = TradingBot;