// scripts/liveTrade.js - Execute REAL trades with SOL
require('dotenv').config();
const logger = require('../src/utils/logger');
const TradingBot = require('../src/bot/tradingBot');
const PositionManager = require('../src/bot/positionManager');

class LiveTrader {
    constructor() {
        // 🔥 FORCE LIVE MODE
        this.config = {
            tradingMode: 'live', // Force live trading
            initialInvestment: parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.1,
            privateKey: process.env.PRIVATE_KEY,
            stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE) || 50,
            takeProfitLevels: [
                { percentage: 100, sellPercentage: 50 },  // 2x - sell 50%
                { percentage: 300, sellPercentage: 25 },  // 4x - sell 25% 
                { percentage: 900, sellPercentage: 100 }  // 10x - sell rest
            ]
        };

        if (!this.config.privateKey) {
            throw new Error('PRIVATE_KEY required for live trading!');
        }

        this.positionManager = new PositionManager({
            tradingMode: 'live',
            maxPositions: 10,
            // Enhanced price monitoring for live trades
            fastUpdateInterval: 500,
            normalUpdateInterval: 1000,
            slowUpdateInterval: 2000
        });

        this.tradingBot = new TradingBot({
            tradingMode: 'live',
            positionManager: this.positionManager,
            initialInvestment: this.config.initialInvestment,
            privateKey: this.config.privateKey
        });

        this.setupEventHandlers();
    }

    setupEventHandlers() {
        this.tradingBot.on('tradeExecuted', (tradeData) => {
            logger.info(`🚀 LIVE TRADE EXECUTED:`);
            logger.info(`   • Type: ${tradeData.type}`);
            logger.info(`   • Token: ${tradeData.symbol}`);
            logger.info(`   • Amount: ${tradeData.amount}`);
            logger.info(`   • Price: ${tradeData.price} SOL`);
            logger.info(`   • Signature: ${tradeData.signature}`);
        });

        this.positionManager.on('positionAdded', (position) => {
            logger.info(`📈 LIVE POSITION CREATED:`);
            logger.info(`   • Token: ${position.symbol}`);
            logger.info(`   • Entry Price: ${position.entryPrice} SOL`);
            logger.info(`   • Quantity: ${parseFloat(position.quantity).toFixed(2)}`);
            logger.info(`   • Investment: ${position.investedAmount} SOL`);
            logger.info(`   • Stop Loss: ${position.stopLoss} SOL`);
            logger.info(`   • Take Profits: ${position.takeProfitLevels.length} levels`);
        });

        this.positionManager.on('positionClosed', (position) => {
            logger.info(`📉 POSITION CLOSED:`);
            logger.info(`   • Token: ${position.symbol}`);
            logger.info(`   • PnL: ${position.totalPnL} SOL`);
            logger.info(`   • Reason: ${position.closeReason}`);
        });
    }

    async initialize() {
        try {
            logger.info('🔥 INITIALIZING LIVE TRADING SYSTEM...');
            logger.warn('⚠️  WARNING: REAL SOL WILL BE USED FOR TRADING');
            logger.info(`💰 Investment amount: ${this.config.initialInvestment} SOL`);
            
            await this.tradingBot.initialize();
            
            // Connect position manager to trading bot for price updates
            this.positionManager.setTradingBot(this.tradingBot);
            
            logger.info('✅ Live trading system initialized');
            return true;
            
        } catch (error) {
            logger.error('❌ Failed to initialize live trading:', error);
            throw error;
        }
    }

    async executeRealTrade(tokenAddress, customTwitterUrl = null) {
        try {
            logger.info('🚀 EXECUTING REAL TRADE...');
            logger.info(`🎯 Token: ${tokenAddress}`);
            logger.warn('⚠️  THIS WILL SPEND REAL SOL!');
            
            // Get real price first
            logger.info('💰 Fetching current market price...');
            const currentPrice = await this.tradingBot.getTokenPrice(tokenAddress);
            logger.info(`💎 Current price: ${currentPrice} SOL`);
            
            // Calculate expected purchase
            const expectedTokens = this.config.initialInvestment / currentPrice;
            logger.info(`📊 Expected purchase: ${expectedTokens.toFixed(2)} tokens`);
            
            // Create trading alert (simulate qualified token)
            const tradingAlert = {
                token: {
                    address: tokenAddress,
                    symbol: 'LIVE',
                    name: 'Live Trade Token'
                },
                twitter: {
                    likes: 1000, // High enough to qualify
                    views: 100000,
                    url: customTwitterUrl || 'https://twitter.com/live/trade'
                },
                confidence: 'HIGH',
                eventType: 'live_trade'
            };
            
            // Execute through trading bot
            logger.info('⚡ Executing trade through TradingBot...');
            await this.tradingBot.processAlert(tradingAlert);
            
            // Check if position was created
            const positions = this.positionManager.getActivePositions();
            const newPosition = positions.find(p => p.tokenAddress === tokenAddress);
            
            if (newPosition) {
                logger.info('🎉 LIVE TRADE SUCCESSFUL!');
                this.displayPositionDetails(newPosition);
                
                // Start monitoring position
                logger.info('👀 Starting position monitoring...');
                this.startPositionMonitoring(newPosition);
                
                return newPosition;
            } else {
                throw new Error('Position not found after trade execution');
            }
            
        } catch (error) {
            logger.error('❌ Live trade failed:', error);
            throw error;
        }
    }

    displayPositionDetails(position) {
        logger.info('📋 POSITION DETAILS:');
        logger.info(`   • ID: ${position.id}`);
        logger.info(`   • Token: ${position.symbol} (${position.tokenAddress})`);
        logger.info(`   • Entry Price: ${position.entryPrice} SOL`);
        logger.info(`   • Quantity: ${parseFloat(position.quantity).toFixed(2)} tokens`);
        logger.info(`   • Investment: ${position.investedAmount} SOL`);
        logger.info(`   • Current Value: ${position.currentValue || position.investedAmount} SOL`);
        
        logger.info('🎯 STOP LOSS & TAKE PROFITS:');
        logger.info(`   • Stop Loss: ${position.stopLoss} SOL (${this.config.stopLossPercentage}% loss)`);
        
        position.takeProfitLevels.forEach((level, index) => {
            logger.info(`   • TP ${index + 1}: ${level.targetValue} SOL (${level.percentage}% gain) - Sell ${level.sellPercentage}%`);
        });
    }

    async startPositionMonitoring(position) {
        logger.info('🔄 Position monitoring started - checking for stop loss and take profit triggers...');
        
        // The PositionManager's fast price update system will handle this automatically
        // Just log that monitoring is active
        setInterval(() => {
            const activePositions = this.positionManager.getActivePositions();
            const currentPosition = activePositions.find(p => p.id === position.id);
            
            if (currentPosition) {
                const currentPrice = currentPosition.currentPrice || currentPosition.entryPrice;
                const priceChange = ((currentPrice - currentPosition.entryPrice) / currentPosition.entryPrice * 100);
                
                logger.info(`📊 Position update: ${currentPosition.symbol} @ ${currentPrice.toFixed(8)} SOL (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%)`);
            } else {
                logger.info('📉 Position closed or no longer active');
            }
        }, 30000); // Log every 30 seconds
    }

    async getWalletBalance() {
        try {
            const balance = await this.tradingBot.connection.getBalance(this.tradingBot.wallet.publicKey);
            return balance / 1e9; // Convert to SOL
        } catch (error) {
            logger.error('Error getting wallet balance:', error);
            return 0;
        }
    }

    async checkPrerequisites() {
        logger.info('🔍 Checking live trading prerequisites...');
        
        // Check wallet balance
        const balance = await this.getWalletBalance();
        logger.info(`💰 Wallet balance: ${balance.toFixed(4)} SOL`);
        
        if (balance < this.config.initialInvestment) {
            throw new Error(`Insufficient balance: ${balance.toFixed(4)} SOL < ${this.config.initialInvestment} SOL required`);
        }
        
        // Check RPC connection
        const blockHeight = await this.tradingBot.connection.getBlockHeight();
        logger.info(`📡 RPC connected (block: ${blockHeight})`);
        
        logger.info('✅ All prerequisites met');
        return true;
    }
}

