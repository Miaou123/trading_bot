// scripts/testLiveSell.js - Test live PumpSwap sell functionality with real positions
require('dotenv').config();
const logger = require('../src/utils/logger');
const TradingBot = require('../src/bot/tradingBot');
const PositionManager = require('../src/bot/positionManager');

class LiveSellTester {
    constructor() {
        this.config = {
            tradingMode: 'live', // 🔥 FORCE LIVE MODE
            initialInvestment: parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.01,
            stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE) || 50,
            slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 5
        };

        this.positionManager = new PositionManager({
            tradingMode: 'live',
            maxPositions: 10,
            fastUpdateInterval: 1000
        });

        this.tradingBot = new TradingBot({
            tradingMode: 'live',
            positionManager: this.positionManager,
            initialInvestment: this.config.initialInvestment
        });

        this.setupEventHandlers();
    }

    setupEventHandlers() {
        // Enhanced event logging for live sell testing
        this.tradingBot.on('tradeExecuted', (tradeData) => {
            if (tradeData.type === 'LIVE_SELL') {
                console.log(`\n🚀 LIVE SELL EXECUTED:`);
                console.log(`   Token: ${tradeData.symbol}`);
                console.log(`   Amount Sold: ${parseFloat(tradeData.amount).toFixed(6)} tokens`);
                console.log(`   Price: ${tradeData.price?.toFixed(12) || 'N/A'} SOL per token`);
                console.log(`   PnL: ${tradeData.pnl > 0 ? '+' : ''}${tradeData.pnl?.toFixed(6) || 'N/A'} SOL`);
                console.log(`   PnL%: ${tradeData.pnlPercentage > 0 ? '+' : ''}${tradeData.pnlPercentage?.toFixed(2) || 'N/A'}%`);
                console.log(`   Reason: ${tradeData.reason || 'Manual'}`);
                console.log(`   Signature: ${tradeData.signature}`);
                console.log(`   Method: ${tradeData.method || 'pumpswap'}`);
            }
        });

        this.positionManager.on('stopLossTriggered', (data) => {
            console.log(`\n🛑 STOP LOSS TRIGGERED:`);
            console.log(`   Token: ${data.position.symbol}`);
            console.log(`   Trigger Price: ${data.triggerPrice.toFixed(12)} SOL`);
            console.log(`   Loss: ${data.lossPercentage.toFixed(2)}%`);
            console.log(`   Execution Mode: ${data.executionMode.toUpperCase()}`);
        });

        this.positionManager.on('takeProfitTriggered', (data) => {
            console.log(`\n🎯 TAKE PROFIT ${data.level} TRIGGERED:`);
            console.log(`   Token: ${data.position.symbol}`);
            console.log(`   Trigger Price: ${data.triggerPrice.toFixed(12)} SOL`);
            console.log(`   Gain: ${data.gainPercentage.toFixed(2)}%`);
            console.log(`   Selling: ${data.sellPercentage}% of position`);
            console.log(`   Execution Mode: ${data.executionMode.toUpperCase()}`);
        });

        this.positionManager.on('positionClosed', (position) => {
            console.log(`\n📉 POSITION CLOSED:`);
            console.log(`   Token: ${position.symbol}`);
            console.log(`   Total PnL: ${position.totalPnL?.toFixed(6) || '0.000000'} SOL`);
            console.log(`   Close Reason: ${position.closeReason || 'Unknown'}`);
            console.log(`   Trading Mode: ${position.paperTrade ? 'PAPER' : 'LIVE'}`);
        });
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing LIVE SELL testing system...');
            logger.warn('⚠️  WARNING: REAL SOL WILL BE USED FOR SELLING');
            
            await this.tradingBot.initialize();
            this.positionManager.setTradingBot(this.tradingBot);
            
            logger.info('✅ LIVE SELL testing system initialized');
            return true;
            
        } catch (error) {
            logger.error('❌ Failed to initialize live sell testing:', error);
            throw error;
        }
    }

    async showActivePositions() {
        const positions = this.positionManager.getActivePositions();
        
        console.log(`\n📊 ACTIVE POSITIONS (${positions.length}):`);
        console.log('='.repeat(60));
        
        if (positions.length === 0) {
            console.log('No active positions found');
            return [];
        }
        
        positions.forEach((pos, index) => {
            const currentPrice = pos.currentPrice || pos.entryPrice;
            const priceChange = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100);
            const remainingTokens = parseFloat(pos.remainingQuantity);
            const currentValue = remainingTokens * currentPrice;
            const unrealizedPnL = currentValue - ((remainingTokens / parseFloat(pos.quantity)) * pos.investedAmount);
            
            const changeIcon = priceChange > 0 ? '📈' : priceChange < 0 ? '📉' : '➡️';
            const tradingMode = pos.paperTrade ? '[PAPER]' : '[LIVE]';
            
            console.log(`\n${index + 1}. ${pos.symbol} ${tradingMode}:`);
            console.log(`   ID: ${pos.id}`);
            console.log(`   Entry Price: ${pos.entryPrice.toFixed(12)} SOL`);
            console.log(`   ${changeIcon} Current: ${currentPrice.toFixed(12)} SOL (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%)`);
            console.log(`   Remaining: ${remainingTokens.toFixed(6)} tokens`);
            console.log(`   Current Value: ${currentValue.toFixed(6)} SOL`);
            console.log(`   Unrealized PnL: ${unrealizedPnL > 0 ? '+' : ''}${unrealizedPnL.toFixed(6)} SOL`);
            console.log(`   Pool: ${pos.poolAddress || 'Unknown'}`);
            
            // Show stop loss and take profit distances
            if (pos.stopLossPrice) {
                const stopLossDistance = ((currentPrice - pos.stopLossPrice) / currentPrice * 100);
                console.log(`   🛑 Stop Loss: ${pos.stopLossPrice.toFixed(12)} SOL (${stopLossDistance.toFixed(1)}% away)`);
            }
            
            if (pos.takeProfitLevels?.length > 0) {
                console.log(`   🎯 Take Profits:`);
                pos.takeProfitLevels.forEach(tp => {
                    const distance = ((tp.targetPrice - currentPrice) / currentPrice * 100);
                    const status = tp.triggered ? '✅ TRIGGERED' : distance > 0 ? `${distance.toFixed(1)}% away` : '⚡ READY';
                    console.log(`     TP${tp.level}: ${tp.targetPrice.toFixed(12)} SOL - ${tp.sellPercentage}% (${status})`);
                });
            }
        });
        
        return positions;
    }

    async testManualSell(positionId, sellPercentage = 10, reason = 'Manual Test Sell') {
        try {
            console.log(`\n🧪 TESTING MANUAL SELL:`);
            console.log(`Position ID: ${positionId}`);
            console.log(`Sell Percentage: ${sellPercentage}%`);
            console.log(`Reason: ${reason}`);
            
            const position = this.positionManager.positions.get(positionId);
            if (!position) {
                throw new Error(`Position ${positionId} not found`);
            }
            
            const tokensToSell = parseFloat(position.remainingQuantity) * (sellPercentage / 100);
            
            console.log(`\n📊 Pre-sell Details:`);
            console.log(`   Token: ${position.symbol}`);
            console.log(`   Current Price: ${position.currentPrice?.toFixed(12) || position.entryPrice.toFixed(12)} SOL`);
            console.log(`   Tokens to Sell: ${tokensToSell.toFixed(6)} of ${position.remainingQuantity}`);
            console.log(`   Trading Mode: ${position.paperTrade ? 'PAPER' : 'LIVE'}`);
            
            // Execute the sell
            const result = await this.tradingBot.sellPosition(positionId, sellPercentage, reason);
            
            if (result.success) {
                console.log(`\n✅ MANUAL SELL SUCCESSFUL!`);
                console.log(`   SOL Received: ${result.solReceived.toFixed(6)} SOL`);
                console.log(`   PnL: ${result.pnl > 0 ? '+' : ''}${result.pnl.toFixed(6)} SOL`);
                console.log(`   PnL%: ${result.pnlPercentage > 0 ? '+' : ''}${result.pnlPercentage.toFixed(2)}%`);
                
                if (result.signature) {
                    console.log(`   🔗 Transaction: https://solscan.io/tx/${result.signature}`);
                }
            }
            
            return result;
            
        } catch (error) {
            console.log(`❌ Manual sell test failed: ${error.message}`);
            throw error;
        }
    }

    async testStopLossSimulation(positionId) {
        try {
            console.log(`\n🧪 TESTING STOP LOSS SIMULATION:`);
            console.log(`Position ID: ${positionId}`);
            
            const position = this.positionManager.positions.get(positionId);
            if (!position) {
                throw new Error(`Position ${positionId} not found`);
            }
            
            const currentPrice = position.currentPrice || position.entryPrice;
            const stopLossPrice = position.stopLossPrice;
            
            if (!stopLossPrice) {
                throw new Error('Position has no stop loss configured');
            }
            
            console.log(`\n📊 Stop Loss Details:`);
            console.log(`   Current Price: ${currentPrice.toFixed(12)} SOL`);
            console.log(`   Stop Loss Price: ${stopLossPrice.toFixed(12)} SOL`);
            console.log(`   Distance: ${((currentPrice - stopLossPrice) / currentPrice * 100).toFixed(2)}%`);
            
            if (currentPrice <= stopLossPrice) {
                console.log(`⚡ Stop loss would trigger at current price!`);
            } else {
                console.log(`ℹ️ Stop loss not triggered yet - simulating trigger...`);
                
                // Temporarily set the current price to trigger stop loss
                const originalPrice = position.currentPrice;
                position.currentPrice = stopLossPrice * 0.99; // Slightly below stop loss
                
                console.log(`🔄 Simulating price drop to ${position.currentPrice.toFixed(12)} SOL...`);
                
                // Trigger the stop loss check
                await this.positionManager.checkStopLossWithLiveExecution(position);
                
                // Restore original price
                position.currentPrice = originalPrice;
            }
            
        } catch (error) {
            console.log(`❌ Stop loss simulation failed: ${error.message}`);
            throw error;
        }
    }

    async testTakeProfitSimulation(positionId, level = 1) {
        try {
            console.log(`\n🧪 TESTING TAKE PROFIT ${level} SIMULATION:`);
            console.log(`Position ID: ${positionId}`);
            
            const position = this.positionManager.positions.get(positionId);
            if (!position) {
                throw new Error(`Position ${positionId} not found`);
            }
            
            const targetTP = position.takeProfitLevels?.find(tp => tp.level === level);
            if (!targetTP) {
                throw new Error(`Take profit level ${level} not found`);
            }
            
            const currentPrice = position.currentPrice || position.entryPrice;
            
            console.log(`\n📊 Take Profit ${level} Details:`);
            console.log(`   Current Price: ${currentPrice.toFixed(12)} SOL`);
            console.log(`   TP${level} Price: ${targetTP.targetPrice.toFixed(12)} SOL`);
            console.log(`   Distance: ${((targetTP.targetPrice - currentPrice) / currentPrice * 100).toFixed(2)}%`);
            console.log(`   Sell Percentage: ${targetTP.sellPercentage}%`);
            console.log(`   Already Triggered: ${targetTP.triggered ? 'YES' : 'NO'}`);
            
            if (currentPrice >= targetTP.targetPrice && !targetTP.triggered) {
                console.log(`⚡ Take profit ${level} would trigger at current price!`);
            } else if (targetTP.triggered) {
                console.log(`ℹ️ Take profit ${level} already triggered`);
                return;
            } else {
                console.log(`ℹ️ Take profit ${level} not triggered yet - simulating trigger...`);
                
                // Temporarily set the current price to trigger take profit
                const originalPrice = position.currentPrice;
                position.currentPrice = targetTP.targetPrice * 1.01; // Slightly above TP
                
                console.log(`🔄 Simulating price rise to ${position.currentPrice.toFixed(12)} SOL...`);
                
                // Trigger the take profit check
                await this.positionManager.checkTakeProfitsWithLiveExecution(position);
                
                // Restore original price
                position.currentPrice = originalPrice;
            }
            
        } catch (error) {
            console.log(`❌ Take profit simulation failed: ${error.message}`);
            throw error;
        }
    }

    async showTradingStats() {
        console.log(`\n📊 LIVE TRADING STATS:`);
        console.log('='.repeat(40));
        
        const botStats = this.tradingBot.getStats();
        const posStats = this.positionManager.getPerformanceStats();
        
        console.log(`🚀 Trading Bot Stats:`);
        console.log(`   Live Trades: ${botStats.liveTrades || 0}`);
        console.log(`   PumpSwap Buys: ${botStats.pumpSwapTrades || 0}`);
        console.log(`   PumpSwap Sells: ${botStats.pumpSwapSells || 0}`);
        console.log(`   Stop Loss Executions: ${botStats.stopLossExecutions || 0}`);
        console.log(`   Take Profit Executions: ${botStats.takeProfitExecutions || 0}`);
        console.log(`   Total PnL: ${botStats.totalPnL?.toFixed(6) || '0.000000'} SOL`);
        
        console.log(`\n📈 Position Manager Stats:`);
        console.log(`   Active Positions: ${posStats.activePositions}`);
        console.log(`   Closed Positions: ${posStats.closedPositions}`);
        console.log(`   Total Realized PnL: ${posStats.totalRealizedPnL}`);
        console.log(`   Total Unrealized PnL: ${posStats.totalUnrealizedPnL}`);
        console.log(`   Live Sells Executed: ${posStats.liveTrading?.liveSellsExecuted || 0}`);
        console.log(`   Paper Sells Executed: ${posStats.liveTrading?.paperSellsExecuted || 0}`);
        console.log(`   Stop Loss Executions: ${posStats.liveTrading?.stopLossExecutions || 0}`);
        console.log(`   Take Profit Executions: ${posStats.liveTrading?.takeProfitExecutions || 0}`);
        console.log(`   Total Live PnL: ${posStats.liveTrading?.totalLivePnL || '0.000000'}`);
    }

    async runInteractiveTest() {
        try {
            console.log('🔥 INTERACTIVE LIVE SELL TESTING');
            console.log('='.repeat(50));
            
            // Show active positions
            const positions = await this.showActivePositions();
            
            if (positions.length === 0) {
                console.log('\n❌ No active positions found for testing');
                console.log('💡 Run a live trade first to create positions');
                return;
            }
            
            // Show stats
            await this.showTradingStats();
            
            console.log(`\n🧪 LIVE SELL TEST OPTIONS:`);
            console.log(`1. Manual partial sell (safe - small percentage)`);
            console.log(`2. Simulate stop loss trigger`);
            console.log(`3. Simulate take profit trigger`);
            console.log(`4. Show position details`);
            console.log(`5. Force close position`);
            console.log(`6. Emergency stop all positions`);
            
            // For non-interactive mode, just show the options
            console.log(`\n💡 To test manually:`);
            console.log(`   • Manual sell: await tester.testManualSell('POSITION_ID', 10, 'Test Sell')`);
            console.log(`   • Stop loss sim: await tester.testStopLossSimulation('POSITION_ID')`);
            console.log(`   • Take profit sim: await tester.testTakeProfitSimulation('POSITION_ID', 1)`);
            
            return positions;
            
        } catch (error) {
            logger.error('❌ Interactive test failed:', error);
            throw error;
        }
    }
}

