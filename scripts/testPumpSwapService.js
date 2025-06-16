// scripts/testPumpSwapService.js - Standalone PumpSwap service tester
require('dotenv').config();
const { Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage } = require('@solana/web3.js');
const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const BN = require('bn.js');
const fs = require('fs');
const path = require('path');

// Import your PumpSwap service
const PumpSwapService = require('../src/services/pumpSwapService');

class PumpSwapTester {
    constructor() {
        // Initialize connection
        this.connection = new Connection(
            process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        // Initialize wallet
        this.wallet = this.initializeWallet();
        
        // Load PumpSwap IDL and initialize service
        this.pumpSwapService = null;
        this.initializeService();
        
        // Test configuration
        this.config = {
            buyAmount: 0.001, // Default 0.001 SOL buy
            sellPercentage: 100, // Sell 100% of tokens
            slippage: 5 // 5% slippage tolerance
        };
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

    initializeService() {
        try {
            // Try to load PumpSwap IDL from multiple possible locations
            const possiblePaths = [
                path.join(__dirname, '../pumpswap-idl.json'),
                path.join(__dirname, '../../pumpswap-idl.json'),
                path.join(process.cwd(), 'pumpswap-idl.json')
            ];

            let pumpSwapIDL = null;
            for (const idlPath of possiblePaths) {
                if (fs.existsSync(idlPath)) {
                    console.log(`📄 Loading PumpSwap IDL from: ${idlPath}`);
                    pumpSwapIDL = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
                    break;
                }
            }

            if (!pumpSwapIDL) {
                throw new Error('PumpSwap IDL file not found. Please ensure pumpswap-idl.json exists in the project root.');
            }

            // Initialize PumpSwap service
            this.pumpSwapService = new PumpSwapService(this.connection, this.wallet, pumpSwapIDL);
            console.log('✅ PumpSwap service initialized');
            
        } catch (error) {
            console.error('❌ PumpSwap service initialization failed:', error.message);
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

    async getTokenBalance(tokenMint) {
        try {
            const tokenAccount = getAssociatedTokenAddressSync(tokenMint, this.wallet.publicKey);
            const balance = await this.connection.getTokenAccountBalance(tokenAccount);
            return {
                balance: parseFloat(balance.value.amount),
                decimals: balance.value.decimals,
                formatted: parseFloat(balance.value.amount) / Math.pow(10, balance.value.decimals)
            };
        } catch (error) {
            // Token account doesn't exist
            return { balance: 0, decimals: 6, formatted: 0 };
        }
    }

    async showMarketInfo(tokenAddress) {
        try {
            console.log('\n📊 MARKET INFORMATION');
            console.log('='.repeat(50));
            
            const tokenMint = new PublicKey(tokenAddress);
            const marketData = await this.pumpSwapService.getMarketData(tokenMint);
            
            if (!marketData) {
                console.log('❌ No market data found - token may not have a PumpSwap pool');
                return false;
            }

            console.log(`🎯 Token: ${tokenAddress}`);
            console.log(`💰 Current Price: ${marketData.price.toFixed(12)} SOL`);
            console.log(`🏊 Pool Address: ${marketData.poolAddress}`);
            console.log(`💧 Liquidity:`);
            console.log(`   • Token Reserve: ${marketData.liquidity.tokenReserveFormatted.toFixed(2)} tokens`);
            console.log(`   • SOL Reserve: ${marketData.liquidity.solReserveFormatted.toFixed(6)} SOL`);
            console.log(`🔢 Token Decimals: ${marketData.decimals}`);

            return true;
        } catch (error) {
            console.error('❌ Error getting market info:', error.message);
            return false;
        }
    }

    async testBuy(tokenAddress, solAmount) {
        try {
            console.log('\n🛒 TESTING BUY OPERATION');
            console.log('='.repeat(40));
            console.log(`💰 Buying ${solAmount} SOL worth of tokens...`);
            
            const tokenMint = new PublicKey(tokenAddress);
            
            // Get current price and calculate expected tokens
            const priceInfo = await this.pumpSwapService.getTokenPrice(tokenMint);
            if (!priceInfo) {
                throw new Error('Could not get token price');
            }
            
            const expectedTokens = (solAmount / priceInfo.price) * Math.pow(10, 6); // Assume 6 decimals for now
            console.log(`📊 Expected tokens: ${(expectedTokens / 1e6).toFixed(6)}`);
            console.log(`💎 Price per token: ${priceInfo.price.toFixed(12)} SOL`);
            
            // Build buy instructions
            const buyData = await this.pumpSwapService.buildBuyInstructions(
                tokenMint,
                Math.floor(expectedTokens),
                Math.floor(solAmount * 1e9), // Convert SOL to lamports
                this.config.slippage
            );
            
            console.log(`⚡ Transaction built successfully`);
            console.log(`🔥 Max SOL to spend: ${parseFloat(buyData.maxSolIn.toString()) / 1e9} SOL`);
            console.log(`📉 Slippage impact: ${buyData.slippageImpact.toString()} basis points`);
            
            // Create and send transaction
            const { blockhash } = await this.connection.getLatestBlockhash();
            const message = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: buyData.instructions,
            }).compileToV0Message();

            const transaction = new VersionedTransaction(message);
            transaction.sign([this.wallet]);
            
            console.log(`🚀 Sending buy transaction...`);
            
            const signature = await this.connection.sendTransaction(transaction, {
                maxRetries: 3,
                preflightCommitment: 'confirmed'
            });
            
            console.log(`📝 Transaction sent: ${signature}`);
            console.log(`🔗 Explorer: https://solscan.io/tx/${signature}`);
            
            // Wait for confirmation
            console.log(`⏳ Waiting for confirmation...`);
            const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
            
            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }
            
            console.log(`✅ BUY SUCCESSFUL!`);
            console.log(`   📝 Signature: ${signature}`);
            console.log(`   💰 SOL spent: ~${solAmount} SOL`);
            console.log(`   📊 Expected tokens: ${(expectedTokens / 1e6).toFixed(6)}`);
            
            return {
                success: true,
                signature: signature,
                expectedTokens: expectedTokens,
                poolAddress: buyData.poolAddress
            };
            
        } catch (error) {
            console.error('❌ Buy test failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    async testSell(tokenAddress, sellPercentage) {
        try {
            console.log('\n💸 TESTING SELL OPERATION');
            console.log('='.repeat(40));
            
            const tokenMint = new PublicKey(tokenAddress);
            
            // Get current token balance
            const tokenBalance = await this.getTokenBalance(tokenMint);
            if (tokenBalance.balance === 0) {
                throw new Error('No tokens to sell! Please buy some tokens first.');
            }
            
            const tokensToSell = (tokenBalance.balance * sellPercentage / 100);
            console.log(`📊 Current token balance: ${tokenBalance.formatted.toFixed(6)} tokens`);
            console.log(`💸 Selling ${sellPercentage}%: ${(tokensToSell / Math.pow(10, tokenBalance.decimals)).toFixed(6)} tokens`);
            
            // Get current price
            const priceInfo = await this.pumpSwapService.getTokenPrice(tokenMint);
            if (!priceInfo) {
                throw new Error('Could not get token price');
            }
            
            const expectedSOL = (tokensToSell / Math.pow(10, tokenBalance.decimals)) * priceInfo.price;
            console.log(`💰 Expected SOL: ${expectedSOL.toFixed(6)} SOL`);
            console.log(`💎 Price per token: ${priceInfo.price.toFixed(12)} SOL`);
            
            // Build sell instructions
            const sellData = await this.pumpSwapService.buildSellInstructions(
                tokenMint,
                Math.floor(tokensToSell),
                null, // Let service calculate min SOL out
                this.config.slippage
            );
            
            console.log(`⚡ Transaction built successfully`);
            console.log(`💰 Min SOL to receive: ${parseFloat(sellData.minSolOut.toString()) / 1e9} SOL`);
            console.log(`📈 Slippage impact: ${sellData.slippageImpact.toString()} basis points`);
            
            // Create and send transaction
            const { blockhash } = await this.connection.getLatestBlockhash();
            const message = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: sellData.instructions,
            }).compileToV0Message();

            const transaction = new VersionedTransaction(message);
            transaction.sign([this.wallet]);
            
            console.log(`🚀 Sending sell transaction...`);
            
            const signature = await this.connection.sendTransaction(transaction, {
                maxRetries: 3,
                preflightCommitment: 'confirmed'
            });
            
            console.log(`📝 Transaction sent: ${signature}`);
            console.log(`🔗 Explorer: https://solscan.io/tx/${signature}`);
            
            // Wait for confirmation
            console.log(`⏳ Waiting for confirmation...`);
            const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
            
            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }
            
            const actualSOLReceived = parseFloat(sellData.expectedSolReceived.toString()) / 1e9;
            
            console.log(`✅ SELL SUCCESSFUL!`);
            console.log(`   📝 Signature: ${signature}`);
            console.log(`   💸 Tokens sold: ${(tokensToSell / Math.pow(10, tokenBalance.decimals)).toFixed(6)}`);
            console.log(`   💰 SOL received: ~${actualSOLReceived.toFixed(6)} SOL`);
            
            return {
                success: true,
                signature: signature,
                tokensSold: tokensToSell,
                solReceived: actualSOLReceived
            };
            
        } catch (error) {
            console.error('❌ Sell test failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    async runFullTest(tokenAddress, testMode = 'both') {
        try {
            console.log('🧪 PUMPSWAP SERVICE FULL TEST');
            console.log('='.repeat(60));
            console.log(`🎯 Token: ${tokenAddress}`);
            console.log(`🔧 Mode: ${testMode}`);
            console.log(`💰 Buy Amount: ${this.config.buyAmount} SOL`);
            console.log(`💸 Sell Percentage: ${this.config.sellPercentage}%`);
            console.log(`📊 Slippage: ${this.config.slippage}%`);
            console.log('');
            
            // Check wallet balance
            const initialBalance = await this.getWalletBalance();
            console.log(`💼 Initial wallet balance: ${initialBalance.toFixed(6)} SOL`);
            
            if (initialBalance < this.config.buyAmount + 0.001) {
                throw new Error(`Insufficient balance: ${initialBalance.toFixed(6)} SOL < ${this.config.buyAmount + 0.001} SOL needed`);
            }
            
            // Show market information
            const hasMarket = await this.showMarketInfo(tokenAddress);
            if (!hasMarket) {
                throw new Error('Token does not have a PumpSwap pool');
            }
            
            let buyResult = null;
            let sellResult = null;
            
            // Test buy operation
            if (testMode === 'buy' || testMode === 'both') {
                buyResult = await this.testBuy(tokenAddress, this.config.buyAmount);
                
                if (!buyResult.success) {
                    throw new Error(`Buy failed: ${buyResult.error}`);
                }
                
                // Wait a moment for balance to update
                console.log('\n⏳ Waiting 3 seconds for balance update...');
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            
            // Test sell operation
            if (testMode === 'sell' || testMode === 'both') {
                sellResult = await this.testSell(tokenAddress, this.config.sellPercentage);
                
                if (!sellResult.success) {
                    console.warn(`❌ Sell failed: ${sellResult.error}`);
                    console.log('💡 This might be normal if you have no tokens to sell');
                }
            }
            
            // Final summary
            console.log('\n📊 TEST RESULTS SUMMARY');
            console.log('='.repeat(40));
            
            const finalBalance = await this.getWalletBalance();
            const netChange = finalBalance - initialBalance;
            
            console.log(`💼 Initial Balance: ${initialBalance.toFixed(6)} SOL`);
            console.log(`💼 Final Balance: ${finalBalance.toFixed(6)} SOL`);
            console.log(`📊 Net Change: ${netChange > 0 ? '+' : ''}${netChange.toFixed(6)} SOL`);
            
            if (buyResult) {
                console.log(`🛒 Buy Result: ${buyResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);
                if (buyResult.success) {
                    console.log(`   📝 Buy Signature: ${buyResult.signature}`);
                }
            }
            
            if (sellResult) {
                console.log(`💸 Sell Result: ${sellResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);
                if (sellResult.success) {
                    console.log(`   📝 Sell Signature: ${sellResult.signature}`);
                }
            }
            
            const overallSuccess = (!buyResult || buyResult.success) && (!sellResult || sellResult.success);
            console.log(`\n🎉 OVERALL TEST: ${overallSuccess ? '✅ SUCCESS' : '⚠️ PARTIAL SUCCESS'}`);
            
            if (overallSuccess) {
                console.log('🚀 PumpSwap service is working correctly!');
            } else {
                console.log('⚠️ Some operations failed - check error messages above');
            }
            
        } catch (error) {
            console.error('❌ Full test failed:', error.message);
        }
    }
}

// CLI usage
async function main() {
    const tokenAddress = process.argv[2];
    const testMode = process.argv[3] || 'both'; // 'buy', 'sell', or 'both'
    const buyAmount = parseFloat(process.argv[4]) || 0.001;
    
    if (!tokenAddress) {
        console.log('Usage: node scripts/testPumpSwapService.js <TOKEN_ADDRESS> [TEST_MODE] [BUY_AMOUNT]');
        console.log('');
        console.log('Examples:');
        console.log('  # Test both buy and sell with 0.001 SOL');
        console.log('  node scripts/testPumpSwapService.js HQC1xWpfKArsr6g8vBPn6MrgiePPPMPZ7uaHaAxYpump');
        console.log('');
        console.log('  # Test only buy operation');
        console.log('  node scripts/testPumpSwapService.js HQC1x... buy');
        console.log('');
        console.log('  # Test only sell operation');
        console.log('  node scripts/testPumpSwapService.js HQC1x... sell');
        console.log('');
        console.log('  # Test with custom buy amount');
        console.log('  node scripts/testPumpSwapService.js HQC1x... both 0.005');
        console.log('');
        console.log('⚠️  WARNING: This executes REAL transactions with REAL SOL!');
        process.exit(1);
    }
    
    // Safety confirmation
    console.log('⚠️  🚨 REAL TRADING WARNING 🚨 ⚠️');
    console.log('');
    console.log('This will execute REAL transactions with REAL SOL!');
    console.log(`Token: ${tokenAddress}`);
    console.log(`Mode: ${testMode}`);
    console.log(`Buy Amount: ${buyAmount} SOL`);
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
        
        // Update configuration if custom buy amount provided
        if (buyAmount) {
            tester.config.buyAmount = buyAmount;
        }
        
        await tester.runFullTest(tokenAddress, testMode);
        
    } catch (error) {
        console.error('❌ PumpSwap test failed:', error);
        console.log('\n🔧 TROUBLESHOOTING:');
        console.log('1. Make sure pumpswap-idl.json exists in project root');
        console.log('2. Check your .env file has PRIVATE_KEY');
        console.log('3. Ensure sufficient SOL balance');
        console.log('4. Verify token has a PumpSwap pool');
        console.log('5. Check network connectivity');
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = PumpSwapTester;