// CLI usage with safety prompts
async function main() {
    const tokenAddress = process.argv[2];
    const twitterUrl = process.argv[3];
    const forceFlag = process.argv[4];
    
    if (!tokenAddress) {
        console.log('Usage: node scripts/liveTrade.js <TOKEN_ADDRESS> [TWITTER_URL] [--force]');
        console.log('');
        console.log('⚠️  WARNING: This will execute REAL trades with REAL SOL!');
        console.log('');
        console.log('Examples:');
        console.log('  node scripts/liveTrade.js 7VnT8zHzorYS92snKC4CZU2veigEVnVVBSxTw7G1pump');
        console.log('  node scripts/liveTrade.js 7VnT8zHzorYS92snKC4CZU2veigEVnVVBSxTw7G1pump https://x.com/user/status/123');
        console.log('  node scripts/liveTrade.js 7VnT8zHzorYS92snKC4CZU2veigEVnVVBSxTw7G1pump "" --force');
        process.exit(1);
    }
    
    // Safety confirmation (unless --force flag)
    if (forceFlag !== '--force') {
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        console.log('⚠️  🚨 LIVE TRADING WARNING 🚨 ⚠️');
        console.log('');
        console.log('This will execute a REAL trade with REAL SOL!');
        console.log(`Token: ${tokenAddress}`);
        console.log(`Investment: ${process.env.INITIAL_INVESTMENT_SOL || 0.1} SOL`);
        console.log('');
        
        const confirm = await new Promise(resolve => {
            rl.question('Type "EXECUTE" to proceed with real trading: ', resolve);
        });
        
        rl.close();
        
        if (confirm !== 'EXECUTE') {
            console.log('❌ Trade cancelled');
            process.exit(0);
        }
    }
    
    try {
        const trader = new LiveTrader();
        await trader.initialize();
        await trader.checkPrerequisites();
        
        const position = await trader.executeRealTrade(tokenAddress, twitterUrl);
        
        logger.info('🎉 Live trade completed successfully!');
        logger.info('👀 Position monitoring active - press Ctrl+C to exit');
        
        // Keep script running to monitor position
        process.on('SIGINT', async () => {
            logger.info('🛑 Stopping live trader...');
            await trader.positionManager.savePositions();
            process.exit(0);
        });
        
    } catch (error) {
        logger.error('❌ Live trading failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = LiveTrader;