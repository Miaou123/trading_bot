// scripts/testInternalSdk.js - Test Internal SDK buy/sell methods
require('dotenv').config();
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { bs58 } = require('@coral-xyz/anchor/dist/cjs/utils/bytes');

async function testInternalSDK() {
    console.log('🔬 TESTING INTERNAL SDK BUY/SELL METHODS');
    console.log('='.repeat(50));
    
    // Initialize connection
    const connection = new Connection(
        process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
        'confirmed'
    );
    
    // Initialize wallet
    let wallet = null;
    if (process.env.PRIVATE_KEY) {
        try {
            const secretKey = bs58.decode(process.env.PRIVATE_KEY.trim());
            wallet = Keypair.fromSecretKey(secretKey);
            console.log(`💼 Wallet: ${wallet.publicKey.toString()}`);
        } catch (error) {
            console.log('❌ Wallet init failed:', error.message);
            return;
        }
    }
    
    // Initialize Internal SDK
    let PumpAmmInternalSdk;
    try {
        const pumpSdk = require('@pump-fun/pump-swap-sdk');
        PumpAmmInternalSdk = pumpSdk.PumpAmmInternalSdk;
        console.log('✅ PumpSwap Internal SDK loaded');
    } catch (error) {
        console.log('❌ PumpSwap Internal SDK failed to load:', error.message);
        return;
    }
    
    const internalSdk = new PumpAmmInternalSdk(connection);
    
    // Test data
    const tokenAddress = 'D7b1HeuGNDvDCEdpW7YZMwa5HbYsdaHN98rZA569pump';
    const poolAddress = '4eNcFp9kyRPNeX7ek9eKokwWS87GS9PswLtMQrykKZUc';
    const testAmount = 0.001; // Small test amount
    const slippage = 5;
    
    console.log(`\n🎯 Test Parameters:`);
    console.log(`   • Token: ${tokenAddress}`);
    console.log(`   • Pool: ${poolAddress}`);
    console.log(`   • Amount: ${testAmount} SOL`);
    console.log(`   • Slippage: ${slippage}%`);
    
    try {
        // Step 1: Fetch pool
        console.log('\n📊 Step 1: Fetching pool with Internal SDK...');
        const pool = await internalSdk.fetchPool(new PublicKey(poolAddress));
        
        if (!pool) {
            throw new Error('Pool not found');
        }
        
        console.log('✅ Pool fetched successfully');
        
        // Step 2: Test BUY methods (SOL → Token)
        console.log('\n💰 Step 2: Testing BUY methods (SOL → Token)...');
        
        // Test buyAutocompleteBaseFromQuote (this is what we want!)
        console.log('   Testing buyAutocompleteBaseFromQuote...');
        try {
            const tokensExpected = await internalSdk.buyAutocompleteBaseFromQuote(pool, testAmount, slippage);
            console.log(`   ✅ SUCCESS: buyAutocompleteBaseFromQuote`);
            console.log(`      → Expected tokens: ${tokensExpected}`);
            
            // Test buy instructions
            console.log('   Testing buyInstructionsInternal...');
            const buyInstructions = await internalSdk.buyInstructionsInternal(
                pool,
                tokensExpected,
                slippage,
                wallet.publicKey
            );
            console.log(`   ✅ Buy instructions: ${buyInstructions.length} instructions`);
            
            // Step 3: Test SELL methods (Token → SOL)
            console.log('\n💸 Step 3: Testing SELL methods (Token → SOL)...');
            
            // Test sellAutocompleteQuoteFromBase
            console.log('   Testing sellAutocompleteQuoteFromBase...');
            const solExpected = await internalSdk.sellAutocompleteQuoteFromBase(pool, tokensExpected, slippage);
            console.log(`   ✅ SUCCESS: sellAutocompleteQuoteFromBase`);
            console.log(`      → Expected SOL: ${solExpected}`);
            
            // Test sell instructions
            console.log('   Testing sellInstructionsInternal...');
            const sellInstructions = await internalSdk.sellInstructionsInternal(
                pool,
                tokensExpected,
                slippage,
                wallet.publicKey
            );
            console.log(`   ✅ Sell instructions: ${sellInstructions.length} instructions`);
            
            // Step 4: Test alternative methods
            console.log('\n🧪 Step 4: Testing alternative buy/sell methods...');
            
            // Test buyQuoteInputInternal
            console.log('   Testing buyQuoteInputInternal...');
            try {
                const altTokens = await internalSdk.buyQuoteInputInternal(pool, testAmount, slippage);
                console.log(`   ✅ buyQuoteInputInternal: ${altTokens} tokens`);
            } catch (error) {
                console.log(`   ❌ buyQuoteInputInternal failed: ${error.message}`);
            }
            
            // Test sellBaseInputInternal
            console.log('   Testing sellBaseInputInternal...');
            try {
                const altSol = await internalSdk.sellBaseInputInternal(pool, tokensExpected, slippage);
                console.log(`   ✅ sellBaseInputInternal: ${altSol} SOL`);
            } catch (error) {
                console.log(`   ❌ sellBaseInputInternal failed: ${error.message}`);
            }
            
            console.log('\n🎉 INTERNAL SDK SUCCESS!');
            console.log('💡 Use these methods for trading:');
            console.log('   • BUY: internalSdk.buyAutocompleteBaseFromQuote()');
            console.log('   • BUY Instructions: internalSdk.buyInstructionsInternal()');
            console.log('   • SELL: internalSdk.sellAutocompleteQuoteFromBase()');
            console.log('   • SELL Instructions: internalSdk.sellInstructionsInternal()');
            
            return {
                success: true,
                buyMethod: 'buyAutocompleteBaseFromQuote',
                buyInstructionsMethod: 'buyInstructionsInternal',
                sellMethod: 'sellAutocompleteQuoteFromBase',
                sellInstructionsMethod: 'sellInstructionsInternal'
            };
            
        } catch (error) {
            console.log(`   ❌ buyAutocompleteBaseFromQuote failed: ${error.message}`);
        }
        
        // If above failed, try other buy methods
        const buyMethods = [
            'buyBaseInput',
            'buyQuoteInput',
            'buyBaseInputInternal',
            'buyQuoteInputInternal'
        ];
        
        console.log('\n🔄 Trying alternative buy methods...');
        for (const method of buyMethods) {
            try {
                console.log(`   Testing ${method}...`);
                const result = await internalSdk[method](pool, testAmount, slippage);
                console.log(`   ✅ ${method} works: ${result}`);
                return { success: true, buyMethod: method };
            } catch (error) {
                console.log(`   ❌ ${method} failed: ${error.message}`);
            }
        }
        
    } catch (error) {
        console.log(`❌ Internal SDK test failed: ${error.message}`);
        console.log(`Stack: ${error.stack}`);
    }
    
    return { success: false };
}

