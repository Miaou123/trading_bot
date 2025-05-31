// scripts/testManualPool.js - Test live trading with manual pool address
require('dotenv').config();
const logger = require('../src/utils/logger');
const TradingBot = require('../src/bot/tradingBot');
const PositionManager = require('../src/bot/positionManager');

class ManualPoolTester {
    constructor() {
        this.config = {
            tradingMode: 'live', // Force live trading
            initialInvestment: parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.01,
            privateKey: process.env.PRIVATE_KEY
        };

        if (!this.config.privateKey) {
            throw new Error('PRIVATE_KEY required for live trading!');
        }

        this.positionManager = new PositionManager({
            tradingMode: 'live',
            maxPositions: 10,
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
    }

    async initialize() {
        try {
            logger.info('🔥 INITIALIZING MANUAL POOL TEST...');
            logger.warn('⚠️  WARNING: REAL SOL WILL BE USED FOR TRADING');
            
            await this.tradingBot.initialize();
            this.positionManager.setTradingBot(this.tradingBot);
            
            logger.info('✅ Manual pool test system initialized');
            return true;
            
        } catch (error) {
            logger.error('❌ Failed to initialize:', error);
            throw error;
        }
    }

    async testWithManualPool(tokenAddress, poolAddress) {
        try {
            logger.info('🧪 TESTING WITH MANUAL POOL ADDRESS...');
            logger.info(`🎯 Token: ${tokenAddress}`);
            logger.info(`🏊 Pool: ${poolAddress}`);
            logger.warn('⚠️  THIS WILL SPEND REAL SOL!');
            
            // Step 1: Test price discovery with manual pool
            logger.info('💰 Step 1: Testing price discovery with manual pool...');
            const currentPrice = await this.tradingBot.getTokenPrice(tokenAddress, true, 'normal', poolAddress);
            logger.info(`💎 Current price: ${currentPrice} SOL`);
            
            // Step 2: Test pool fetching directly
            logger.info('🏊 Step 2: Testing pool fetching with PumpSwap SDK...');
            const { PublicKey } = require('@solana/web3.js');
            const pool = await this.tradingBot.pumpSdk.fetchPool(new PublicKey(poolAddress));
            
            if (pool) {
                logger.info('✅ Pool fetched successfully with PumpSwap SDK!');
                logger.info(`   • Base Mint: ${pool.baseMint.toString()}`);
                logger.info(`   • Quote Mint: ${pool.quoteMint.toString()}`);
                logger.info(`   • Base Token Account: ${pool.poolBaseTokenAccount.toString()}`);
                logger.info(`   • Quote Token Account: ${pool.poolQuoteTokenAccount.toString()}`);
                
                // Verify the token matches
                if (pool.baseMint.toString() === tokenAddress) {
                    logger.info('✅ Token address matches pool base mint!');
                } else {
                    logger.warn(`⚠️  Token mismatch: ${tokenAddress} vs ${pool.baseMint.toString()}`);
                }
            } else {
                throw new Error('Pool not found with manual address');
            }
            
            // Step 3: Test swap calculation
            logger.info('🔢 Step 3: Testing swap calculation...');
            const investmentAmount = this.config.initialInvestment;
            const slippage = 5; // 5%
            
            const expectedTokens = await this.tradingBot.pumpSdk.swapAutocompleteBaseFromQuote(
                pool,
                investmentAmount,
                slippage
            );
            
            logger.info(`✅ Swap calculation successful!`);
            logger.info(`   • Investment: ${investmentAmount} SOL`);
            logger.info(`   • Expected tokens: ${expectedTokens}`);
            logger.info(`   • Slippage: ${slippage}%`);
            
            // Step 4: Execute real trade using manual pool
            logger.info('🚀 Step 4: Executing real trade with manual pool...');
            
            // Create trading alert with manual pool
            const tradingAlert = {
                token: {
                    address: tokenAddress,
                    symbol: 'PUMP',
                    name: 'Manual Pool Test Token'
                },
                twitter: {
                    likes: 1000,
                    views: 100000,
                    url: 'https://twitter.com/manual/test'
                },
                confidence: 'HIGH',
                eventType: 'manual_test',
                manualPoolAddress: poolAddress // Add manual pool
            };
            
            // Execute with manual pool override
            logger.info('⚡ Executing trade with manual pool override...');
            const position = await this.executeTradeWithManualPool(tradingAlert, poolAddress);
            
            if (position) {
                logger.info('🎉 MANUAL POOL TRADE SUCCESSFUL!');
                this.displayPositionDetails(position);
                return position;
            } else {
                throw new Error('Position not created');
            }
            
        } catch (error) {
            logger.error('❌ Manual pool test failed:', error);
            throw error;
        }
    }

    async executeTradeWithManualPool(alert, poolAddress) {
        try {
            // Override the pool discovery to use manual pool
            const originalGetPoolAddress = this.tradingBot.getPoolAddress.bind(this.tradingBot);
            this.tradingBot.getPoolAddress = async (tokenAddress) => {
                logger.info(`🔧 Using manual pool override: ${poolAddress}`);
                return poolAddress;
            };
            
            // Execute trade
            const position = await this.tradingBot.executeBuy(alert);
            
            // Restore original method
            this.tradingBot.getPoolAddress = originalGetPoolAddress;
            
            return position;
            
        } catch (error) {
            logger.error('❌ Manual pool trade failed:', error);
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
        logger.info(`   • TX Hash: ${position.txHash}`);
        logger.info(`   • Pool Address: ${position.poolAddress}`);
    }

    async getWalletBalance() {
        try {
            const balance = await this.tradingBot.connection.getBalance(this.tradingBot.wallet.publicKey);
            return balance / 1e9;
        } catch (error) {
            logger.error('Error getting wallet balance:', error);
            return 0;
        }
    }

    async checkPrerequisites() {
        logger.info('🔍 Checking prerequisites...');
        
        const balance = await this.getWalletBalance();
        logger.info(`💰 Wallet balance: ${balance.toFixed(4)} SOL`);
        
        if (balance < this.config.initialInvestment) {
            throw new Error(`Insufficient balance: ${balance.toFixed(4)} SOL < ${this.config.initialInvestment} SOL required`);
        }
        
        const blockHeight = await this.tradingBot.connection.getBlockHeight();
        logger.info(`📡 RPC connected (block: ${blockHeight})`);
        
        logger.info('✅ All prerequisites met');
        return true;
    }
}

// CLI usage
async function main() {
    const tokenAddress = process.argv[2];
    const poolAddress = process.argv[3];
    const forceFlag = process.argv[4];
    
    if (!tokenAddress || !poolAddress) {
        console.log('Usage: node scripts/testManualPool.js <TOKEN_ADDRESS> <POOL_ADDRESS> [--force]');
        console.log('');
        console.log('⚠️  WARNING: This will execute REAL trades with REAL SOL!');
        console.log('');
        console.log('Example:');
        console.log('  node scripts/testManualPool.js D7b1HeuGNDvDCEdpW7YZMwa5HbYsdaHN98rZA569pump 4eNcFp9kyRPNeX7ek9eKokwWS87GS9PswLtMQrykKZUc');
        console.log('  node scripts/testManualPool.js D7b1HeuGNDvDCEdpW7YZMwa5HbYsdaHN98rZA569pump 4eNcFp9kyRPNeX7ek9eKokwWS87GS9PswLtMQrykKZUc --force');
        process.exit(1);
    }
    
    // Safety confirmation (unless --force flag)
    if (forceFlag !== '--force') {
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        console.log('⚠️  🚨 MANUAL POOL TEST WARNING 🚨 ⚠️');
        console.log('');
        console.log('This will execute a REAL trade with REAL SOL!');
        console.log(`Token: ${tokenAddress}`);
        console.log(`Pool: ${poolAddress}`);
        console.log(`Investment: ${process.env.INITIAL_INVESTMENT_SOL || 0.01} SOL`);
        console.log('');
        
        const confirm = await new Promise(resolve => {
            rl.question('Type "EXECUTE" to proceed with manual pool test: ', resolve);
        });
        
        rl.close();
        
        if (confirm !== 'EXECUTE') {
            console.log('❌ Test cancelled');
            process.exit(0);
        }
    }
    
    try {
        const tester = new ManualPoolTester();
        await tester.initialize();
        await tester.checkPrerequisites();
        
        const position = await tester.testWithManualPool(tokenAddress, poolAddress);
        
        logger.info('🎉 Manual pool test completed successfully!');
        logger.info('👀 Position created - press Ctrl+C to exit');
        
        // Keep script running
        process.on('SIGINT', async () => {
            logger.info('🛑 Stopping manual pool tester...');
            await tester.positionManager.savePositions();
            process.exit(0);
        });
        
    } catch (error) {
        logger.error('❌ Manual pool test failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = ManualPoolTester;