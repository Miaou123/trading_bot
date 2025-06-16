// scripts/testPumpSwapService.js - Simple REAL buy/sell test
require('dotenv').config();
const PumpSwapService = require('../src/services/pumpSwapService');
const logger = require('../src/utils/logger');

class SimplePumpSwapTester {
    constructor() {
        this.service = new PumpSwapService({
            privateKey: process.env.PRIVATE_KEY,
            slippageTolerance: 5
        });
    }

    async testBuy(tokenAddress, solAmount) {
        try {
            console.log(`\n🚀 TESTING REAL BUY`);
            console.log(`Token: ${tokenAddress}`);
            console.log(`Amount: ${solAmount} SOL`);
            console.log('='.repeat(50));

            const result = await this.service.executeBuy(tokenAddress, solAmount);
            
            if (result.success) {
                console.log(`✅ BUY SUCCESS!`);
                console.log(`   Signature: ${result.signature}`);
                console.log(`   SOL Spent: ${result.solSpent} SOL`);
                console.log(`   Explorer: https://solscan.io/tx/${result.signature}`);
                return result;
            } else {
                console.log(`❌ BUY FAILED: ${result.error}`);
                return null;
            }
        } catch (error) {
            console.log(`❌ BUY ERROR: ${error.message}`);
            return null;
        }
    }

    async testSell(tokenAddress, tokenAmount) {
        try {
            console.log(`\n🚀 TESTING REAL SELL`);
            console.log(`Token: ${tokenAddress}`);
            console.log(`Amount: ${tokenAmount} tokens`);
            console.log('='.repeat(50));

            const result = await this.service.executeSell(tokenAddress, tokenAmount);
            
            if (result.success) {
                console.log(`✅ SELL SUCCESS!`);
                console.log(`   Signature: ${result.signature}`);
                console.log(`   SOL Received: ${result.solReceived} SOL`);
                console.log(`   Tokens Spent: ${result.tokensSpent} tokens`);
                console.log(`   Explorer: https://solscan.io/tx/${result.signature}`);
                return result;
            } else {
                console.log(`❌ SELL FAILED: ${result.error}`);
                return null;
            }
        } catch (error) {
            console.log(`❌ SELL ERROR: ${error.message}`);
            return null;
        }
    }

    async getTokenBalance(tokenAddress) {
        try {
            const balance = await this.service.getTokenBalance(tokenAddress);
            console.log(`💰 Current token balance: ${balance.toFixed(6)} tokens`);
            return balance;
        } catch (error) {
            console.log(`❌ Balance check failed: ${error.message}`);
            return 0;
        }
    }

    async testBuyThenSell(tokenAddress, solAmount, sellPercentage = 100) {
        try {
            console.log(`\n🧪 FULL TEST: BUY → SELL`);
            console.log(`Token: ${tokenAddress}`);
            console.log(`Buy: ${solAmount} SOL`);
            console.log(`Sell: ${sellPercentage}% of tokens received`);
            console.log('='.repeat(60));

            // Step 1: Buy
            const buyResult = await this.testBuy(tokenAddress, solAmount);
            if (!buyResult) {
                console.log(`❌ Test failed at buy step`);
                return false;
            }

            // Step 2: Wait a moment
            console.log(`\n⏳ Waiting 5 seconds for transaction to settle...`);
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Step 3: Check balance
            const balance = await this.getTokenBalance(tokenAddress);
            if (balance <= 0) {
                console.log(`❌ No tokens found in wallet to sell`);
                return false;
            }

            // Step 4: Sell
            const sellAmount = balance * (sellPercentage / 100);
            if (sellAmount <= 0) {
                console.log(`❌ No tokens to sell`);
                return false;
            }

            const sellResult = await this.testSell(tokenAddress, sellAmount);
            if (!sellResult) {
                console.log(`❌ Test failed at sell step`);
                return false;
            }

            // Step 5: Calculate results
            const netSOL = sellResult.solReceived - buyResult.solSpent;
            const percentChange = ((sellResult.solReceived - buyResult.solSpent) / buyResult.solSpent) * 100;

            console.log(`\n📊 FINAL RESULTS:`);
            console.log(`=`.repeat(30));
            console.log(`   SOL Spent: ${buyResult.solSpent} SOL`);
            console.log(`   SOL Received: ${sellResult.solReceived} SOL`);
            console.log(`   Net P&L: ${netSOL > 0 ? '+' : ''}${netSOL.toFixed(6)} SOL`);
            console.log(`   Percentage: ${percentChange > 0 ? '+' : ''}${percentChange.toFixed(2)}%`);
            console.log(`   Buy TX: https://solscan.io/tx/${buyResult.signature}`);
            console.log(`   Sell TX: https://solscan.io/tx/${sellResult.signature}`);

            console.log(`\n🎉 FULL TEST COMPLETED SUCCESSFULLY!`);
            return true;

        } catch (error) {
            console.log(`❌ Full test failed: ${error.message}`);
            return false;
        }
    }

