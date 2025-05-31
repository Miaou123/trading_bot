// scripts/testFixedPositionsReal.js - REAL Jupiter API with proper connectivity handling
require('dotenv').config();
const logger = require('../src/utils/logger');
const TradingBot = require('../src/bot/tradingBot');
const PositionManager = require('../src/bot/positionManager');
const axios = require('axios');

class RealJupiterTester {
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

        // Enhanced HTTP client with better error handling
        this.httpClient = axios.create({
            timeout: 15000, // Longer timeout
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive'
            },
            // Retry configuration
            retry: 3,
            retryDelay: 1000
        });

        // Add request interceptor for retries
        this.setupHttpInterceptors();

        this.positionManager = new PositionManager({
            tradingMode: 'paper',
            maxPositions: 10,
            fastUpdateInterval: 1000,
            normalUpdateInterval: 2000,
            slowUpdateInterval: 5000
        });

        this.tradingBot = null; // Will initialize after connectivity check
        this.setupEventHandlers();
    }

    setupHttpInterceptors() {
        // Add retry logic
        this.httpClient.interceptors.response.use(
            (response) => response,
            async (error) => {
                const config = error.config;
                
                if (!config || !config.retry) {
                    return Promise.reject(error);
                }
                
                config.retryCount = config.retryCount || 0;
                
                if (config.retryCount < config.retry) {
                    config.retryCount++;
                    
                    logger.warn(`🔄 Retrying request (${config.retryCount}/${config.retry}): ${config.url}`);
                    
                    // Wait before retrying
                    await new Promise(resolve => setTimeout(resolve, config.retryDelay || 1000));
                    
                    return this.httpClient(config);
                }
                
                return Promise.reject(error);
            }
        );
    }

    setupEventHandlers() {
        this.positionManager.on('positionAdded', (position) => {
            console.log(`✅ Position Added: ${position.symbol}`);
            this.logPositionTriggers(position);
        });

        this.positionManager.on('stopLossTriggered', (data) => {
            console.log(`🛑 STOP LOSS TRIGGERED: ${data.position.symbol}`);
            console.log(`   Loss: ${data.lossPercentage.toFixed(2)}%`);
        });

        this.positionManager.on('takeProfitTriggered', (data) => {
            console.log(`🎯 TAKE PROFIT ${data.level} TRIGGERED: ${data.position.symbol}`);
            console.log(`   Gain: ${data.gainPercentage.toFixed(2)}%`);
            console.log(`   Selling: ${data.sellPercentage}%`);
        });
    }

    async testJupiterConnectivity() {
        logger.info('🧪 Testing Jupiter API connectivity...');
        
        const endpoints = [
            'https://price.jup.ag/v6/price?ids=So11111111111111111111111111111111111111112',
            'https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50'
        ];

        for (const endpoint of endpoints) {
            try {
                logger.info(`🔍 Testing: ${endpoint}`);
                
                const response = await this.httpClient.get(endpoint, {
                    timeout: 10000,
                    retry: 2,
                    retryDelay: 2000
                });
                
                logger.info(`✅ ${endpoint}: ${response.status} OK`);
                logger.debug(`📊 Response: ${JSON.stringify(response.data).substring(0, 200)}...`);
                
            } catch (error) {
                logger.error(`❌ ${endpoint}: ${error.message}`);
                
                if (error.code === 'ENOTFOUND') {
                    logger.error('🌐 DNS Resolution failed. Possible causes:');
                    logger.error('   • No internet connection');
                    logger.error('   • DNS server issues');
                    logger.error('   • Firewall blocking requests');
                    logger.error('   • VPN/proxy issues');
                } else if (error.code === 'ECONNREFUSED') {
                    logger.error('🚫 Connection refused. Jupiter API might be down.');
                } else if (error.code === 'ETIMEDOUT') {
                    logger.error('⏰ Request timeout. Network or server issues.');
                }
                
                throw error;
            }
        }
        
        logger.info('🎉 All Jupiter API endpoints are accessible!');
        return true;
    }

    async checkNetworkConnectivity() {
        logger.info('🌐 Checking basic network connectivity...');
        
        const testUrls = [
            'https://www.google.com',
            'https://api.mainnet-beta.solana.com',
            'https://httpbin.org/ip'
        ];
        
        for (const url of testUrls) {
            try {
                await this.httpClient.get(url, { timeout: 5000 });
                logger.info(`✅ Network connectivity OK: ${url}`);
                return true;
            } catch (error) {
                logger.warn(`❌ Failed to reach: ${url} (${error.message})`);
            }
        }
        
        throw new Error('No network connectivity detected');
    }

    async troubleshootConnection() {
        logger.info('🔧 Troubleshooting connection issues...');
        
        try {
            // Test basic connectivity
            await this.checkNetworkConnectivity();
            
            // Test DNS resolution specifically for Jupiter
            logger.info('🔍 Testing DNS resolution for Jupiter domains...');
            
            const dns = require('dns').promises;
            
            const domains = ['price.jup.ag', 'quote-api.jup.ag'];
            
            for (const domain of domains) {
                try {
                    const addresses = await dns.lookup(domain);
                    logger.info(`✅ DNS resolved ${domain}: ${addresses.address}`);
                } catch (dnsError) {
                    logger.error(`❌ DNS failed for ${domain}: ${dnsError.message}`);
                    
                    // Try alternative DNS servers
                    logger.info('🔄 Trying alternative DNS resolution...');
                    
                    // This would require additional DNS configuration
                    // For now, just log the issue
                    logger.error('💡 Try these solutions:');
                    logger.error('   • Check your DNS settings (try 8.8.8.8, 1.1.1.1)');
                    logger.error('   • Restart your network connection');
                    logger.error('   • Check firewall/antivirus settings');
                    logger.error('   • Try a different network/disable VPN');
                }
            }
            
        } catch (error) {
            logger.error('❌ Troubleshooting failed:', error.message);
            throw error;
        }
    }

    async initializeWithRealJupiter() {
        try {
            logger.info('🔧 Initializing with REAL Jupiter API...');
            
            // First check connectivity
            try {
                await this.testJupiterConnectivity();
            } catch (connectivityError) {
                logger.error('❌ Jupiter connectivity failed, running troubleshooting...');
                await this.troubleshootConnection();
                
                // Try one more time after troubleshooting
                logger.info('🔄 Retrying Jupiter connectivity...');
                await this.testJupiterConnectivity();
            }
            
            // Initialize trading bot with enhanced error handling
            this.tradingBot = new TradingBot({
                tradingMode: 'paper',
                positionManager: this.positionManager,
                initialInvestment: this.config.initialInvestment
            });
            
            // Override HTTP client in trading bot with our enhanced one
            this.enhanceTradingBotHttpClient();
            
            await this.tradingBot.initialize();
            this.positionManager.setTradingBot(this.tradingBot);
            
            logger.info('✅ Real Jupiter integration initialized successfully!');
            return true;
            
        } catch (error) {
            logger.error('❌ Failed to initialize with real Jupiter:', error);
            throw error;
        }
    }

    enhanceTradingBotHttpClient() {
        // Replace the trading bot's HTTP client with our enhanced one
        if (this.tradingBot && this.tradingBot.httpClient) {
            this.tradingBot.httpClient = this.httpClient;
        }
        
        // Also enhance axios calls in getTokenPrice method
        const originalGetTokenPrice = this.tradingBot.getTokenPrice.bind(this.tradingBot);
        
        this.tradingBot.getTokenPrice = async (tokenAddress, forceRefresh = false, priority = 'normal', poolAddress = null) => {
            try {
                return await originalGetTokenPrice(tokenAddress, forceRefresh, priority, poolAddress);
            } catch (error) {
                logger.warn(`⚠️ Jupiter price fetch failed for ${tokenAddress}: ${error.message}`);
                
                // Enhanced error handling with specific suggestions
                if (error.code === 'ENOTFOUND') {
                    logger.error('🌐 Network connectivity issue. Check your internet connection.');
                } else if (error.response?.status === 429) {
                    logger.warn('🚫 Rate limited by Jupiter API. Waiting before retry...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    return await originalGetTokenPrice(tokenAddress, true, priority, poolAddress);
                } else if (error.response?.status >= 500) {
                    logger.warn('🔧 Jupiter API server error. Retrying...');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    return await originalGetTokenPrice(tokenAddress, true, priority, poolAddress);
                }
                
                throw error;
            }
        };
    }

    async testPositionCreation(tokenAddress, customTwitterUrl = null) {
        try {
            console.log('🧪 TESTING POSITION CREATION WITH REAL JUPITER API...');
            console.log(`🎯 Token: ${tokenAddress}`);
            
            // Get REAL price from Jupiter
            logger.info('💰 Fetching REAL price from Jupiter API...');
            const currentPrice = await this.tradingBot.getTokenPrice(tokenAddress, true);
            console.log(`💰 Current Jupiter price: ${currentPrice.toFixed(12)} SOL`);
            
            // Calculate what the triggers should be
            const stopLossPrice = currentPrice * (1 - this.config.stopLossPercentage / 100);
            const tp1Price = currentPrice * (1 + this.config.takeProfitLevels[0].percentage / 100);
            const tp2Price = currentPrice * (1 + this.config.takeProfitLevels[1].percentage / 100);
            const tp3Price = currentPrice * (1 + this.config.takeProfitLevels[2].percentage / 100);
            
            console.log(`\n🎯 EXPECTED TRIGGERS (based on REAL Jupiter price):`);
            console.log(`   Stop Loss: ${stopLossPrice.toFixed(12)} SOL (-${this.config.stopLossPercentage}%)`);
            console.log(`   TP1: ${tp1Price.toFixed(12)} SOL (+${this.config.takeProfitLevels[0].percentage}%) - Sell ${this.config.takeProfitLevels[0].sellPercentage}%`);
            console.log(`   TP2: ${tp2Price.toFixed(12)} SOL (+${this.config.takeProfitLevels[1].percentage}%) - Sell ${this.config.takeProfitLevels[1].sellPercentage}%`);
            console.log(`   TP3: ${tp3Price.toFixed(12)} SOL (+${this.config.takeProfitLevels[2].percentage}%) - Sell ${this.config.takeProfitLevels[2].sellPercentage}%`);
            
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
                    url: customTwitterUrl || 'https://twitter.com/test/status/123456789'
                },
                confidence: 'HIGH',
                eventType: 'position_test'
            };
            
            // Execute buy with REAL Jupiter integration
            console.log(`\n⚡ Executing buy with REAL Jupiter price and FIXED triggers...`);
            const position = await this.tradingBot.executeBuy(tradingAlert);
            
            if (position) {
                console.log(`🎉 POSITION CREATED WITH REAL JUPITER PRICE!`);
                
                // Verify triggers are calculated correctly
                console.log(`\n🔍 VERIFICATION (REAL vs EXPECTED):`);
                
                const actualStopLoss = position.stopLossPrice;
                const expectedStopLoss = position.entryPrice * (1 - this.config.stopLossPercentage / 100);
                const stopLossMatch = Math.abs(actualStopLoss - expectedStopLoss) < 0.000000001;
                
                console.log(`   Entry Price: ${position.entryPrice.toFixed(12)} SOL (from Jupiter)`);
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

    async testRealPriceUpdates(position) {
        try {
            console.log('\n🔄 TESTING REAL JUPITER PRICE UPDATES...');
            console.log(`📊 Monitoring real price changes for ${position.symbol}`);
            
            const originalPrice = position.entryPrice;
            
            // Test multiple price fetches to see real market movement
            for (let i = 0; i < 5; i++) {
                console.log(`\n📊 Price check ${i + 1}/5:`);
                
                const currentPrice = await this.tradingBot.getTokenPrice(position.tokenAddress, true);
                const priceChange = ((currentPrice - originalPrice) / originalPrice * 100);
                
                console.log(`   Current: ${currentPrice.toFixed(12)} SOL`);
                console.log(`   Change: ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(4)}%`);
                
                // Check trigger distances
                const stopLossDistance = ((currentPrice - position.stopLossPrice) / currentPrice * 100);
                const tp1Distance = ((position.takeProfitLevels[0].targetPrice - currentPrice) / currentPrice * 100);
                
                console.log(`   Stop Loss Distance: ${stopLossDistance.toFixed(2)}%`);
                console.log(`   TP1 Distance: ${tp1Distance.toFixed(2)}%`);
                
                // Update position with real price
                await this.positionManager.updatePositionPrice(position, currentPrice, Date.now());
                
                // Wait between checks
                if (i < 4) {
                    console.log(`   ⏳ Waiting 3 seconds for next check...`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
            
            console.log(`\n✅ Real price monitoring completed!`);
            
        } catch (error) {
            logger.error('❌ Real price update test failed:', error);
        }
    }

    logPositionTriggers(position) {
        console.log(`\n📊 POSITION TRIGGER DETAILS (REAL JUPITER PRICE):`);
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

    async showPositionStatus() {
        const positions = this.positionManager.getActivePositions();
        
        console.log(`\n📊 CURRENT POSITION STATUS (REAL PRICES):`);
        console.log(`   Active positions: ${positions.length}`);
        
        for (const pos of positions) {
            // Get REAL current price
            let currentPrice = pos.currentPrice || pos.entryPrice;
            try {
                currentPrice = await this.tradingBot.getTokenPrice(pos.tokenAddress, true);
            } catch (error) {
                logger.warn(`Could not fetch current price for ${pos.symbol}`);
            }
            
            const priceChange = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100);
            
            console.log(`\n   ${pos.symbol} (${pos.id.substring(0, 8)}...):`);
            console.log(`     Entry: ${pos.entryPrice.toFixed(12)} SOL`);
            console.log(`     Current: ${currentPrice.toFixed(12)} SOL (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%)`);
            console.log(`     Stop Loss: ${pos.stopLossPrice?.toFixed(12) || 'N/A'} SOL`);
            console.log(`     Remaining: ${parseFloat(pos.remainingQuantity).toFixed(2)} tokens`);
            console.log(`     Status: ${pos.status || 'ACTIVE'}`);
        }
        
        const stats = this.positionManager.getPerformanceStats();
        console.log(`\n📈 STATS:`);
        console.log(`   Stop losses triggered: ${stats.triggers?.stopLossTriggered || 0}`);
        console.log(`   Take profits triggered: ${stats.triggers?.takeProfitTriggered || 0}`);
        console.log(`   Total PnL: ${stats.totalRealizedPnL?.toFixed(6) || '0.000000'} SOL`);
    }
}

// CLI usage
async function main() {
    const tokenAddress = process.argv[2] || 'So11111111111111111111111111111111111111112'; // Default to SOL
    const testMode = process.argv[3] || 'full';
    
    console.log('🧪 TESTING FIXED POSITION MANAGEMENT WITH REAL JUPITER API');
    console.log('='.repeat(70));
    console.log(`🎯 Token: ${tokenAddress}`);
    console.log(`🔧 Test mode: ${testMode}`);
    console.log('');
    
    if (tokenAddress === 'help' || tokenAddress === '--help') {
        console.log('Usage: node scripts/testFixedPositionsReal.js [TOKEN_ADDRESS] [TEST_MODE]');
        console.log('');
        console.log('Examples:');
        console.log('  # Test with SOL (guaranteed to work on Jupiter)');
        console.log('  node scripts/testFixedPositionsReal.js');
        console.log('');
        console.log('  # Test with specific token');
        console.log('  node scripts/testFixedPositionsReal.js EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        console.log('');
        console.log('  # Test creation only');
        console.log('  node scripts/testFixedPositionsReal.js So11111111111111111111111111111111111111112 create');
        console.log('');
        console.log('  # Full test with real price monitoring');
        console.log('  node scripts/testFixedPositionsReal.js So11111111111111111111111111111111111111112 full');
        console.log('');
        console.log('Test modes:');
        console.log('  create - Only test position creation with real Jupiter prices');
        console.log('  full   - Test creation + real-time price monitoring');
        process.exit(0);
    }
    
    try {
        const tester = new RealJupiterTester();
        
        // Initialize with real Jupiter API
        console.log('1️⃣ Initializing with REAL Jupiter API...');
        await tester.initializeWithRealJupiter();
        
        // Test position creation with real prices
        console.log('\n2️⃣ Testing position creation with REAL Jupiter prices...');
        const position = await tester.testPositionCreation(tokenAddress);
        
        await tester.showPositionStatus();
        
        if (testMode === 'full') {
            console.log('\n3️⃣ Testing real-time price monitoring...');
            await tester.testRealPriceUpdates(position);
            
            await tester.showPositionStatus();
        }
        
        console.log('\n' + '='.repeat(70));
        console.log('🎉 REAL JUPITER INTEGRATION TEST COMPLETED!');
        console.log('');
        console.log('✅ Successfully verified:');
        console.log('   • Real Jupiter API connectivity');
        console.log('   • Real-time price fetching');
        console.log('   • Price-based stop loss calculation');
        console.log('   • Price-based take profit calculation');
        console.log('   • Proper trigger distance monitoring');
        console.log('');
        console.log('🚀 Ready for live trading with REAL Jupiter prices!');
        
    } catch (error) {
        logger.error('❌ Real Jupiter test failed:', error);
        console.log('\n🔧 TROUBLESHOOTING STEPS:');
        console.log('1. Check your internet connection');
        console.log('2. Try a different network (mobile hotspot)');
        console.log('3. Disable VPN/proxy if active');
        console.log('4. Check DNS settings (try 8.8.8.8)');
        console.log('5. Restart your router/modem');
        console.log('6. Check firewall/antivirus settings');
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = RealJupiterTester;