// scripts/testPumpSwap.js - Test direct PumpSwap SDK trading
require('dotenv').config();
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');
const BN = require('bn.js');

class PumpSwapTester {
    constructor() {
        this.connection = new Connection(
            process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        // Initialize wallet
        this.wallet = this.initializeWallet();
        
        // Initialize PumpSwap SDK
        this.sdk = null;
        this.initializeSDK();
    }

    initializeWallet() {
        try {
            if (!process.env.PRIVATE_KEY) {
                throw new Error('PRIVATE_KEY not found in .env file');
            }
            
            const privateKeyString = process.env.PRIVATE_KEY.trim();
            let secretKey;
            
            if (privateKeyString.startsWith('[')) {
                secretKey = new Uint8Array(JSON.parse(privateKeyString));
            } else {
                secretKey = bs58.decode(privateKeyString);
            }
            
            const wallet = Keypair.fromSecretKey(secretKey);
            console.log(`💼 Wallet: ${wallet.publicKey.toString()}`);
            return wallet;
        } catch (error) {
            console.error('❌ Wallet initialization failed:', error.message);
            throw error;
        }
    }

    async initializeSDK() {
        try {
            const { PumpAmmInternalSdk } = require('@pump-fun/pump-swap-sdk');
            this.sdk = new PumpAmmInternalSdk(this.connection);
            console.log('✅ PumpSwap SDK initialized');
            return true;
        } catch (error) {
            console.error('❌ PumpSwap SDK initialization failed:', error.message);
            throw error;
        }
    }

    async getWalletBalance() {
        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            return balance / 1e9; // Convert to SOL
        } catch (error) {
            console.error('Error getting wallet balance:', error);
            return 0;
        }
    }

    async getPoolInfo(poolAddress) {
        try {
            console.log(`🔍 Fetching pool info: ${poolAddress}`);
            
            const pool = await this.sdk.fetchPool(new PublicKey(poolAddress));
            const { poolBaseAmount, poolQuoteAmount } = await this.sdk.getPoolBaseAndQuoteAmounts(new PublicKey(poolAddress));
            
            // Calculate current price
            const baseAmountFloat = parseFloat(poolBaseAmount.toString()) / Math.pow(10, 6); // Assume 6 decimals
            const quoteAmountFloat = parseFloat(poolQuoteAmount.toString()) / Math.pow(10, 9); // SOL: 9 decimals
            const currentPrice = quoteAmountFloat / baseAmountFloat;
            
            console.log('📊 Pool Info:');
            console.log(`   Base Mint: ${pool.baseMint.toString()}`);
            console.log(`   Quote Mint: ${pool.quoteMint.toString()}`);
            console.log(`   Base Reserve: ${baseAmountFloat.toFixed(2)} tokens`);
            console.log(`   Quote Reserve: ${quoteAmountFloat.toFixed(6)} SOL`);
            console.log(`   Current Price: ${currentPrice.toFixed(12)} SOL per token`);
            console.log(`   LP Supply: ${pool.lpSupply.toString()}`);
            
            return {
                pool: pool,
                baseReserve: poolBaseAmount,
                quoteReserve: poolQuoteAmount,
                currentPrice: currentPrice,
                baseAmountFloat: baseAmountFloat,
                quoteAmountFloat: quoteAmountFloat
            };
            
        } catch (error) {
            console.error('❌ Failed to fetch pool info:', error.message);
            throw error;
        }
    }

