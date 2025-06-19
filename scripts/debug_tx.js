// Debug script for your specific transaction
// Run this as a standalone script to analyze the exact transaction from your logs

const { Connection } = require('@solana/web3.js');

async function debugSpecificTransaction() {
    const connection = new Connection(process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com');
    
    // Your specific transaction signature from the logs
    const signature = '4dP75Ruacw3J7LMaChSnv28tXcZmMnkmn9KsWC3NY8ecDaJwvvUjFvT9t9GTdqGwBbjLRQYgtwp9ZaDggb9b6PJf';
    
    console.log(`🔍 Debugging transaction: ${signature}`);
    
    try {
        const tx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });
        
        if (!tx || !tx.meta) {
            console.error('❌ Transaction not found or incomplete');
            return;
        }

        console.log(`📊 Transaction Status: ${tx.meta.err ? 'ERROR' : 'SUCCESS'}`);
        console.log(`📊 Compute Units Consumed: ${tx.meta.computeUnitsConsumed}`);
        console.log(`📊 Fee: ${tx.meta.fee} lamports`);
        
        const allLogs = tx.meta.logMessages || [];
        console.log(`📝 Total log messages: ${allLogs.length}`);
        console.log(`\n🔍 COMPLETE LOG DUMP:`);
        console.log('=' + '='.repeat(80));
        
        allLogs.forEach((log, index) => {
            console.log(`[${String(index + 1).padStart(3, '0')}] ${log}`);
        });
        
        console.log('=' + '='.repeat(80));
        
        // Look for base64 data in logs
        console.log(`\n🔍 SEARCHING FOR BASE64 DATA:`);
        const base64Pattern = /[A-Za-z0-9+/=]{20,}/g;
        
        allLogs.forEach((log, index) => {
            const matches = log.match(base64Pattern);
            if (matches) {
                console.log(`\n[${index + 1}] Found potential base64 in: ${log}`);
                matches.forEach((match, matchIndex) => {
                    if (match.length >= 20) {
                        console.log(`   Match ${matchIndex + 1}: ${match.substring(0, 50)}${match.length > 50 ? '...' : ''} (${match.length} chars)`);
                        
                        try {
                            const decoded = Buffer.from(match, 'base64');
                            console.log(`   Decoded length: ${decoded.length} bytes`);
                            
                            if (decoded.length >= 8) {
                                const discriminator = Array.from(decoded.slice(0, 8));
                                console.log(`   Discriminator: [${discriminator.join(', ')}]`);
                                
                                // Check against known events
                                const knownEvents = {
                                    'BuyEvent': [103, 244, 82, 31, 44, 245, 119, 119],
                                    'SellEvent': [62, 47, 55, 10, 165, 3, 220, 42],
                                    'CreatePoolEvent': [177, 49, 12, 210, 160, 118, 167, 116],
                                    'DepositEvent': [120, 248, 61, 83, 31, 142, 107, 144]
                                };
                                
                                for (const [eventName, expectedDisc] of Object.entries(knownEvents)) {
                                    if (discriminator.every((byte, i) => byte === expectedDisc[i])) {
                                        console.log(`   🎉 MATCHES ${eventName}!`);
                                        
                                        if (eventName === 'BuyEvent') {
                                            console.log(`   🚀 ANALYZING BUY EVENT:`);
                                            analyzeBuyEvent(decoded);
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            console.log(`   ❌ Failed to decode: ${e.message}`);
                        }
                    }
                });
            }
        });
        
        // Look for program invocations and returns
        console.log(`\n🔍 PROGRAM INVOCATIONS:`);
        allLogs.forEach((log, index) => {
            if (log.includes('Program') && (log.includes('invoke') || log.includes('success') || log.includes('return'))) {
                console.log(`[${index + 1}] ${log}`);
            }
        });
        
        // Look for account changes
        console.log(`\n🔍 ACCOUNT CHANGES:`);
        console.log(`Pre-balances: ${tx.meta.preBalances}`);
        console.log(`Post-balances: ${tx.meta.postBalances}`);
        
        if (tx.meta.preTokenBalances && tx.meta.postTokenBalances) {
            console.log(`\n🔍 TOKEN BALANCE CHANGES:`);
            console.log('Pre-token balances:', tx.meta.preTokenBalances);
            console.log('Post-token balances:', tx.meta.postTokenBalances);
        }
        
    } catch (error) {
        console.error('💥 Error debugging transaction:', error.message);
    }
}

function analyzeBuyEvent(eventData) {
    try {
        let offset = 8; // Skip discriminator
        
        console.log(`     📊 Event data analysis (${eventData.length} bytes):`);
        
        // Parse according to IDL
        const timestamp = eventData.readBigInt64LE(offset); offset += 8;
        console.log(`     ⏰ Timestamp: ${timestamp} (${new Date(Number(timestamp) * 1000).toISOString()})`);
        
        const baseAmountOut = eventData.readBigUInt64LE(offset); offset += 8;
        console.log(`     🪙 Tokens received: ${baseAmountOut} (${Number(baseAmountOut) / 1e6} tokens)`);
        
        const maxQuoteAmountIn = eventData.readBigUInt64LE(offset); offset += 8;
        console.log(`     💰 Max SOL willing: ${maxQuoteAmountIn} (${Number(maxQuoteAmountIn) / 1e9} SOL)`);
        
        // Skip user reserves
        const userBaseTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
        const userQuoteTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
        
        // Skip pool reserves
        const poolBaseTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
        const poolQuoteTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
        
        const quoteAmountIn = eventData.readBigUInt64LE(offset); offset += 8;
        console.log(`     💸 Total SOL before fees: ${quoteAmountIn} (${Number(quoteAmountIn) / 1e9} SOL)`);
        
        // Skip fee basis points
        const lpFeeBasisPoints = eventData.readBigUInt64LE(offset); offset += 8;
        const lpFee = eventData.readBigUInt64LE(offset); offset += 8;
        console.log(`     💵 LP Fee: ${lpFee} (${Number(lpFee) / 1e9} SOL, ${lpFeeBasisPoints} basis points)`);
        
        const protocolFeeBasisPoints = eventData.readBigUInt64LE(offset); offset += 8;
        const protocolFee = eventData.readBigUInt64LE(offset); offset += 8;
        console.log(`     🏛️ Protocol Fee: ${protocolFee} (${Number(protocolFee) / 1e9} SOL, ${protocolFeeBasisPoints} basis points)`);
        
        const quoteAmountInWithLpFee = eventData.readBigUInt64LE(offset); offset += 8;
        const userQuoteAmountIn = eventData.readBigUInt64LE(offset); offset += 8;
        console.log(`     💰 ACTUAL SOL SPENT: ${userQuoteAmountIn} (${Number(userQuoteAmountIn) / 1e9} SOL)`);
        
        console.log(`     📈 Price per token: ${Number(userQuoteAmountIn) / Number(baseAmountOut) * 1e3} SOL per 1000 tokens`);
        console.log(`     📈 Effective price: ${(Number(userQuoteAmountIn) / 1e9) / (Number(baseAmountOut) / 1e6)} SOL per token`);
        
    } catch (error) {
        console.error(`     💥 Error analyzing BuyEvent: ${error.message}`);
    }
}

// Run the debug function
debugSpecificTransaction().catch(console.error);