    async showMarketInfo(tokenAddress) {
        try {
            console.log(`\n📊 MARKET INFO FOR: ${tokenAddress}`);
            console.log('='.repeat(50));

            const marketData = await this.service.getMarketData(tokenAddress);
            if (marketData) {
                console.log(`✅ Pool found: ${marketData.poolAddress}`);
                console.log(`💰 Current price: ${marketData.price.toFixed(12)} SOL per token`);
                console.log(`🏊 Base reserve: ${marketData.baseReserve.toFixed(2)} tokens`);
                console.log(`🏊 Quote reserve: ${marketData.quoteReserve.toFixed(6)} SOL`);
                console.log(`📈 TVL: ~${marketData.tvl.toFixed(2)} SOL`);
                return marketData;
            } else {
                console.log(`❌ No market data found - token may not have a PumpSwap pool`);
                return null;
            }
        } catch (error) {
            console.log(`❌ Market info failed: ${error.message}`);
            return null;
        }
    }

    showStats() {
        const stats = this.service.getStats();
        console.log(`\n📊 PUMPSWAP SERVICE STATS:`);
        console.log('='.repeat(40));
        console.log(`   Pools derived: ${stats.poolsDerivied}`);
        console.log(`   Pools found: ${stats.poolsFound}`);
        console.log(`   Pools not found: ${stats.poolsNotFound}`);
        console.log(`   Buys executed: ${stats.buysExecuted}`);
        console.log(`   Sells executed: ${stats.sellsExecuted}`);
        console.log(`   Errors: ${stats.errors}`);
        console.log(`   Success rate: ${stats.successRate}`);
    }
}

// CLI interface
async function main() {
    const tokenAddress = process.argv[2];
    const action = process.argv[3] || 'both';
    const amount = parseFloat(process.argv[4]) || 0.001;
    const sellPercentage = parseFloat(process.argv[5]) || 100;

    if (!tokenAddress) {
        console.log('Usage: node scripts/testPumpSwapService.js <TOKEN_ADDRESS> [ACTION] [AMOUNT] [SELL_%]');
        console.log('');
        console.log('Actions:');
        console.log('  buy       - Execute only a buy');
        console.log('  sell      - Execute only a sell');
        console.log('  both      - Execute buy then sell (default)');
        console.log('  market    - Show market info only');
        console.log('  balance   - Check token balance only');
        console.log('');
        console.log('Examples:');
        console.log('  # Buy then sell (full test)');
        console.log('  node scripts/testPumpSwapService.js FeW9wDTnPWyTGVWLoLy9CVJ4ZYSj9vWcpW73mEnNpump');
        console.log('');
        console.log('  # Buy 0.005 SOL worth');
        console.log('  node scripts/testPumpSwapService.js FeW9wDTn... buy 0.005');
        console.log('');
        console.log('  # Sell 1000 tokens');
        console.log('  node scripts/testPumpSwapService.js FeW9wDTn... sell 1000');
        console.log('');
        console.log('  # Buy then sell 50%');
        console.log('  node scripts/testPumpSwapService.js FeW9wDTn... both 0.001 50');
        console.log('');
        console.log('⚠️  WARNING: This executes REAL transactions with REAL SOL!');
        process.exit(1);
    }

    // Safety confirmation
    if (action !== 'market' && action !== 'balance') {
        console.log('⚠️  🚨 REAL PUMPSWAP TRADING WARNING 🚨 ⚠️');
        console.log('');
        console.log('This will execute REAL PumpSwap transactions with REAL SOL!');
        console.log(`Token: ${tokenAddress}`);
        console.log(`Action: ${action}`);
        console.log(`Amount: ${amount}`);
        if (action === 'both') {
            console.log(`Sell percentage: ${sellPercentage}%`);
        }
        console.log('');

        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const confirm = await new Promise(resolve => {
            rl.question('Type "EXECUTE" to proceed with REAL PumpSwap trading: ', resolve);
        });

        rl.close();

        if (confirm !== 'EXECUTE') {
            console.log('❌ Trading cancelled');
            process.exit(0);
        }
    }

    try {
        const tester = new SimplePumpSwapTester();

        // Show market info first
        console.log(`🧪 PUMPSWAP SERVICE TEST`);
        console.log('='.repeat(60));
        const marketData = await tester.showMarketInfo(tokenAddress);
        
        if (!marketData && action !== 'market') {
            console.log(`❌ Cannot proceed - token doesn't have a PumpSwap pool`);
            process.exit(1);
        }

        // Execute requested action
        switch (action) {
            case 'market':
                // Already showed market info above
                break;
                
            case 'balance':
                await tester.getTokenBalance(tokenAddress);
                break;
                
            case 'buy':
                await tester.testBuy(tokenAddress, amount);
                break;
                
            case 'sell':
                await tester.testSell(tokenAddress, amount);
                break;
                
            case 'both':
            default:
                await tester.testBuyThenSell(tokenAddress, amount, sellPercentage);
                break;
        }

        // Show final stats
        tester.showStats();
        console.log(`\n✅ Test completed!`);

    } catch (error) {
        console.error(`❌ Test failed:`, error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = SimplePumpSwapTester;