    async testBuy(poolAddress, solAmount = 0.001, slippage = 1) {
        try {
            console.log(`\n💰 TESTING BUY: ${solAmount} SOL`);
            console.log('='.repeat(40));
            
            const poolInfo = await this.getPoolInfo(poolAddress);
            const pool = new PublicKey(poolAddress);
            
            // Convert SOL to lamports for the quote amount
            const quoteAmount = new BN(solAmount * 1e9);
            
            console.log(`🔍 Calculating buy for ${solAmount} SOL...`);
            
            // Get expected tokens for this SOL amount
            const buyResult = await this.sdk.buyQuoteInputInternal(pool, quoteAmount, slippage);
            
            const expectedTokens = parseFloat(buyResult.base.toString()) / Math.pow(10, 6);
            const maxQuoteNeeded = parseFloat(buyResult.maxQuote.toString()) / 1e9;
            
            console.log(`📊 Buy Calculation:`);
            console.log(`   SOL Input: ${solAmount}`);
            console.log(`   Expected Tokens: ${expectedTokens.toFixed(6)}`);
            console.log(`   Max SOL Needed (with slippage): ${maxQuoteNeeded.toFixed(6)}`);
            console.log(`   Slippage: ${slippage}%`);
            
            // Get transaction instructions
            console.log(`⚡ Building buy transaction...`);
            const instructions = await this.sdk.buyQuoteInput(
                pool,
                quoteAmount,
                slippage,
                this.wallet.publicKey
            );
            
            console.log(`📝 Transaction has ${instructions.length} instructions`);
            
            // Execute transaction
            console.log(`🚀 Executing buy transaction...`);
            const { sendAndConfirmTransaction } = require('@pump-fun/pump-swap-sdk');
            
            const [transaction, error] = await sendAndConfirmTransaction(
                this.connection,
                this.wallet.publicKey,
                instructions,
                [this.wallet]
            );
            
            if (error) {
                throw new Error(`Transaction failed: ${JSON.stringify(error)}`);
            }
            
            const signature = transaction.signatures[0];
            console.log(`✅ BUY SUCCESS!`);
            console.log(`   Signature: ${Buffer.from(signature).toString('base64')}`);
            console.log(`   Expected tokens: ${expectedTokens.toFixed(6)}`);
            
            return {
                success: true,
                signature: signature,
                expectedTokens: expectedTokens,
                solSpent: solAmount,
                pool: poolInfo
            };
            
        } catch (error) {
            console.error('❌ Buy failed:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async testSell(poolAddress, tokenAmount, slippage = 1) {
        try {
            console.log(`\n💸 TESTING SELL: ${tokenAmount} tokens`);
            console.log('='.repeat(40));
            
            const poolInfo = await this.getPoolInfo(poolAddress);
            const pool = new PublicKey(poolAddress);
            
            // Convert token amount to base units (6 decimals)
            const baseAmount = new BN(tokenAmount * Math.pow(10, 6));
            
            console.log(`🔍 Calculating sell for ${tokenAmount} tokens...`);
            
            // Get expected SOL for these tokens
            const sellResult = await this.sdk.sellBaseInputInternal(pool, baseAmount, slippage);
            
            const expectedSol = parseFloat(sellResult.uiQuote.toString()) / 1e9;
            const minSolReceived = parseFloat(sellResult.minQuote.toString()) / 1e9;
            
            console.log(`📊 Sell Calculation:`);
            console.log(`   Token Input: ${tokenAmount}`);
            console.log(`   Expected SOL: ${expectedSol.toFixed(6)}`);
            console.log(`   Min SOL (with slippage): ${minSolReceived.toFixed(6)}`);
            console.log(`   Slippage: ${slippage}%`);
            
            // Get transaction instructions
            console.log(`⚡ Building sell transaction...`);
            const instructions = await this.sdk.sellBaseInput(
                pool,
                baseAmount,
                slippage,
                this.wallet.publicKey
            );
            
            console.log(`📝 Transaction has ${instructions.length} instructions`);
            
            // Execute transaction
            console.log(`🚀 Executing sell transaction...`);
            const { sendAndConfirmTransaction } = require('@pump-fun/pump-swap-sdk');
            
            const [transaction, error] = await sendAndConfirmTransaction(
                this.connection,
                this.wallet.publicKey,
                instructions,
                [this.wallet]
            );
            
            if (error) {
                throw new Error(`Transaction failed: ${JSON.stringify(error)}`);
            }
            
            const signature = transaction.signatures[0];
            console.log(`✅ SELL SUCCESS!`);
            console.log(`   Signature: ${Buffer.from(signature).toString('base64')}`);
            console.log(`   Expected SOL: ${expectedSol.toFixed(6)}`);
            
            return {
                success: true,
                signature: signature,
                expectedSol: expectedSol,
                tokensSold: tokenAmount,
                pool: poolInfo
            };
            
        } catch (error) {
            console.error('❌ Sell failed:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async runFullTest(poolAddress, solAmount = 0.001, slippage = 1) {
        try {
            console.log('🧪 PUMPSWAP SDK FULL TEST');
            console.log('='.repeat(50));
            console.log(`🎯 Pool: ${poolAddress}`);
            console.log(`💰 SOL Amount: ${solAmount}`);
            console.log(`📊 Slippage: ${slippage}%`);
            console.log('');
            
            // Check wallet balance
            const balance = await this.getWalletBalance();
            console.log(`💼 Wallet Balance: ${balance.toFixed(4)} SOL`);
            
            if (balance < solAmount + 0.001) { // Need extra for fees
                throw new Error(`Insufficient balance: ${balance.toFixed(4)} SOL < ${solAmount + 0.001} SOL needed`);
            }
            
            // Step 1: Get initial pool info
            console.log('\n1️⃣ INITIAL POOL INFO');
            const initialPoolInfo = await this.getPoolInfo(poolAddress);
            
            // Step 2: Execute buy
            console.log('\n2️⃣ BUY TEST');
            const buyResult = await this.testBuy(poolAddress, solAmount, slippage);
            
            if (!buyResult.success) {
                throw new Error(`Buy failed: ${buyResult.error}`);
            }
            
            // Wait a moment for transaction to settle
            console.log('\n⏳ Waiting 3 seconds for transaction to settle...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Step 3: Execute sell (sell all tokens we just bought)
            console.log('\n3️⃣ SELL TEST');
            const sellResult = await this.testSell(poolAddress, buyResult.expectedTokens * 0.99, slippage); // Sell 99% to account for rounding
            
            if (!sellResult.success) {
                console.warn(`❌ Sell failed: ${sellResult.error}`);
                console.log('💡 This might be normal - you may need to wait or adjust the token amount');
            }
            
            // Step 4: Final results
            console.log('\n4️⃣ FINAL RESULTS');
            console.log('='.repeat(30));
            
            const finalBalance = await this.getWalletBalance();
            const netChange = finalBalance - balance;
            
            console.log(`📊 Summary:`);
            console.log(`   Initial Balance: ${balance.toFixed(6)} SOL`);
            console.log(`   Final Balance: ${finalBalance.toFixed(6)} SOL`);
            console.log(`   Net Change: ${netChange > 0 ? '+' : ''}${netChange.toFixed(6)} SOL`);
            console.log(`   Buy Success: ${buyResult.success ? '✅' : '❌'}`);
            console.log(`   Sell Success: ${sellResult.success ? '✅' : '❌'}`);
            
            if (buyResult.success && sellResult.success) {
                console.log('\n🎉 FULL PUMPSWAP TEST COMPLETED SUCCESSFULLY!');
                console.log('🚀 Ready to integrate into trading bot!');
            } else {
                console.log('\n⚠️ Partial success - buy worked, sell may need adjustment');
            }
            
            return {
                buyResult,
                sellResult,
                netChange,
                success: buyResult.success
            };
            
        } catch (error) {
            console.error('❌ Full test failed:', error.message);
            throw error;
        }
    }
}

// CLI usage
async function main() {
    const poolAddress = process.argv[2];
    const solAmount = parseFloat(process.argv[3]) || 0.001;
    const slippage = parseFloat(process.argv[4]) || 1;
    
    if (!poolAddress) {
        console.log('Usage: node scripts/testPumpSwap.js <POOL_ADDRESS> [SOL_AMOUNT] [SLIPPAGE]');
        console.log('');
        console.log('Examples:');
        console.log('  # Test with 0.001 SOL, 1% slippage');
        console.log('  node scripts/testPumpSwap.js A4Aj31bhHzLoTh2WVprPMWmgcwgPMjgqsSARsPvyFp28');
        console.log('');
        console.log('  # Test with custom amount and slippage');
        console.log('  node scripts/testPumpSwap.js A4Aj31bhHzLoTh2WVprPMWmgcwgPMjgqsSARsPvyFp28 0.005 2');
        console.log('');
        console.log('⚠️  WARNING: This will execute REAL trades with REAL SOL!');
        process.exit(1);
    }
    
    // Safety confirmation
    console.log('⚠️  🚨 REAL TRADING WARNING 🚨 ⚠️');
    console.log('');
    console.log('This will execute REAL trades with REAL SOL!');
    console.log(`Pool: ${poolAddress}`);
    console.log(`Amount: ${solAmount} SOL`);
    console.log(`Slippage: ${slippage}%`);
    console.log('');
    
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    const confirm = await new Promise(resolve => {
        rl.question('Type "EXECUTE" to proceed with real trading: ', resolve);
    });
    
    rl.close();
    
    if (confirm !== 'EXECUTE') {
        console.log('❌ Test cancelled');
        process.exit(0);
    }
    
    try {
        const tester = new PumpSwapTester();
        await tester.runFullTest(poolAddress, solAmount, slippage);
        
    } catch (error) {
        console.error('❌ PumpSwap test failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = PumpSwapTester;