// CLI usage
async function main() {
    const action = process.argv[2] || 'interactive';
    const positionId = process.argv[3];
    const percentage = parseFloat(process.argv[4]) || 10;
    
    console.log('🧪 LIVE SELL FUNCTIONALITY TEST');
    console.log('='.repeat(50));
    console.log(`Action: ${action}`);
    
    if (action === 'help' || action === '--help') {
        console.log('Usage: node scripts/testLiveSell.js [ACTION] [POSITION_ID] [PERCENTAGE]');
        console.log('');
        console.log('Actions:');
        console.log('  interactive    - Show positions and test options');
        console.log('  sell           - Test manual sell');
        console.log('  stoploss       - Simulate stop loss trigger');
        console.log('  takeprofit     - Simulate take profit trigger');
        console.log('  stats          - Show trading statistics');
        console.log('');
        console.log('Examples:');
        console.log('  # Interactive mode');
        console.log('  node scripts/testLiveSell.js');
        console.log('');
        console.log('  # Manual sell 10% of position');
        console.log('  node scripts/testLiveSell.js sell pos_1234567890 10');
        console.log('');
        console.log('  # Simulate stop loss');
        console.log('  node scripts/testLiveSell.js stoploss pos_1234567890');
        console.log('');
        console.log('⚠️  WARNING: This uses REAL SOL for live trading!');
        process.exit(0);
    }
    
    try {
        const tester = new LiveSellTester();
        await tester.initialize();
        
        switch (action) {
            case 'sell':
                if (!positionId) {
                    throw new Error('Position ID required for sell action');
                }
                await tester.testManualSell(positionId, percentage, `Manual Test Sell ${percentage}%`);
                break;
                
            case 'stoploss':
                if (!positionId) {
                    throw new Error('Position ID required for stoploss action');
                }
                await tester.testStopLossSimulation(positionId);
                break;
                
            case 'takeprofit':
                if (!positionId) {
                    throw new Error('Position ID required for takeprofit action');
                }
                const level = parseInt(process.argv[5]) || 1;
                await tester.testTakeProfitSimulation(positionId, level);
                break;
                
            case 'stats':
                await tester.showTradingStats();
                break;
                
            case 'interactive':
            default:
                await tester.runInteractiveTest();
                break;
        }
        
        console.log('\n✅ Live sell test completed!');
        
    } catch (error) {
        logger.error('❌ Live sell test failed:', error);
        console.log('\n🔧 TROUBLESHOOTING:');
        console.log('1. Make sure you have active positions');
        console.log('2. Check your .env file has PRIVATE_KEY');
        console.log('3. Ensure sufficient SOL balance');
        console.log('4. Verify PumpSwap SDK is working');
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = LiveSellTester;