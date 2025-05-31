// scripts/testToken.js - Test full WebSocket + Twitter flow
require('dotenv').config();
const logger = require('../src/utils/logger');
const TradingWebSocket = require('../src/services/tradingWebSocket');
const TradingBot = require('../src/bot/tradingBot');
const PositionManager = require('../src/bot/positionManager');

class FullFlowTester {
    constructor() {
        this.positionManager = new PositionManager({
            tradingMode: 'paper',
            maxPositions: 5
        });

        this.tradingBot = new TradingBot({
            tradingMode: 'paper',
            positionManager: this.positionManager,
            initialInvestment: 0.1
        });

        this.webSocket = new TradingWebSocket({
            minLikes: parseInt(process.env.MIN_TWITTER_LIKES) || 100
        });

        this.setupEventHandlers();
    }

    setupEventHandlers() {
        // Same as your app.js
        this.webSocket.on('qualifiedToken', async (tokenData) => {
            logger.info(`💰 QUALIFIED: ${tokenData.token.symbol} - Processing trade...`);
            
            try {
                await this.tradingBot.processAlert({
                    token: tokenData.token,
                    twitter: tokenData.twitter,
                    confidence: 'MEDIUM'
                });
                
                // Show results
                const positions = this.positionManager.getActivePositions();
                logger.info(`📊 Active positions: ${positions.length}`);
                
                if (positions.length > 0) {
                    const position = positions[0];
                    logger.info(`✅ Position created: ${position.symbol} @ ${position.entryPrice} SOL`);
                    logger.info(`💎 Quantity: ${parseFloat(position.quantity).toFixed(2)} tokens`);
                }
                
            } catch (error) {
                logger.error(`Error processing qualified token:`, error);
            }
        });

        this.tradingBot.on('tradeExecuted', (tradeData) => {
            logger.info(`🎯 Trade executed: ${tradeData.type} ${tradeData.symbol}`);
        });
    }

    async initialize() {
        await this.tradingBot.initialize();
        logger.info('✅ Trading bot initialized');
    }

    // Create fake token creation message like WebSocket would receive
    createFakeTokenMessage(tokenAddress, twitterUrl = null) {
        // Use the specific Twitter URL you want to test
        const defaultTwitterUrl = 'https://x.com/valvalval369/status/1928004736919163230';
        
        return {
            txType: 'create',
            mint: tokenAddress,
            name: 'Test Token',
            symbol: 'TEST',
            uri: null,
            traderPublicKey: 'fake_creator_address',
            signature: 'fake_signature_12345',
            twitter: twitterUrl || defaultTwitterUrl // Use your specific Twitter URL
        };
    }

    async testFullFlow(tokenAddress, twitterUrl = null) {
        try {
            logger.info(`🧪 Testing FULL FLOW for token: ${tokenAddress}`);
            
            // Use your specific Twitter URL if none provided
            const useTwitterUrl = twitterUrl || 'https://x.com/valvalval369/status/1928004736919163230';
            logger.info(`🔗 Twitter URL: ${useTwitterUrl}`);
            
            // Step 1: Test Twitter likes first
            logger.info(`🐦 Step 1: Testing Twitter likes...`);
            const likes = await this.webSocket.checkLikes(useTwitterUrl);
            const minLikes = this.webSocket.minLikes;
            
            logger.info(`📊 Twitter Results:`);
            logger.info(`   • Likes found: ${likes}`);
            logger.info(`   • Min required: ${minLikes}`);
            logger.info(`   • Qualifies: ${likes >= minLikes ? '✅ YES' : '❌ NO'}`);
            
            if (likes < minLikes) {
                logger.warn(`⏭️ Token would be SKIPPED due to insufficient likes`);
                return;
            }
            
            // Step 2: Create fake token message
            const tokenMessage = this.createFakeTokenMessage(tokenAddress, useTwitterUrl);
            logger.info(`📝 Step 2: Created fake token creation message with Twitter URL`);
            
            // Step 3: Process through WebSocket handler
            logger.info(`🔄 Step 3: Processing through WebSocket...`);
            await this.webSocket.processToken(tokenMessage);
            
            // Give it a moment to process
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Step 4: Check results
            const positions = this.positionManager.getActivePositions();
            logger.info(`📊 Final Results:`);
            logger.info(`   • Active positions: ${positions.length}`);
            
            if (positions.length > 0) {
                const position = positions[0];
                logger.info(`✅ SUCCESS! Position created:`);
                logger.info(`   • Token: ${position.symbol} @ ${position.entryPrice} SOL`);
                logger.info(`   • Quantity: ${parseFloat(position.quantity).toFixed(2)} tokens`);
                logger.info(`   • Investment: ${position.investedAmount} SOL`);
            } else {
                logger.warn(`❌ No positions created - check WebSocket processing`);
            }
            
            logger.info(`🔚 Full flow test completed`);
            
        } catch (error) {
            logger.error('❌ Full flow test failed:', error);
        }
    }

    async testTwitterOnly(twitterUrl) {
        try {
            logger.info(`🐦 Testing Twitter likes check only: ${twitterUrl}`);
            
            const likes = await this.webSocket.checkLikes(twitterUrl);
            const minLikes = this.webSocket.minLikes;
            
            logger.info(`📊 Results:`);
            logger.info(`   • Likes found: ${likes}`);
            logger.info(`   • Min required: ${minLikes}`);
            logger.info(`   • Qualifies: ${likes >= minLikes ? '✅ YES' : '❌ NO'}`);
            
        } catch (error) {
            logger.error('❌ Twitter test failed:', error);
        }
    }
}

// CLI usage
async function main() {
    const tokenAddress = process.argv[2];
    const twitterUrl = process.argv[3];
    const command = process.argv[4];
    
    if (!tokenAddress) {
        console.log('Usage:');
        console.log('  node scripts/testToken.js <TOKEN_ADDRESS> [TWITTER_URL] [twitter-only]');
        console.log('');
        console.log('Examples:');
        console.log('  # Full flow test (token + twitter extraction + trading)');
        console.log('  node scripts/testToken.js 7VnT8zHzorYS92snKC4CZU2veigEVnVVBSxTw7G1pump');
        console.log('');
        console.log('  # Full flow with specific Twitter URL');
        console.log('  node scripts/testToken.js 7VnT8zHzorYS92snKC4CZU2veigEVnVVBSxTw7G1pump https://twitter.com/elonmusk/status/123456789');
        console.log('');
        console.log('  # Test only Twitter likes checking');
        console.log('  node scripts/testToken.js any https://twitter.com/elonmusk/status/123456789 twitter-only');
        process.exit(1);
    }
    
    const tester = new FullFlowTester();
    await tester.initialize();
    
    if (command === 'twitter-only') {
        await tester.testTwitterOnly(twitterUrl);
    } else {
        await tester.testFullFlow(tokenAddress, twitterUrl);
    }
    
    process.exit(0);
}

if (require.main === module) {
    main();
}

module.exports = FullFlowTester;