// Test with pure token mint approach
async function testDirectMintApproach() {
    console.log('\n🎯 TESTING DIRECT TOKEN MINT APPROACH');
    console.log('='.repeat(40));
    
    try {
        const pumpSdk = require('@pump-fun/pump-swap-sdk');
        const connection = new Connection(
            process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        const internalSdk = new pumpSdk.PumpAmmInternalSdk(connection);
        
        // Try using just the token mint instead of pool
        const tokenMint = new PublicKey('D7b1HeuGNDvDCEdpW7YZMwa5HbYsdaHN98rZA569pump');
        const testAmount = 0.001;
        const slippage = 5;
        
        console.log('🔍 Testing with token mint directly...');
        
        // Check if there are methods that work with mint instead of pool
        const mintMethods = [
            'buyQuoteInputInternalNoPool',
            'sellInstructionsInternalNoPool'
        ];
        
        for (const method of mintMethods) {
            if (typeof internalSdk[method] === 'function') {
                try {
                    console.log(`   Testing ${method}...`);
                    // This might need different parameters
                    console.log(`   ✅ ${method} exists`);
                } catch (error) {
                    console.log(`   ❌ ${method} failed: ${error.message}`);
                }
            }
        }
        
    } catch (error) {
        console.log(`❌ Direct mint approach failed: ${error.message}`);
    }
}

// Main execution
async function main() {
    const result = await testInternalSDK();
    await testDirectMintApproach();
    
    console.log('\n' + '='.repeat(60));
    if (result.success) {
        console.log('🎉 SUCCESS! Internal SDK methods work!');
        console.log('💡 Update your trading bot to use Internal SDK instead of high-level SDK');
        console.log('\nWorking methods:');
        console.log(`   • Buy calculation: ${result.buyMethod}`);
        console.log(`   • Buy instructions: ${result.buyInstructionsMethod || 'TBD'}`);
        console.log(`   • Sell calculation: ${result.sellMethod || 'TBD'}`);
        console.log(`   • Sell instructions: ${result.sellInstructionsMethod || 'TBD'}`);
    } else {
        console.log('❌ Internal SDK methods also failed');
        console.log('💡 The issue might be with the pool or SDK version');
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { testInternalSDK }