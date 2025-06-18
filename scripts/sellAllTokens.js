// scripts/sellAllTokens.js - Sell all tokens and close ATAs using PumpSwapService
require('dotenv').config();
const { Connection, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createCloseAccountInstruction, createBurnInstruction } = require('@solana/spl-token');
const PumpSwapService = require('../src/services/pumpSwapService');
const logger = require('../src/utils/logger');

class TokenCleaner {
    constructor() {
        this.connection = new Connection(
            process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        this.pumpSwapService = new PumpSwapService({
            privateKey: process.env.PRIVATE_KEY,
            slippageTolerance: 10 // Use higher slippage for cleanup
        });

        this.stats = {
            tokensFound: 0,
            tokensSold: 0,
            tokensBurned: 0,
            atasClosedAfterSell: 0,
            atasClosedAfterBurn: 0,
            errors: 0,
            totalSolReceived: 0
        };
    }

    async sellAllTokensAndCloseATAs() {
        try {
            console.log('🧹 TOKEN CLEANUP & ATA CLOSER');
            console.log('=' .repeat(40));
            
            if (!this.pumpSwapService.wallet) {
                console.log('❌ Wallet not initialized');
                return false;
            }

            const walletAddress = this.pumpSwapService.wallet.publicKey;
            console.log(`💼 Wallet: ${walletAddress.toString()}`);

            // Step 1: Get all token accounts
            console.log('\n🔍 Scanning for token accounts...');
            const tokenAccounts = await this.getWalletTokenAccounts(walletAddress);
            
            if (tokenAccounts.length === 0) {
                console.log('✅ No token accounts found - wallet is already clean!');
                return true;
            }

            this.stats.tokensFound = tokenAccounts.length;
            console.log(`📊 Found ${tokenAccounts.length} token accounts:`);

            // Show all tokens first
            tokenAccounts.forEach((token, index) => {
                console.log(`   ${index + 1}. ${token.balance.toFixed(6)} tokens (${token.mint.slice(0, 8)}...)`);
            });

            // Step 2: Confirm cleanup
            const readline = require('readline');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const confirmed = await new Promise(resolve => {
                rl.question('\n⚠️ Proceed with selling ALL tokens and closing ATAs? (y/yes): ', resolve);
            });

            rl.close();

            if (confirmed.toLowerCase() !== 'y' && confirmed.toLowerCase() !== 'yes') {
                console.log('❌ Operation cancelled');
                return false;
            }

            // Step 3: Process each token
            console.log('\n🚀 Starting token cleanup...');
            
            for (let i = 0; i < tokenAccounts.length; i++) {
                const token = tokenAccounts[i];
                console.log(`\n📍 Progress: ${i + 1}/${tokenAccounts.length}`);
                console.log(`🔄 Processing ${token.balance.toFixed(6)} tokens of ${token.mint.slice(0, 8)}...`);

                const success = await this.processToken(token);
                
                if (success) {
                    console.log(`✅ Token processed successfully`);
                } else {
                    console.log(`❌ Token processing failed`);
                    this.stats.errors++;
                }

                // Wait between tokens to avoid rate limiting
                if (i < tokenAccounts.length - 1) {
                    console.log('⏳ Waiting 2 seconds...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            // Step 4: Show final results
            this.showFinalResults();
            return true;

        } catch (error) {
            console.error('❌ Cleanup failed:', error.message);
            return false;
        }
    }

    async getWalletTokenAccounts(walletPubkey) {
        try {
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                walletPubkey,
                { programId: TOKEN_PROGRAM_ID }
            );

            const tokens = [];
            
            for (const account of tokenAccounts.value) {
                const parsedInfo = account.account.data.parsed.info;
                const balance = parsedInfo.tokenAmount.uiAmount;
                const rawBalance = parsedInfo.tokenAmount.amount;
                
                // Only include accounts with actual token balance
                if (balance && balance > 0) {
                    tokens.push({
                        mint: parsedInfo.mint,
                        balance: balance,
                        decimals: parsedInfo.tokenAmount.decimals,
                        rawBalance: rawBalance,
                        accountAddress: account.pubkey
                    });
                }
            }

            return tokens;
        } catch (error) {
            console.error('❌ Error getting token accounts:', error.message);
            return [];
        }
    }

    async processToken(token) {
        try {
            const mintAddress = new PublicKey(token.mint);
            
            // Check if it's wrapped SOL
            if (mintAddress.toString() === 'So11111111111111111111111111111111111111112') {
                return await this.unwrapWSol(token);
            }

            // Check if token has very small balance (burn instead of sell)
            if (token.balance <= 0.001) {
                return await this.burnAndCloseToken(token);
            }

            // Try to sell using PumpSwap
            return await this.sellToken(token);

        } catch (error) {
            console.log(`   ❌ Error processing token: ${error.message}`);
            return false;
        }
    }

    async sellToken(token) {
        try {
            console.log(`   💰 Attempting to sell via PumpSwap...`);
            
            // Check if pool exists first
            const poolAddress = await this.pumpSwapService.findPool(token.mint);
            if (!poolAddress) {
                console.log(`   ⚠️ No PumpSwap pool found - burning instead`);
                return await this.burnAndCloseToken(token);
            }

            // Execute sell
            const result = await this.pumpSwapService.executeSell(
                token.mint,
                token.balance,
                10 // 10% slippage for cleanup
            );

            if (result.success) {
                console.log(`   ✅ Sold ${token.balance.toFixed(6)} tokens for ${result.solReceived.toFixed(6)} SOL`);
                console.log(`   🔗 https://solscan.io/tx/${result.signature}`);
                
                this.stats.tokensSold++;
                this.stats.totalSolReceived += result.solReceived;

                // Close the ATA after successful sell
                await this.closeTokenAccount(token, 'after_sell');
                return true;
            } else {
                console.log(`   ❌ Sell failed - burning instead`);
                return await this.burnAndCloseToken(token);
            }

        } catch (error) {
            console.log(`   ❌ Sell error: ${error.message}`);
            console.log(`   🔄 Falling back to burn & close...`);
            return await this.burnAndCloseToken(token);
        }
    }

    async burnAndCloseToken(token) {
        try {
            console.log(`   🔥 Burning ${token.balance.toFixed(6)} tokens (too small to sell or no pool)...`);
            
            const mintAddress = new PublicKey(token.mint);
            const tokenAccount = getAssociatedTokenAddressSync(mintAddress, this.pumpSwapService.wallet.publicKey);
            
            // Get actual current balance from chain
            const tokenAccountInfo = await this.connection.getTokenAccountBalance(tokenAccount);
            const actualBalance = BigInt(tokenAccountInfo.value.amount);
            
            if (actualBalance > BigInt(0)) {
                // Build burn transaction
                const transaction = new Transaction();
                transaction.add(
                    ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
                    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
                );

                // Burn all tokens
                const burnIx = createBurnInstruction(
                    tokenAccount,
                    mintAddress,
                    this.pumpSwapService.wallet.publicKey,
                    actualBalance
                );

                transaction.add(burnIx);
                
                // Send burn transaction
                const { blockhash } = await this.connection.getLatestBlockhash();
                transaction.recentBlockhash = blockhash;
                transaction.feePayer = this.pumpSwapService.wallet.publicKey;
                
                transaction.sign(this.pumpSwapService.wallet);
                
                const signature = await this.connection.sendTransaction(transaction, {
                    maxRetries: 3
                });
                
                const latestBlockhash = await this.connection.getLatestBlockhash();
                await this.connection.confirmTransaction({
                    signature: signature,
                    blockhash: latestBlockhash.blockhash,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
                }, 'confirmed');
                
                console.log(`   ✅ Burned tokens successfully`);
                console.log(`   🔗 https://solscan.io/tx/${signature}`);
                
                this.stats.tokensBurned++;
                
                // Wait for burn to settle before closing
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // Close the account
            await this.closeTokenAccount(token, 'after_burn');
            return true;

        } catch (error) {
            console.log(`   ❌ Burn failed: ${error.message}`);
            return false;
        }
    }

    async unwrapWSol(token) {
        try {
            console.log(`   💧 Unwrapping ${token.balance.toFixed(4)} WSOL to native SOL...`);
            
            const tokenAccount = getAssociatedTokenAddressSync(
                new PublicKey('So11111111111111111111111111111111111111112'), 
                this.pumpSwapService.wallet.publicKey
            );
            
            // Build unwrap transaction
            const transaction = new Transaction();
            transaction.add(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
            );

            // Close WSOL account to unwrap to native SOL
            const closeAccountIx = createCloseAccountInstruction(
                tokenAccount,
                this.pumpSwapService.wallet.publicKey,
                this.pumpSwapService.wallet.publicKey
            );
            
            transaction.add(closeAccountIx);
            
            // Send transaction
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = this.pumpSwapService.wallet.publicKey;
            
            transaction.sign(this.pumpSwapService.wallet);
            
            const signature = await this.connection.sendTransaction(transaction, {
                maxRetries: 3
            });
            
            const latestBlockhash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
                signature: signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, 'confirmed');
            
            console.log(`   ✅ Unwrapped ${token.balance.toFixed(4)} WSOL to native SOL`);
            console.log(`   🔗 https://solscan.io/tx/${signature}`);
            
            this.stats.totalSolReceived += token.balance;
            return true;

        } catch (error) {
            console.log(`   ❌ WSOL unwrap failed: ${error.message}`);
            return false;
        }
    }

    async closeTokenAccount(token, type = 'general') {
        try {
            console.log(`   🔒 Closing token account to reclaim rent...`);
            
            const mintAddress = new PublicKey(token.mint);
            const tokenAccount = getAssociatedTokenAddressSync(mintAddress, this.pumpSwapService.wallet.publicKey);
            
            // Build close account transaction
            const transaction = new Transaction();
            transaction.add(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
            );

            const closeAccountIx = createCloseAccountInstruction(
                tokenAccount,
                this.pumpSwapService.wallet.publicKey, // Rent goes back to wallet
                this.pumpSwapService.wallet.publicKey
            );
            
            transaction.add(closeAccountIx);
            
            // Send transaction
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = this.pumpSwapService.wallet.publicKey;
            
            transaction.sign(this.pumpSwapService.wallet);
            
            const signature = await this.connection.sendTransaction(transaction, {
                maxRetries: 3
            });

            const latestBlockhash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
                signature: signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, 'confirmed');
            
            console.log(`   ✅ Closed token account (reclaimed ~0.002 SOL rent)`);
            console.log(`   🔗 https://solscan.io/tx/${signature}`);
            
            if (type === 'after_sell') {
                this.stats.atasClosedAfterSell++;
            } else {
                this.stats.atasClosedAfterBurn++;
            }
            
            return true;

        } catch (error) {
            console.log(`   ❌ Failed to close account: ${error.message}`);
            return false;
        }
    }

    showFinalResults() {
        console.log('\n🎉 TOKEN CLEANUP COMPLETED!');
        console.log('=' .repeat(40));
        console.log(`📊 Final Results:`);
        console.log(`   🔍 Tokens found: ${this.stats.tokensFound}`);
        console.log(`   💰 Tokens sold: ${this.stats.tokensSold}`);
        console.log(`   🔥 Tokens burned: ${this.stats.tokensBurned}`);
        console.log(`   🔒 ATAs closed (after sell): ${this.stats.atasClosedAfterSell}`);
        console.log(`   🔒 ATAs closed (after burn): ${this.stats.atasClosedAfterBurn}`);
        console.log(`   ❌ Errors: ${this.stats.errors}`);
        console.log(`   💎 Total SOL received: ${this.stats.totalSolReceived.toFixed(6)} SOL`);
        
        const totalClosed = this.stats.atasClosedAfterSell + this.stats.atasClosedAfterBurn;
        const rentReclaimed = totalClosed * 0.002;
        console.log(`   🏠 Rent reclaimed: ~${rentReclaimed.toFixed(4)} SOL`);
        
        if (this.stats.errors === 0) {
            console.log('\n✅ All tokens processed successfully!');
        } else {
            console.log(`\n⚠️ ${this.stats.errors} tokens had errors - check logs above`);
        }

        // Show final wallet balance
        setTimeout(async () => {
            try {
                const balance = await this.connection.getBalance(this.pumpSwapService.wallet.publicKey);
                console.log(`\n💰 Final wallet balance: ${(balance / 1e9).toFixed(6)} SOL`);
            } catch (error) {
                console.log('Could not check final balance');
            }
        }, 3000);
    }

    // Utility method to show current tokens without cleaning
    async showCurrentTokens() {
        try {
            console.log('📊 CURRENT TOKEN INVENTORY');
            console.log('=' .repeat(30));
            
            if (!this.pumpSwapService.wallet) {
                console.log('❌ Wallet not initialized');
                return;
            }

            const tokenAccounts = await this.getWalletTokenAccounts(this.pumpSwapService.wallet.publicKey);
            
            if (tokenAccounts.length === 0) {
                console.log('✅ No tokens found - wallet is clean!');
                return;
            }

            console.log(`💼 Wallet: ${this.pumpSwapService.wallet.publicKey.toString()}`);
            console.log(`📊 Found ${tokenAccounts.length} token accounts:\n`);

            let totalValue = 0;
            
            for (let i = 0; i < tokenAccounts.length; i++) {
                const token = tokenAccounts[i];
                console.log(`${i + 1}. Token: ${token.mint.slice(0, 8)}...`);
                console.log(`   Balance: ${token.balance.toFixed(6)} tokens`);
                
                // Try to get pool info
                try {
                    const marketData = await this.pumpSwapService.getMarketData(token.mint);
                    if (marketData) {
                        const value = token.balance * marketData.price;
                        totalValue += value;
                        console.log(`   Price: ${marketData.price.toFixed(10)} SOL`);
                        console.log(`   Value: ${value.toFixed(6)} SOL`);
                    } else {
                        console.log(`   Pool: Not found (cannot estimate value)`);
                    }
                } catch (error) {
                    console.log(`   Pool: Error checking`);
                }
                console.log('');
            }

            console.log(`💎 Total estimated value: ${totalValue.toFixed(6)} SOL`);

        } catch (error) {
            console.error('❌ Error showing tokens:', error.message);
        }
    }
}

// CLI interface
async function main() {
    const action = process.argv[2] || 'clean';
    const cleaner = new TokenCleaner();

    switch (action) {
        case 'clean':
            await cleaner.sellAllTokensAndCloseATAs();
            break;
            
        case 'show':
            await cleaner.showCurrentTokens();
            break;
            
        case 'help':
        default:
            console.log('🧹 TOKEN CLEANER & ATA CLOSER');
            console.log('=' .repeat(30));
            console.log('');
            console.log('Usage: node scripts/sellAllTokens.js [action]');
            console.log('');
            console.log('Actions:');
            console.log('  clean  - Sell all tokens and close ATAs (default)');
            console.log('  show   - Show current token inventory');
            console.log('  help   - Show this help message');
            console.log('');
            console.log('Examples:');
            console.log('  node scripts/sellAllTokens.js clean');
            console.log('  node scripts/sellAllTokens.js show');
            console.log('');
            console.log('⚠️ WARNING: "clean" will sell ALL tokens in your wallet!');
            break;
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = TokenCleaner;