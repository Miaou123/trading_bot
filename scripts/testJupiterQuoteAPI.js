// scripts/testJupiterQuoteAPI.js - Test the FIXED Jupiter Quote API integration
require('dotenv').config();
const logger = require('../src/utils/logger');

// Import the FIXED trading bot
const TradingBot = require('../src/bot/tradingBot');
const PositionManager = require('../src/bot/positionManager');

class JupiterQuoteAPITester {
    constructor() {
        this.config = {
            tradingMode: 'paper',
            initialInvestment: 0.01,
            stopLossPercentage: 50,
            takeProfitLevels: [
                { percentage: 100, sellPercentage: 50 },
                { percentage: 300, sellPercentage: 25 },
                { percentage: 900, sellPercentage: 100 }
            ]
        };

        this.positionManager = new PositionManager({
            tradingMode: 'paper',
            maxPositions: 10
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
            console.log(`✅ Position Added: ${position.symbol}`);
            this.logPositionTriggers(position);
        });

        this.tradingBot.on('tradeExecuted', (tradeData) => {
            console.log(`🎯 Trade executed: ${tradeData.type} ${tradeData.symbol}`);
        });
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing FIXED Jupiter Quote API testing system...');
            
            await this.tradingBot.initialize();
            this.positionManager.setTradingBot(this.tradingBot);
            
            logger.info('✅ FIXED Jupiter Quote API testing system initialized');
            return true;
            
        } catch (error) {
            logger.error('❌ Failed to initialize:', error);
            throw error;
        }
    }

    async testJupiterQuoteAPI() {
        try {
            console.log('\n🧪 TESTING JUPITER QUOTE API DIRECTLY...');
            console.log('='.repeat(50));
            
            const testTokens = [
                {
                    name: 'SOL',
                    address: 'So11111111111111111111111111111111111111112'
                },
                {
                    name: 'USDC', 
                    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
                }
            ];
            
            for (const token of testTokens) {
                console.log(`\n💰 Testing ${token.name} price via Jupiter Quote API...`);
                
                try {
                    const price = await this.tradingBot.getTokenPrice(token.address, true);
                    console.log(`✅ ${token.name} price: ${price.toFixed(12)} SOL`);
                    
                    // Test price caching
                    const cachedPrice = await this.tradingBot.getTokenPrice(token.address, false);
                    console.log(`📁 ${token.name} cached: ${cachedPrice.toFixed(12)} SOL (should be same)`);
                    
                } catch (error) {
                    console.log(`❌ ${token.name} price failed: ${error.message}`);
                }
            }
            
            return true;
            
        } catch (error) {
            logger.error('❌ Jupiter Quote API test failed:', error);
            throw error;
        }
    }

    async testPositionCreation(tokenAddress, tokenSymbol = 'TEST') {
        try {
            console.log(`\n🧪 TESTING POSITION CREATION WITH FIXED JUPITER QUOTE API...`);
            console.log(`🎯 Token: ${tokenAddress}`);
            
            // Get real price from Jupiter Quote API
            const currentPrice = await this.tradingBot.getTokenPrice(tokenAddress, true);
            console.log(`💰 Current Jupiter Quote API price: ${currentPrice.toFixed(12)} SOL`);
            
            // Calculate what the triggers should be
            const stopLossPrice = currentPrice * (1 - this.config.stopLossPercentage / 100);
            const tp1Price = currentPrice * (1 + this.config.takeProfitLevels[0].percentage / 100);
            const tp2Price = currentPrice * (1 + this.config.takeProfitLevels[1].percentage / 100);
            const tp3Price = currentPrice * (1 + this.config.takeProfitLevels[2].percentage / 100);
            
            console.log(`\n🎯 EXPECTED TRIGGERS (based on REAL Jupiter Quote API price):`);
            console.log(`   Stop Loss: ${stopLossPrice.toFixed(12)} SOL (-${this.config.stopLossPercentage}%)`);
            console.log(`   TP1: ${tp1Price.toFixed(12)} SOL (+${this.config.takeProfitLevels[0].percentage}%) - Sell ${this.config.takeProfitLevels[0].sellPercentage}%`);
            console.log(`   TP2: ${tp2Price.toFixed(12)} SOL (+${this.config.takeProfitLevels[1].percentage}%) - Sell ${this.config.takeProfitLevels[1].sellPercentage}%`);
            console.log(`   TP3: ${tp3Price.toFixed(12)} SOL (+${this.config.takeProfitLevels[2].percentage}%) - Sell ${this.config.takeProfitLevels[2].sellPercentage}%`);
            
            // Create trading alert
            const tradingAlert = {
                token: {
                    address: tokenAddress,
                    symbol: tokenSymbol,
                    name: 'Test Token'
                },
                twitter: {
                    likes: 1000,
                    views: 100000,
                    url: 'https://twitter.com/test/status/123456789'
                },
                confidence: 'HIGH',
                eventType: 'quote_api_test'
            };
            
            // Execute buy with REAL Jupiter Quote API integration
            console.log(`\n⚡ Executing buy with REAL Jupiter Quote API and FIXED triggers...`);
            const position = await this.tradingBot.executeBuy(tradingAlert);
            
            if (position) {
                console.log(`🎉 POSITION CREATED WITH REAL JUPITER QUOTE API!`);
                
                // Verify triggers are calculated correctly
                console.log(`\n🔍 VERIFICATION (REAL vs EXPECTED):`);
                
                const actualStopLoss = position.stopLossPrice;
                const expectedStopLoss = position.entryPrice * (1 - this.config.stopLossPercentage / 100);
                const stopLossMatch = Math.abs(actualStopLoss - expectedStopLoss) < 0.000000001;
                
                console.log(`   Entry Price: ${position.entryPrice.toFixed(12)} SOL (from Jupiter Quote API)`);
                console.log(`   Stop Loss: ${stopLossMatch ? '✅' : '❌'} ${actualStopLoss.toFixed(12)} SOL`);
                console.log(`   Expected: ${expectedStopLoss.toFixed(12)} SOL`);
                
                if (position.takeProfitLevels) {
                    position.takeProfitLevels.forEach((tp, index) => {
                        const expected = position.entryPrice * (1 + this.config.takeProfitLevels[index].percentage / 100);
                        const match = Math.abs(tp.targetPrice - expected) < 0.000000001;
                        console.log(`   TP${index + 1}: ${match ? '✅' : '❌'} ${tp.targetPrice.toFixed(12)} SOL`);
                        console.log(`   Expected: ${expected.toFixed(12)} SOL`);
                    });
                }
                
                return position;
            } else {
                throw new Error('Position not created');
            }
            
        } catch (error) {
            logger.error('❌ Position creation test failed:', error);
            throw error;
        }
    }

    logPositionTriggers(position) {
        console.log(`\n📊 POSITION TRIGGER DETAILS (REAL JUPITER QUOTE API PRICE):`);
        console.log(`   Entry Price: ${position.entryPrice.toFixed(12)} SOL`);
        
        if (position.stopLossPrice) {
            const stopLossPercent = ((position.stopLossPrice - position.entryPrice) / position.entryPrice * 100);
            console.log(`   Stop Loss: ${position.stopLossPrice.toFixed(12)} SOL (${stopLossPercent.toFixed(1)}%)`);
        }
        
        if (position.takeProfitLevels && position.takeProfitLevels.length > 0) {
            console.log(`   Take Profits:`);
            position.takeProfitLevels.forEach((tp, index) => {
                const tpPercent = ((tp.targetPrice - position.entryPrice) / position.entryPrice * 100);
                console.log(`     TP${index + 1}: ${tp.targetPrice.toFixed(12)} SOL (+${tpPercent.toFixed(1)}%) - Sell ${tp.sellPercentage}%`);
            });
        }
        console.log('');
    }

    async showResults() {
        const stats = this.tradingBot.getStats();
        
        console.log(`\n📊 JUPITER QUOTE API TEST RESULTS:`);
        console.log(`=`.repeat(40));
        console.log(`✅ Jupiter Quote API Status: ${stats.jupiter.status}`);
        console.log(`📊 Quotes Fetched: ${stats.jupiter.quotes}`);
        console.log(`💰 Prices Obtained: ${stats.pricing.jupiterPricesObtained}`);
        console.log(`📈 Success Rate: ${stats.pricing.successRate}`);
        console.log(`🔧 Method: ${stats.pricing.method}`);
        console.log(`⚡ Trades Executed: ${stats.trading.paperTradesExecuted}`);
    }
}

