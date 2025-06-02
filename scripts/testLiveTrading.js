// scripts/testLiveTrading.js - Test REAL live trading with full workflow
require('dotenv').config();
const logger = require('../src/utils/logger');
const TradingBot = require('../src/bot/tradingBot');
const PositionManager = require('../src/bot/positionManager');

class LiveTradingTester {
    constructor() {
        this.config = {
            tradingMode: 'live', // 🔥 FORCE LIVE MODE
            initialInvestment: parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.01,
            stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE) || 50,
            slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 5
        };

        // Enhanced position manager for live trading
        this.positionManager = new PositionManager({
            tradingMode: 'live',
            maxPositions: 10,
            // Fast price updates for live monitoring
            fastUpdateInterval: 1000,  // 1 second
            normalUpdateInterval: 3000, // 3 seconds
            slowUpdateInterval: 10000   // 10 seconds
        });

        // Initialize trading bot
        this.tradingBot = new TradingBot({
            tradingMode: 'live',
            positionManager: this.positionManager,
            initialInvestment: this.config.initialInvestment
        });

        this.setupEventHandlers();
        this.isMonitoring = false;
    }

    setupEventHandlers() {
        // Position events
        this.positionManager.on('positionAdded', (position) => {
            console.log(`\n🎉 LIVE POSITION CREATED:`);
            console.log(`   Token: ${position.symbol} (${position.tokenAddress})`);
            console.log(`   Entry Price: ${position.entryPrice.toFixed(12)} SOL`);
            console.log(`   Quantity: ${parseFloat(position.quantity).toFixed(6)} tokens`);
            console.log(`   Investment: ${position.investedAmount} SOL`);
            console.log(`   Trading Method: ${position.tradingMethod || 'pumpswap'}`);
            console.log(`   Transaction: ${position.txHash}`);
            
            if (position.stopLossPrice) {
                const stopLossPercent = ((position.stopLossPrice - position.entryPrice) / position.entryPrice * 100);
                console.log(`   Stop Loss: ${position.stopLossPrice.toFixed(12)} SOL (${stopLossPercent.toFixed(1)}%)`);
            }
            
            if (position.takeProfitLevels?.length > 0) {
                console.log(`   Take Profits:`);
                position.takeProfitLevels.forEach((tp, index) => {
                    const tpPercent = ((tp.targetPrice - position.entryPrice) / position.entryPrice * 100);
                    console.log(`     TP${index + 1}: ${tp.targetPrice.toFixed(12)} SOL (+${tpPercent.toFixed(1)}%) - Sell ${tp.sellPercentage}%`);
                });
            }
        });

        this.positionManager.on('stopLossTriggered', (data) => {
            console.log(`\n🛑 STOP LOSS TRIGGERED: ${data.position.symbol}`);
            console.log(`   Trigger Price: ${data.triggerPrice.toFixed(12)} SOL`);
            console.log(`   Loss: ${data.lossPercentage.toFixed(2)}%`);
            console.log(`   Price Source: ${data.priceSource || 'unknown'}`);
        });

        this.positionManager.on('takeProfitTriggered', (data) => {
            console.log(`\n🎯 TAKE PROFIT ${data.level} TRIGGERED: ${data.position.symbol}`);
            console.log(`   Trigger Price: ${data.triggerPrice.toFixed(12)} SOL`);
            console.log(`   Gain: ${data.gainPercentage.toFixed(2)}%`);
            console.log(`   Selling: ${data.sellPercentage}% of position`);
            console.log(`   Price Source: ${data.priceSource || 'unknown'}`);
        });

        this.positionManager.on('positionClosed', (position) => {
            console.log(`\n📉 POSITION CLOSED: ${position.symbol}`);
            console.log(`   Total PnL: ${position.totalPnL?.toFixed(6) || '0.000000'} SOL`);
            console.log(`   Close Reason: ${position.closeReason || 'Unknown'}`);
        });

        // Trading bot events
        this.tradingBot.on('tradeExecuted', (tradeData) => {
            console.log(`\n🔥 LIVE TRADE EXECUTED:`);
            console.log(`   Type: ${tradeData.type}`);
            console.log(`   Token: ${tradeData.symbol}`);
            console.log(`   Amount: ${tradeData.amount}`);
            console.log(`   Price: ${tradeData.price?.toFixed(12) || 'N/A'} SOL`);
            console.log(`   Method: ${tradeData.method || 'pumpswap'}`);
            if (tradeData.signature) {
                console.log(`   Signature: ${tradeData.signature}`);
            }
        });
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing LIVE trading system...');
            logger.warn('⚠️  WARNING: REAL SOL WILL BE USED FOR TRADING');
            logger.info(`💰 Investment amount: ${this.config.initialInvestment} SOL`);
            logger.info(`📊 Stop Loss: ${this.config.stopLossPercentage}%`);
            logger.info(`⚡ Slippage: ${this.config.slippageTolerance}%`);
            
            await this.tradingBot.initialize();
            
            // Connect position manager to trading bot
            this.positionManager.setTradingBot(this.tradingBot);
            
            logger.info('✅ LIVE trading system initialized');
            return true;
            
        } catch (error) {
            logger.error('❌ Failed to initialize live trading:', error);
            throw error;
        }
    }

    async checkWalletBalance() {
        try {
            if (!this.tradingBot.wallet) {
                throw new Error('Wallet not initialized');
            }
            
            const balance = await this.tradingBot.connection.getBalance(this.tradingBot.wallet.publicKey);
            const balanceSOL = balance / 1e9;
            
            console.log(`💼 Wallet Balance: ${balanceSOL.toFixed(6)} SOL`);
            
            if (balanceSOL < this.config.initialInvestment + 0.001) { // Need extra for fees
                throw new Error(`Insufficient balance: ${balanceSOL.toFixed(6)} SOL < ${this.config.initialInvestment + 0.001} SOL needed`);
            }
            
            return balanceSOL;
            
        } catch (error) {
            logger.error('❌ Wallet balance check failed:', error);
            throw error;
        }
    }

    async testPoolDerivation(tokenAddress) {
        try {
            console.log(`\n🔍 TESTING POOL DERIVATION:`);
            console.log(`Token: ${tokenAddress}`);
            
            const startTime = Date.now();
            const poolAddress = this.tradingBot.derivePoolAddress(tokenAddress);
            const duration = Date.now() - startTime;
            
            if (poolAddress) {
                console.log(`✅ Pool derived: ${poolAddress} (${duration}ms)`);
                
                // Test price calculation
                const priceInfo = await this.tradingBot.getTokenPrice(tokenAddress, true);
                console.log(`💰 Current price: ${priceInfo.price.toFixed(12)} SOL`);
                console.log(`📊 Price source: ${priceInfo.source}`);
                
                return { success: true, poolAddress, price: priceInfo.price };
            } else {
                throw new Error('Pool derivation failed');
            }
            
        } catch (error) {
            console.log(`❌ Pool derivation test failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async executeLiveTrade(tokenAddress, eventType = 'creation') {
        try {
            console.log(`\n🚀 EXECUTING LIVE TRADE:`);
            console.log(`Token: ${tokenAddress}`);
            console.log(`Event Type: ${eventType}`);
            console.log(`Investment: ${this.config.initialInvestment} SOL`);
            
            // Create trading alert (simulate WebSocket message)
            const tradingAlert = {
                token: {
                    address: tokenAddress,
                    symbol: 'LIVE',
                    name: 'Live Test Token'
                },
                twitter: {
                    likes: 1000, // High enough to qualify
                    views: 100000,
                    url: 'https://twitter.com/live/test'
                },
                confidence: 'HIGH',
                eventType: eventType,
                // For migrations, pool can be derived
                migration: eventType === 'migration' ? {
                    pool: 'unknown', // Will be derived automatically
                    derivedInstantly: true
                } : undefined
            };
            
            // Execute through trading bot
            logger.info('⚡ Executing live trade through TradingBot...');
            await this.tradingBot.processAlert(tradingAlert);
            
            // Check if position was created
            const positions = this.positionManager.getActivePositions();
            const newPosition = positions.find(p => p.tokenAddress === tokenAddress);
            
            if (newPosition) {
                console.log(`\n🎉 LIVE TRADE SUCCESSFUL!`);
                this.displayPositionDetails(newPosition);
                return newPosition;
            } else {
                throw new Error('Position not found after trade execution');
            }
            
        } catch (error) {
            logger.error('❌ Live trade execution failed:', error);
            throw error;
        }
    }

    displayPositionDetails(position) {
        console.log(`\n📋 LIVE POSITION DETAILS:`);
        console.log(`   ID: ${position.id}`);
        console.log(`   Token: ${position.symbol} (${position.tokenAddress})`);
        console.log(`   Entry Price: ${position.entryPrice.toFixed(12)} SOL`);
        console.log(`   Quantity: ${parseFloat(position.quantity).toFixed(6)} tokens`);
        console.log(`   Investment: ${position.investedAmount} SOL`);
        console.log(`   Current Value: ${position.currentValue || position.investedAmount} SOL`);
        console.log(`   Trading Method: ${position.tradingMethod || 'pumpswap'}`);
        console.log(`   Pool Address: ${position.poolAddress || 'derived'}`);
        
        if (!position.paperTrade) {
            console.log(`   🔗 Transaction: https://solscan.io/tx/${position.txHash}`);
        }
    }

    async startPositionMonitoring(duration = 300000) { // 5 minutes default
        try {
            console.log(`\n👀 STARTING POSITION MONITORING (${duration / 1000} seconds)...`);
            console.log('Monitoring for stop loss and take profit triggers...');
            
            this.isMonitoring = true;
            const startTime = Date.now();
            
            const monitoringInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                
                if (elapsed >= duration || !this.isMonitoring) {
                    clearInterval(monitoringInterval);
                    console.log(`\n⏹️ Position monitoring stopped (${elapsed / 1000}s elapsed)`);
                    this.isMonitoring = false;
                    return;
                }
                
                // Show current positions status
                const positions = this.positionManager.getActivePositions();
                if (positions.length > 0) {
                    positions.forEach(pos => {
                        const currentPrice = pos.currentPrice || pos.entryPrice;
                        const priceChange = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100);
                        const changeIcon = priceChange > 0 ? '📈' : priceChange < 0 ? '📉' : '➡️';
                        
                        console.log(`${changeIcon} ${pos.symbol}: ${currentPrice.toFixed(8)} SOL (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%)`);
                    });
                }
            }, 10000); // Update every 10 seconds
            
        } catch (error) {
            logger.error('❌ Position monitoring failed:', error);
        }
    }

    async showFinalResults() {
        try {
            console.log(`\n📊 FINAL LIVE TRADING RESULTS:`);
            console.log('='.repeat(50));
            
            // Get current balance
            const finalBalance = await this.checkWalletBalance();
            
            // Get trading bot stats
            const stats = this.tradingBot.getStats();
            console.log(`🔥 Trading Stats:`);
            console.log(`   Alerts Processed: ${stats.alertsProcessed}`);
            console.log(`   Live Trades: ${stats.liveTrades || 0}`);
            console.log(`   PumpSwap Trades: ${stats.pumpSwapTrades || 0}`);
            console.log(`   Pool Derivations: ${stats.poolDerivation?.derived || 0}`);
            console.log(`   Derivation Success Rate: ${stats.poolDerivation?.successRate || '0%'}`);
            
            // Get position manager stats
            const posStats = this.positionManager.getPerformanceStats();
            console.log(`📈 Position Stats:`);
            console.log(`   Active Positions: ${posStats.activePositions || 0}`);
            console.log(`   Closed Positions: ${posStats.closedPositions || 0}`);
            console.log(`   Total PnL: ${posStats.totalRealizedPnL || '0.000000'} SOL`);
            console.log(`   Stop Losses: ${posStats.triggers?.stopLossTriggered || 0}`);
            console.log(`   Take Profits: ${posStats.triggers?.takeProfitTriggered || 0}`);
            
        } catch (error) {
            logger.error('❌ Failed to show final results:', error);
        }
    }

    async runFullLiveTest(tokenAddress, eventType = 'creation', monitorDuration = 300000) {
        try {
            console.log('🔥 FULL LIVE TRADING TEST');
            console.log('='.repeat(60));
            console.log(`🎯 Token: ${tokenAddress}`);
            console.log(`📊 Event Type: ${eventType}`);
            console.log(`💰 Investment: ${this.config.initialInvestment} SOL`);
            console.log(`⏱️ Monitor Duration: ${monitorDuration / 1000} seconds`);
            console.log('');
            
            // Step 1: Check prerequisites
            console.log('1️⃣ CHECKING PREREQUISITES');
            await this.checkWalletBalance();
            
            // Step 2: Test pool derivation
            console.log('\n2️⃣ TESTING POOL DERIVATION');
            const derivationResult = await this.testPoolDerivation(tokenAddress);
            if (!derivationResult.success) {
                throw new Error(`Pool derivation failed: ${derivationResult.error}`);
            }
            
            // Step 3: Execute live trade
            console.log('\n3️⃣ EXECUTING LIVE TRADE');
            const position = await this.executeLiveTrade(tokenAddress, eventType);
            
            // Step 4: Monitor position
            console.log('\n4️⃣ MONITORING POSITION');
            await this.startPositionMonitoring(monitorDuration);
            
            // Step 5: Final results
            console.log('\n5️⃣ FINAL RESULTS');
            await this.showFinalResults();
            
            console.log('\n🎉 FULL LIVE TRADING TEST COMPLETED!');
            console.log('🚀 Your trading bot is working with REAL transactions!');
            
            return {
                success: true,
                position: position,
                derivationResult: derivationResult
            };
            
        } catch (error) {
            logger.error('❌ Full live test failed:', error);
            throw error;
        }
    }

    stopMonitoring() {
        this.isMonitoring = false;
        console.log('⏹️ Monitoring stopped by user');
    }
}

