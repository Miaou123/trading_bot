// scripts/testSimpleTradingBot.js - Test the NEW simple trading bot
require('dotenv').config();
const logger = require('../src/utils/logger');
const TradingBot = require('../src/bot/tradingBot');
const PositionManager = require('../src/bot/positionManager');

class SimpleTradingBotTester {
    constructor() {
        this.config = {
            tradingMode: 'paper',
            initialInvestment: 0.01
        };

        this.positionManager = new PositionManager({
            tradingMode: 'paper',
            maxPositions: 10,
            fastUpdateInterval: 1000,
            slowUpdateInterval: 60000
        });

        this.tradingBot = new TradingBot({
            tradingMode: 'paper',
            positionManager: this.positionManager,
            initialInvestment: this.config.initialInvestment
        });

        this.setupEventHandlers();
    }

    setupEventHandlers() {
        this.positionManager.on('positionAdded', (position) => {
            console.log(`✅ Position Added: ${position.symbol} via ${position.priceSource || 'unknown'}`);
        });

        this.tradingBot.on('tradeExecuted', (tradeData) => {
            console.log(`🎯 Trade executed: ${tradeData.type} ${tradeData.symbol} (${tradeData.priceSource})`);
        });
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing SIMPLE trading bot...');
            
            await this.tradingBot.initialize();
            this.positionManager.setTradingBot(this.tradingBot);
            
            logger.info('✅ Simple trading bot initialized');
            return true;
            
        } catch (error) {
            logger.error('❌ Failed to initialize:', error);
            throw error;
        }
    }

    async testAutoPoolDiscovery(tokenAddress) {
        try {
            console.log(`\n🔍 TESTING AUTO POOL DISCOVERY`);
            console.log(`🎯 Token: ${tokenAddress}`);
            
            const startTime = Date.now();
            const poolAddress = await this.tradingBot.findPoolAddress(tokenAddress);
            const duration = Date.now() - startTime;
            
            if (poolAddress) {
                console.log(`✅ Pool found: ${poolAddress} (${duration}ms)`);
                return { success: true, poolAddress: poolAddress, duration: duration };
            } else {
                console.log(`❌ No pool found (${duration}ms)`);
                return { success: false, poolAddress: null, duration: duration };
            }
            
        } catch (error) {
            console.log(`❌ Pool discovery failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async testSmartPricing(tokenAddress) {
        try {
            console.log(`\n💰 TESTING SMART PRICING SYSTEM`);
            console.log(`🎯 Token: ${tokenAddress}`);
            
            const results = {
                price: null,
                source: null,
                duration: null,
                success: false
            };

            // Test the unified smart pricing method
            console.log(`🧠 Testing smart price method...`);
            const startTime = Date.now();
            
            try {
                const price = await this.tradingBot.getTokenPrice(tokenAddress, true);
                const duration = Date.now() - startTime;
                const source = this.tradingBot.priceCache.get(tokenAddress)?.source || 'unknown';
                
                results.price = price;
                results.source = source;
                results.duration = duration;
                results.success = true;
                
                console.log(`✅ Smart pricing: ${price.toFixed(12)} SOL (${duration}ms) via ${source}`);
                
            } catch (error) {
                const duration = Date.now() - startTime;
                console.log(`❌ Smart pricing failed: ${error.message} (${duration}ms)`);
                results.duration = duration;
                results.error = error.message;
            }

            return results;
            
        } catch (error) {
            console.log(`❌ Pricing test failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async testPositionCreation(tokenAddress) {
        try {
            console.log(`\n📊 TESTING POSITION CREATION`);
            console.log(`🎯 Token: ${tokenAddress}`);
            
            // Create trading alert
            const tradingAlert = {
                token: {
                    address: tokenAddress,
                    symbol: 'TEST',
                    name: 'Test Token'
                },
                twitter: {
                    likes: 1000,
                    views: 100000,
                    url: 'https://twitter.com/test/status/123456789'
                },
                confidence: 'HIGH',
                eventType: 'simple_bot_test'
            };
            
            // Execute buy
            console.log(`⚡ Executing buy with simple trading bot...`);
            const position = await this.tradingBot.executeBuy(tradingAlert);
            
            if (position) {
                console.log(`🎉 POSITION CREATED SUCCESSFULLY!`);
                console.log(`   📊 Price Source: ${position.priceSource || 'unknown'}`);
                console.log(`   💰 Entry Price: ${position.entryPrice.toFixed(12)} SOL`);
                console.log(`   🔢 Quantity: ${parseFloat(position.quantity).toFixed(2)} tokens`);
                console.log(`   💵 Investment: ${position.investedAmount} SOL`);
                console.log(`   📉 Stop Loss: ${position.stopLossPrice.toFixed(12)} SOL`);
                console.log(`   📈 Take Profits: ${position.takeProfitLevels.length} levels`);
                
                return { success: true, position: position };
            } else {
                throw new Error('Position not created');
            }
            
        } catch (error) {
            console.log(`❌ Position creation failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async testPriceMonitoring(position, duration = 30000) {
        try {
            console.log(`\n🔄 TESTING PRICE MONITORING`);
            console.log(`📊 Monitoring ${position.symbol} for ${duration / 1000} seconds...`);
            
            const startTime = Date.now();
            const priceUpdates = [];
            
            return new Promise((resolve) => {
                const monitorInterval = setInterval(async () => {
                    const elapsed = Date.now() - startTime;
                    
                    if (elapsed >= duration) {
                        clearInterval(monitorInterval);
                        
                        console.log(`\n📊 MONITORING COMPLETED:`);
                        console.log(`   Total updates: ${priceUpdates.length}`);
                        
                        const manualUpdates = priceUpdates.filter(u => u.source === 'manual').length;
                        const jupiterUpdates = priceUpdates.filter(u => u.source === 'jupiter').length;
                        
                        console.log(`   🔧 Manual updates: ${manualUpdates}`);
                        console.log(`   🪐 Jupiter updates: ${jupiterUpdates}`);
                        
                        resolve(priceUpdates);
                        return;
                    }
                    
                    // Get fresh price
                    try {
                        const currentPrice = await this.tradingBot.getTokenPrice(position.tokenAddress, true);
                        const source = this.tradingBot.priceCache.get(position.tokenAddress)?.source || 'unknown';
                        const priceChange = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
                        
                        priceUpdates.push({
                            timestamp: Date.now(),
                            price: currentPrice,
                            source: source,
                            priceChange: priceChange
                        });
                        
                        const changeIcon = priceChange > 0 ? '📈' : priceChange < 0 ? '📉' : '➡️';
                        const sourceIcon = source === 'manual' ? '🔧' : '🪐';
                        
                        console.log(`${changeIcon} ${sourceIcon} ${currentPrice.toFixed(8)} SOL (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%)`);
                        
                    } catch (error) {
                        console.log(`❌ Price update failed: ${error.message}`);
                    }
                    
                }, 3000); // Check every 3 seconds
            });
            
        } catch (error) {
            console.log(`❌ Price monitoring failed: ${error.message}`);
            return [];
        }
    }

    async showTradingBotStats() {
        const stats = this.tradingBot.getStats();
        
        console.log(`\n📊 SIMPLE TRADING BOT STATS:`);
        console.log(`=`.repeat(40));
        console.log(`💰 Trading: ${stats.tradesExecuted} executed, ${stats.buyOrders} buys`);
        console.log(`🔍 Pool Discovery: ${stats.poolsFound} found, ${stats.poolsNotFound} not found`);
        console.log(`💰 Pricing: ${stats.manualPrices} manual, ${stats.jupiterPrices} jupiter`);
        console.log(`❌ Failures: ${stats.priceFailures} price, ${stats.errors} total`);
        console.log(`🎯 Method: ${stats.config.priceMethod}`);
    }

    async runFullTest(tokenAddress) {
        try {
            console.log('🚀 SIMPLE TRADING BOT FULL TEST');
            console.log('='.repeat(50));
            console.log(`🎯 Token: ${tokenAddress}`);
            console.log('');
            
            // Step 1: Auto pool discovery
            console.log('1️⃣ AUTO POOL DISCOVERY TEST');
            const poolResult = await this.testAutoPoolDiscovery(tokenAddress);
            
            // Step 2: Smart pricing
            console.log('\n2️⃣ SMART PRICING TEST');
            const priceResult = await this.testSmartPricing(tokenAddress);
            
            // Step 3: Position creation
            console.log('\n3️⃣ POSITION CREATION TEST');
            const positionResult = await this.testPositionCreation(tokenAddress);
            
            // Step 4: Price monitoring (if position created)
            if (positionResult.success) {
                console.log('\n4️⃣ PRICE MONITORING TEST');
                await this.testPriceMonitoring(positionResult.position, 20000); // 20 seconds
            }
            
            // Step 5: Show final stats
            console.log('\n5️⃣ FINAL STATS');
            await this.showTradingBotStats();
            
            console.log('\n' + '='.repeat(50));
            console.log('🎉 SIMPLE TRADING BOT TEST COMPLETED!');
            
            // Final assessment
            console.log('\n💡 RESULTS SUMMARY:');
            console.log(`   🔍 Pool Discovery: ${poolResult.success ? '✅ Working' : '❌ Failed'}`);
            console.log(`   💰 Smart Pricing: ${priceResult.success ? '✅ Working' : '❌ Failed'}`);
            console.log(`   📊 Position Creation: ${positionResult.success ? '✅ Working' : '❌ Failed'}`);
            
            if (priceResult.success) {
                console.log(`   🚀 Price Source: ${priceResult.source}`);
                console.log(`   ⚡ Speed: ${priceResult.duration}ms`);
            }
            
            if (poolResult.success && priceResult.success && positionResult.success) {
                console.log('\n🎉 PERFECT! Simple trading bot is fully working!');
                console.log('🚀 Ready for production use!');
                
                if (priceResult.source === 'manual') {
                    console.log('⚡ Using FAST manual price calculation via auto-discovered pool!');
                } else {
                    console.log('🪐 Using Jupiter fallback (manual method may need debugging)');
                }
            } else {
                console.log('\n⚠️ Some components need attention - check error messages above');
            }
            
            return {
                poolResult,
                priceResult,
                positionResult,
                overallSuccess: poolResult.success && priceResult.success && positionResult.success
            };
            
        } catch (error) {
            logger.error('❌ Full test failed:', error);
            throw error;
        }
    }
}

// CLI usage
async function main() {
    const tokenAddress = process.argv[2] || 'HQC1xWpfKArsr6g8vBPn6MrgiePPPMPZ7uaHaAxYpump';
    const testType = process.argv[3] || 'full';
    
    console.log('🧪 TESTING SIMPLE TRADING BOT');
    console.log('='.repeat(40));
    console.log(`🎯 Token: ${tokenAddress}`);
    console.log(`🔧 Test type: ${testType}`);
    console.log('');
    
    if (tokenAddress === 'help' || tokenAddress === '--help') {
        console.log('Usage: node scripts/testSimpleTradingBot.js [TOKEN_ADDRESS] [TEST_TYPE]');
        console.log('');
        console.log('Examples:');
        console.log('  # Test complete simple trading bot');
        console.log('  node scripts/testSimpleTradingBot.js HQC1xWpfKArsr6g8vBPn6MrgiePPPMPZ7uaHaAxYpump');
        console.log('');
        console.log('  # Test pool discovery only');
        console.log('  node scripts/testSimpleTradingBot.js HQC1x... pool');
        console.log('');
        console.log('  # Test pricing only');
        console.log('  node scripts/testSimpleTradingBot.js HQC1x... price');
        console.log('');
        console.log('Test types:');
        console.log('  full     - Complete test (pool + price + position + monitoring)');
        console.log('  pool     - Pool discovery test only');
        console.log('  price    - Smart pricing test only');
        console.log('  position - Position creation test only');
        process.exit(0);
    }
    
    try {
        const tester = new SimpleTradingBotTester();
        
        console.log('🔧 Initializing simple trading bot...');
        await tester.initialize();
        
        if (testType === 'pool') {
            console.log('\n🔍 Running pool discovery test only...');
            await tester.testAutoPoolDiscovery(tokenAddress);
        } else if (testType === 'price') {
            console.log('\n💰 Running pricing test only...');
            await tester.testSmartPricing(tokenAddress);
        } else if (testType === 'position') {
            console.log('\n📊 Running position creation test only...');
            await tester.testPositionCreation(tokenAddress);
        } else {
            console.log('\n🚀 Running full test suite...');
            await tester.runFullTest(tokenAddress);
        }
        
        console.log('\n✅ Test completed successfully!');
        
    } catch (error) {
        logger.error('❌ Test failed:', error);
        console.log('\n🔧 TROUBLESHOOTING:');
        console.log('1. Check your .env configuration');
        console.log('2. Verify network connectivity');
        console.log('3. Ensure PumpSwap SDK is installed');
        console.log('4. Try with a different token');
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = SimpleTradingBotTester;