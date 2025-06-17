// scripts/testPoolDerivation.js - Test pool derivation for specific tokens
require('dotenv').config();
const PumpSwapService = require('../src/services/pumpSwapService');

class PoolDerivationTester {
    constructor() {
        this.pumpSwapService = new PumpSwapService({
            privateKey: process.env.PRIVATE_KEY,
            maxRetries: 5,
            retryDelay: 1000
        });
    }

    async testSpecificToken(tokenMint, expectedPool = null) {
        console.log('🧪 POOL DERIVATION TEST');
        console.log('=' .repeat(40));
        console.log(`🎯 Token: ${tokenMint}`);
        if (expectedPool) {
            console.log(`🎯 Expected Pool: ${expectedPool}`);
        }
        console.log('');

        try {
            // Test the enhanced pool finding
            console.log('🔍 Testing enhanced pool derivation...');
            const foundPool = await this.pumpSwapService.findPool(tokenMint);
            
            if (foundPool) {
                console.log(`✅ POOL FOUND: ${foundPool.toString()}`);
                
                if (expectedPool && foundPool.toString() === expectedPool) {
                    console.log(`🎉 PERFECT MATCH: Found pool matches expected!`);
                } else if (expectedPool) {
                    console.log(`⚠️ MISMATCH: Found ${foundPool.toString()}`);
                    console.log(`⚠️          Expected ${expectedPool}`);
                }
                
                // Test market data retrieval
                console.log('\n📊 Testing market data retrieval...');
                const marketData = await this.pumpSwapService.getMarketData(tokenMint);
                
                if (marketData) {
                    console.log(`✅ Market data retrieved successfully:`);
                    console.log(`   Pool: ${marketData.poolAddress}`);
                    console.log(`   Price: ${marketData.price.toFixed(12)} SOL`);
                    console.log(`   Base Reserve: ${marketData.baseReserve.toFixed(2)}`);
                    console.log(`   Quote Reserve: ${marketData.quoteReserve.toFixed(6)} SOL`);
                    console.log(`   TVL: ${marketData.tvl.toFixed(2)} SOL`);
                } else {
                    console.log(`❌ Could not retrieve market data`);
                }
                
            } else {
                console.log(`❌ POOL NOT FOUND after ${this.pumpSwapService.config.maxRetries} attempts`);
            }

            // Show stats
            const stats = this.pumpSwapService.getStats();
            console.log('\n📊 DERIVATION STATS:');
            console.log(`   Pools derived: ${stats.poolsDerivied}`);
            console.log(`   Pools found: ${stats.poolsFound}`);
            console.log(`   Pools not found: ${stats.poolsNotFound}`);
            console.log(`   Retry attempts: ${stats.retryAttempts}`);
            console.log(`   Success rate: ${stats.successRate}`);
            console.log(`   Retry success rate: ${stats.retrySuccessRate}`);

        } catch (error) {
            console.error(`❌ Test failed: ${error.message}`);
        }
    }

    async testMultipleTokens() {
        const testCases = [
            {
                name: "ESMhjJ3GHMLw9vu3PvuvgSZXVLPKoZ6CYs71LgYGpump",
                token: "ESMhjJ3GHMLw9vu3PvuvgSZXVLPKoZ6CYs71LgYGpump",
                expectedPool: "9PDtaUujwSmAEe3CdmT5qY8TdYs66iaQ5MSHFvcZ2ffz"
            },
            {
                name: "Recently failed token 1",
                token: "8gtsj9Qdp2KQD7xAU838Po1Zkw2ZCti2HtE3Z6Sqpump"
            },
            {
                name: "Recently failed token 2", 
                token: "8mxXR9cyiEsPBvhXKBecrH6TxJA2bvLyyrHZtjUupump"
            }
        ];

        for (let i = 0; i < testCases.length; i++) {
            const testCase = testCases[i];
            
            console.log(`\n${'='.repeat(60)}`);
            console.log(`TEST ${i + 1}/${testCases.length}: ${testCase.name}`);
            console.log(`${'='.repeat(60)}`);
            
            await this.testSpecificToken(testCase.token, testCase.expectedPool);
            
            if (i < testCases.length - 1) {
                console.log('\n⏳ Waiting 2 seconds before next test...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
}

async function main() {
    const tokenToTest = process.argv[2];
    const expectedPool = process.argv[3];
    
    if (!tokenToTest) {
        console.log('🧪 POOL DERIVATION TESTER');
        console.log('=' .repeat(30));
        console.log('');
        console.log('Usage: node scripts/testPoolDerivation.js <TOKEN_ADDRESS> [EXPECTED_POOL]');
        console.log('');
        console.log('Examples:');
        console.log('  # Test single token');
        console.log('  node scripts/testPoolDerivation.js ESMhjJ3GHMLw9vu3PvuvgSZXVLPKoZ6CYs71LgYGpump');
        console.log('');
        console.log('  # Test with expected pool');
        console.log('  node scripts/testPoolDerivation.js ESMhjJ3GHMLw9vu3PvuvgSZXVLPKoZ6CYs71LgYGpump 9PDtaUujwSmAEe3CdmT5qY8TdYs66iaQ5MSHFvcZ2ffz');
        console.log('');
        console.log('  # Test multiple recent tokens');
        console.log('  node scripts/testPoolDerivation.js --multiple');
        console.log('');
        return;
    }

    const tester = new PoolDerivationTester();
    
    if (tokenToTest === '--multiple') {
        await tester.testMultipleTokens();
    } else {
        await tester.testSpecificToken(tokenToTest, expectedPool);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = PoolDerivationTester;