// CLI usage with safety checks
async function main() {
    const tokenAddress = process.argv[2];
    const eventType = process.argv[3] || 'creation';
    const monitorDuration = parseInt(process.argv[4]) || 300000; // 5 minutes default
    const forceFlag = process.argv[5];
    
    if (!tokenAddress) {
        console.log('Usage: node scripts/testLiveTrading.js <TOKEN_ADDRESS> [EVENT_TYPE] [MONITOR_DURATION] [--force]');
        console.log('');
        console.log('⚠️  WARNING: This executes REAL trades with REAL SOL!');
        console.log('');
        console.log('Examples:');
        console.log('  # Test creation event (5 min monitoring)');
        console.log('  node scripts/testLiveTrading.js HQC1xWpfKArsr6g8vBPn6MrgiePPPMPZ7uaHaAxYpump');
        console.log('');
        console.log('  # Test migration event (10 min monitoring)');
        console.log('  node scripts/testLiveTrading.js HQC1x... migration 600000');
        console.log('');
        console.log('  # Force execution (skip confirmation)');
        console.log('  node scripts/testLiveTrading.js HQC1x... creation 300000 --force');
        console.log('');
        console.log('Event Types: creation, migration');
        process.exit(1);
    }
    
    // Safety confirmation (unless --force)
    if (forceFlag !== '--force') {
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        console.log('⚠️  🚨 LIVE TRADING WARNING 🚨 ⚠️');
        console.log('');
        console.log('This will execute REAL trades with REAL SOL!');
        console.log(`Token: ${tokenAddress}`);
        console.log(`Event Type: ${eventType}`);
        console.log(`Investment: ${process.env.INITIAL_INVESTMENT_SOL || 0.01} SOL`);
        console.log(`Monitor Duration: ${monitorDuration / 1000} seconds`);
        console.log('');
        console.log('The bot will:');
        console.log('✅ Derive pool address instantly');
        console.log('✅ Execute REAL PumpSwap buy transaction');
        console.log('✅ Set up stop loss and take profit levels');
        console.log('✅ Monitor price and trigger sells automatically');
        console.log('');
        
        const confirm = await new Promise(resolve => {
            rl.question('Type "EXECUTE" to proceed with LIVE trading: ', resolve);
        });
        
        rl.close();
        
        if (confirm !== 'EXECUTE') {
            console.log('❌ Live trading test cancelled');
            process.exit(0);
        }
    }
    
    try {
        const tester = new LiveTradingTester();
        await tester.initialize();
        
        const result = await tester.runFullLiveTest(tokenAddress, eventType, monitorDuration);
        
        console.log('\n✅ Live trading test completed successfully!');
        console.log('Press Ctrl+C to exit or let monitoring continue...');
        
        // Keep script running for monitoring
        process.on('SIGINT', async () => {
            console.log('\n🛑 Stopping live trading test...');
            tester.stopMonitoring();
            await tester.positionManager.savePositions();
            process.exit(0);
        });
        
    } catch (error) {
        logger.error('❌ Live trading test failed:', error);
        console.log('\n🔧 TROUBLESHOOTING:');
        console.log('1. Check your .env file has PRIVATE_KEY');
        console.log('2. Ensure sufficient SOL balance');
        console.log('3. Verify token address is valid');
        console.log('4. Check network connectivity');
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = LiveTradingTester;