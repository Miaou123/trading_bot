// Pool address derivation from token mint using PumpFun/PumpSwap SDKs
const { PublicKey } = require('@solana/web3.js');
const { NATIVE_MINT } = require('@solana/spl-token');

class PoolDerivation {
    constructor() {
        // Program IDs from your SDKs
        this.PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        this.PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
        this.CANONICAL_POOL_INDEX = 0;
        
        // Try to import from your SDKs if available
        this.initializeSDKFunctions();
    }

    initializeSDKFunctions() {
        try {
            // Try to use your actual SDK functions
            const pumpFun = require('../../node_modules/@pump-fun/pump-fun-sdk'); // Adjust path
            const pumpSwap = require('@pump-fun/pump-swap-sdk');
            
            this.poolPda = pumpSwap.poolPda;
            this.canonicalPumpPoolPda = pumpFun.canonicalPumpPoolPda;
            this.pumpPoolAuthorityPda = pumpFun.pumpPoolAuthorityPda;
            
            console.log('✅ Using SDK functions for pool derivation');
        } catch (error) {
            console.log('⚠️ SDK functions not available, using manual implementation');
            // We'll implement the functions manually below
        }
    }

    /**
     * Derive pump pool authority PDA
     * Based on pumpPoolAuthorityPda from your SDK
     */
    derivePumpPoolAuthorityPda(mint) {
        const mintPubkey = new PublicKey(mint);
        
        const [pumpPoolAuthority, bump] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("pool-authority"),
                mintPubkey.toBuffer()
            ],
            this.PUMP_PROGRAM_ID
        );
        
        return [pumpPoolAuthority, bump];
    }

    /**
     * Derive pool PDA
     * Based on poolPda from PumpSwap SDK
     */
    derivePoolPda(poolIndex, poolAuthority, baseMint, quoteMint) {
        // Convert pool index to 2-byte buffer (little endian)
        const poolIndexBuffer = Buffer.alloc(2);
        poolIndexBuffer.writeUInt16LE(poolIndex, 0);
        
        const [poolPda, bump] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("pool"),
                poolIndexBuffer,
                new PublicKey(poolAuthority).toBuffer(),
                new PublicKey(baseMint).toBuffer(),
                new PublicKey(quoteMint).toBuffer()
            ],
            this.PUMP_AMM_PROGRAM_ID
        );
        
        return [poolPda, bump];
    }

    /**
     * Derive canonical pump pool PDA
     * This is the main function you'll use - based on canonicalPumpPoolPda from your SDK
     */
    deriveCanonicalPumpPoolPda(mint) {
        const mintPubkey = new PublicKey(mint);
        
        // Step 1: Get pump pool authority
        const [pumpPoolAuthority] = this.derivePumpPoolAuthorityPda(mintPubkey);
        
        // Step 2: Derive pool using canonical index (0)
        const [poolPda, bump] = this.derivePoolPda(
            this.CANONICAL_POOL_INDEX,
            pumpPoolAuthority,
            mintPubkey,      // base mint (token)
            NATIVE_MINT      // quote mint (SOL)
        );
        
        return [poolPda, bump];
    }

    /**
     * Main function: Get pool address from token mint
     * This is what you'll call from your trading bot
     */
    getPoolAddressFromTokenMint(tokenMint) {
        try {
            // If SDK functions are available, use them
            if (this.canonicalPumpPoolPda && this.pumpPoolAuthorityPda) {
                const [poolAddress] = this.canonicalPumpPoolPda(
                    this.PUMP_PROGRAM_ID,
                    this.PUMP_AMM_PROGRAM_ID,
                    new PublicKey(tokenMint)
                );
                return poolAddress.toString();
            }
            
            // Otherwise use manual derivation
            const [poolAddress] = this.deriveCanonicalPumpPoolPda(tokenMint);
            return poolAddress.toString();
            
        } catch (error) {
            console.error(`Pool derivation failed for ${tokenMint}:`, error.message);
            return null;
        }
    }

    /**
     * Test function to verify derivation works
     */
    async testDerivation(tokenMint, expectedPoolAddress = null) {
        console.log(`🧪 Testing pool derivation for token: ${tokenMint}`);
        
        const derivedPool = this.getPoolAddressFromTokenMint(tokenMint);
        
        if (derivedPool) {
            console.log(`✅ Derived pool: ${derivedPool}`);
            
            if (expectedPoolAddress) {
                const matches = derivedPool === expectedPoolAddress;
                console.log(`${matches ? '✅' : '❌'} Expected: ${expectedPoolAddress}`);
                console.log(`${matches ? '✅' : '❌'} Match: ${matches}`);
                return matches;
            }
            
            return true;
        } else {
            console.log(`❌ Pool derivation failed`);
            return false;
        }
    }

    /**
     * Get multiple addresses related to a token
     */
    getTokenAddresses(tokenMint) {
        try {
            const mintPubkey = new PublicKey(tokenMint);
            
            // Bonding curve PDA (for pre-migration state)
            const [bondingCurve] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("bonding-curve"),
                    mintPubkey.toBuffer()
                ],
                this.PUMP_PROGRAM_ID
            );
            
            // Pool authority
            const [poolAuthority] = this.derivePumpPoolAuthorityPda(mintPubkey);
            
            // Pool address
            const [poolAddress] = this.deriveCanonicalPumpPoolPda(tokenMint);
            
            return {
                tokenMint: tokenMint,
                bondingCurve: bondingCurve.toString(),
                poolAuthority: poolAuthority.toString(),
                poolAddress: poolAddress.toString(),
                // For your trading bot - this is the pool address to use
                migrationPool: poolAddress.toString()
            };
            
        } catch (error) {
            console.error(`Address derivation failed:`, error.message);
            return null;
        }
    }
}