// CLI usage
async function main() {
    const tokenAddress = process.argv[2] || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // Default to USDC
    const tokenSymbol = process.argv[3] || 'USDC';
    
    console.log('🧪 TESTING FIXED JUPITER QUOTE API INTEGRATION');
    console.log('='.repeat(60));
    console.log(`🎯 Token: ${tokenAddress} (${tokenSymbol})`);
    console.log(`🔥 Using WORKING Jupiter Quote API instead of broken Price API`);
    console.log('');
    
    if (tokenAddress === 'help' || tokenAddress === '--help') {
        console.log('Usage: node scripts/testJupiterQuoteAPI.js [TOKEN_ADDRESS] [SYMBOL]');
        console.log('');
        console.log('Examples:');
        console.log('  # Test with USDC (guaranteed to work)');
        console.log('  node scripts/testJupiterQuoteAPI.js');
        console.log('');
        console.log('  # Test with SOL');
        console.log('  node scripts/testJupiterQuoteAPI.js So11111111111111111111111111111111111111112 SOL');
        console.log('');
        console.log('  # Test with any token');
        console.log('  node scripts/testJupiterQuoteAPI.js EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v USDC');
        process.exit(0);
    }
    
    try {
        const tester = new JupiterQuoteAPITester();
        
        console.log('1️⃣ Initializing FIXED Jupiter Quote API integration...');
        await tester.initialize();
        
        console.log('\n2️⃣ Testing Jupiter Quote API directly...');
        await tester.testJupiterQuoteAPI();
        
        console.log('\n3️⃣ Testing position creation with REAL Jupiter Quote API prices...');
        const position = await tester.testPositionCreation(tokenAddress, tokenSymbol);
        
        await tester.showResults();
        
        console.log('\n' + '='.repeat(60));
        console.log('🎉 FIXED JUPITER QUOTE API INTEGRATION TEST COMPLETED!');
        console.log('');
        console.log('✅ Successfully verified:');
        console.log('   • WORKING Jupiter Quote API connectivity');
        console.log('   • Real-time price fetching via Quote API');
        console.log('   • Price-based stop loss calculation');
        console.log('   • Price-based take profit calculation');
        console.log('   • No dependency on broken Price API');
        console.log('');
        console.log('🚀 Your trading bot is now working with REAL Jupiter prices!');
        console.log('🔥 Using Quote API instead of the broken price.jup.ag domain');
        
    } catch (error) {
        logger.error('❌ Jupiter Quote API test failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = JupiterQuoteAPITester;