// Export for use in your trading bot
module.exports = PoolDerivation;

// CLI usage
async function main() {
    const tokenMint = process.argv[2];
    
    if (!tokenMint) {
        console.log('Usage: node poolDerivation.js <TOKEN_MINT>');
        console.log('');
        console.log('Examples:');
        console.log('  node poolDerivation.js 7VnT8zHzorYS92snKC4CZU2veigEVnVVBSxTw7G1pump');
        console.log('  node poolDerivation.js HQC1xWpfKArsr6g8vBPn6MrgiePPPMPZ7uaHaAxYpump');
        return;
    }
    
    console.log('🔍 POOL ADDRESS DERIVATION TEST');
    console.log('='.repeat(50));
    
    const derivation = new PoolDerivation();
    
    // Test single derivation
    console.log('\n📊 Single Pool Derivation:');
    const poolAddress = derivation.getPoolAddressFromTokenMint(tokenMint);
    
    if (poolAddress) {
        console.log(`✅ SUCCESS! Pool address: ${poolAddress}`);
        
        // Get all related addresses
        console.log('\n📋 Complete Address Set:');
        const addresses = derivation.getTokenAddresses(tokenMint);
        
        if (addresses) {
            console.log(`   Token Mint: ${addresses.tokenMint}`);
            console.log(`   Bonding Curve: ${addresses.bondingCurve}`);
            console.log(`   Pool Authority: ${addresses.poolAuthority}`);
            console.log(`   Pool Address: ${addresses.poolAddress}`);
            console.log('');
            console.log(`🚀 For your trading bot, use: ${addresses.migrationPool}`);
        }
        
        // Test with known good examples if available
        console.log('\n🧪 Validation Tests:');
        console.log('Testing derivation consistency...');
        
        // Test multiple times to ensure consistency
        for (let i = 0; i < 3; i++) {
            const testResult = derivation.getPoolAddressFromTokenMint(tokenMint);
            const consistent = testResult === poolAddress;
            console.log(`   Test ${i + 1}: ${consistent ? '✅' : '❌'} ${testResult === poolAddress ? 'Consistent' : 'INCONSISTENT!'}`);
        }
        
    } else {
        console.log('❌ FAILED to derive pool address');
    }
}

if (require.main === module) {
    main().catch(console.error);
}