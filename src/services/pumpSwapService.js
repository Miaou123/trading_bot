// src/services/pumpSwapService.js - ENHANCED: With exact transaction amount parsing
const { Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction } = require('@solana/spl-token');
const BN = require('bn.js');
const logger = require('../utils/logger');
const anchor = require('@coral-xyz/anchor');
const bs58 = require('bs58');

class PumpSwapService {
    constructor(config = {}) {
        this.connection = new Connection(
            config.rpcUrl || process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        this.config = {
            buySlippage: config.buySlippage || parseFloat(process.env.BUY_SLIPPAGE_TOLERANCE) || 20,
            sellSlippage: config.sellSlippage || parseFloat(process.env.SELL_SLIPPAGE_TOLERANCE) || 100,
            
            ...(config.slippageTolerance && {
                buySlippage: config.slippageTolerance,
                sellSlippage: config.slippageTolerance
            }),
            
            maxRetries: config.maxRetries || 10,
            retryDelay: config.retryDelay || 1000,
            ...config
        };
        // PumpSwap program constants
        this.PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
        this.PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        this.WSOL_MINT = NATIVE_MINT;
        
        // Initialize wallet and program
        this.wallet = null;
        this.program = null;
        
        if (config.privateKey) {
            this.initializeWallet(config.privateKey);
        }
        
        // Load IDL and initialize Anchor
        this.loadIDL();
        
        // Stats tracking
        this.stats = {
            poolsFound: 0,
            poolsNotFound: 0,
            poolsDerivied: 0,
            buysExecuted: 0,
            sellsExecuted: 0,
            errors: 0,
            retryAttempts: 0,
            exactAmountsParsed: 0,
            estimatesUsed: 0
        };
    }

    loadIDL() {
        try {
            const fs = require('fs');
            const path = require('path');
            
            const idlPath = path.join(process.cwd(), 'pumpswap-idl.json');
            logger.info(`📄 Loading PumpSwap IDL from: ${idlPath}`);
            
            if (fs.existsSync(idlPath)) {
                this.idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
                logger.info('✅ PumpSwap IDL loaded successfully');
                this.initializeAnchor();
            } else {
                logger.warn('⚠️ PumpSwap IDL file not found');
                this.idl = null;
            }
        } catch (error) {
            logger.error('❌ Failed to load PumpSwap IDL:', error.message);
            this.idl = null;
        }
    }

    initializeWallet(privateKey) {
        try {
            let secretKey;
            
            if (typeof privateKey === 'string') {
                if (privateKey.startsWith('[')) {
                    secretKey = new Uint8Array(JSON.parse(privateKey));
                } else {
                    // Fix for bs58 v6.0.0 - use default export
                    secretKey = bs58.default.decode(privateKey);
                }
            } else {
                secretKey = privateKey;
            }
            
            this.wallet = Keypair.fromSecretKey(secretKey);
            logger.info(`💼 Wallet initialized: ${this.wallet.publicKey.toString()}`);
            
            if (this.idl) {
                this.initializeAnchor();
            }
            
            return true;
        } catch (error) {
            logger.error('❌ Wallet initialization failed:', error.message);
            return false;
        }
    }

    initializeAnchor() {
        try {
            if (!this.wallet || !this.idl) {
                logger.debug('⏳ Waiting for wallet and IDL to initialize Anchor');
                return false;
            }

            const provider = new anchor.AnchorProvider(
                this.connection,
                new anchor.Wallet(this.wallet),
                { commitment: 'confirmed' }
            );

            this.program = new anchor.Program(this.idl, provider);
            logger.info('✅ Anchor program initialized for real trading');
            return true;
        } catch (error) {
            logger.error('❌ Anchor initialization failed:', error.message);
            return false;
        }
    }

    // 🔥 NEW: Parse BuyEvent from transaction to get exact amounts
    async parseBuyEventFromTransaction(signature) {
        try {
            const tx = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });
            
            if (!tx || !tx.meta) {
                throw new Error('Transaction not found or incomplete');
            }

            // Find the BuyEvent in the transaction logs
            const buyEventDiscriminator = [103, 244, 82, 31, 44, 245, 119, 119]; // From IDL
            
            // Look for PumpSwap program logs
            const programLogs = tx.meta.logMessages?.filter(log => 
                log.includes('Program log:') && log.includes('data:')
            ) || [];

            for (const log of programLogs) {
                try {
                    // Extract base64 data from log
                    const dataMatch = log.match(/Program log: data: (.+)/);
                    if (!dataMatch) continue;

                    const eventData = Buffer.from(dataMatch[1], 'base64');
                    
                    // Check if this matches BuyEvent discriminator
                    const discriminator = eventData.slice(0, 8);
                    if (Buffer.compare(discriminator, Buffer.from(buyEventDiscriminator)) === 0) {
                        // Parse the BuyEvent data
                        return this.parseBuyEventData(eventData);
                    }
                } catch (parseError) {
                    // Continue to next log if this one failed to parse
                    continue;
                }
            }

            // Fallback: parse from inner instructions if event logs not found
            return await this.parseBuyFromInnerInstructions(tx);
            
        } catch (error) {
            logger.error('Error parsing buy event:', error.message);
            return null;
        }
    }

    // 🔥 NEW: Parse BuyEvent data structure
    parseBuyEventData(eventData) {
        try {
            // Skip 8-byte discriminator
            let offset = 8;
            
            // Parse fields according to BuyEvent structure from IDL
            const timestamp = eventData.readBigInt64LE(offset); offset += 8;
            const baseAmountOut = eventData.readBigUInt64LE(offset); offset += 8;
            const maxQuoteAmountIn = eventData.readBigUInt64LE(offset); offset += 8;
            
            // Skip user reserves (we don't need them)
            offset += 16; // user_base_token_reserves + user_quote_token_reserves
            
            // Skip pool reserves  
            offset += 16; // pool_base_token_reserves + pool_quote_token_reserves
            
            const quoteAmountIn = eventData.readBigUInt64LE(offset); offset += 8;
            
            // Skip fee fields
            offset += 32; // lp_fee_basis_points + lp_fee + protocol_fee_basis_points + protocol_fee
            
            const quoteAmountInWithLpFee = eventData.readBigUInt64LE(offset); offset += 8;
            const userQuoteAmountIn = eventData.readBigUInt64LE(offset); offset += 8;

            return {
                exactTokensReceived: Number(baseAmountOut) / 1e6, // Assuming 6 decimals for tokens
                exactSolSpent: Number(userQuoteAmountIn) / 1e9,   // Convert lamports to SOL
                totalSolWithFees: Number(quoteAmountIn) / 1e9,    // Total including LP fees
                maxSolRequested: Number(maxQuoteAmountIn) / 1e9,
                timestamp: Number(timestamp),
                success: true
            };
            
        } catch (error) {
            logger.error('Error parsing BuyEvent data:', error.message);
            return null;
        }
    }

    // 🔥 NEW: Fallback: parse from inner instructions and balance changes
    async parseBuyFromInnerInstructions(tx) {
        try {
            const preBalances = tx.meta.preBalances;
            const postBalances = tx.meta.postBalances;
            
            if (!preBalances || !postBalances || preBalances.length !== postBalances.length) {
                throw new Error('Balance data incomplete');
            }

            // Calculate SOL difference for the user (first account)
            const solDifference = (preBalances[0] - postBalances[0]) / 1e9;
            const transactionFee = (tx.meta.fee || 0) / 1e9;
            const actualSolSpent = solDifference - transactionFee;

            // Parse token transfers from inner instructions
            let tokensReceived = 0;
            
            if (tx.meta.innerInstructions) {
                for (const innerIx of tx.meta.innerInstructions) {
                    for (const ix of innerIx.instructions) {
                        // Look for token transfer instructions
                        if (ix.programIdIndex === tx.transaction.message.accountKeys.findIndex(
                            key => key.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
                        )) {
                            // Parse transfer instruction data
                            const transferData = Buffer.from(ix.data, 'base64');
                            if (transferData[0] === 3) { // Transfer instruction discriminator
                                const amount = transferData.readBigUInt64LE(1);
                                tokensReceived = Number(amount) / 1e6; // Assuming 6 decimals
                                break;
                            }
                        }
                    }
                }
            }

            return {
                exactTokensReceived: tokensReceived,
                exactSolSpent: actualSolSpent,
                totalSolWithFees: actualSolSpent,
                maxSolRequested: actualSolSpent,
                timestamp: Date.now(),
                success: true,
                fallbackMethod: true
            };
            
        } catch (error) {
            logger.error('Error parsing from inner instructions:', error.message);
            return null;
        }
    }

    // 🔥 NEW: Parse SellEvent from transaction
    async parseSellEventFromTransaction(signature) {
        try {
            const tx = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });
            
            if (!tx || !tx.meta) {
                throw new Error('Transaction not found or incomplete');
            }

            const sellEventDiscriminator = [62, 47, 55, 10, 165, 3, 220, 42]; // From IDL
            
            const programLogs = tx.meta.logMessages?.filter(log => 
                log.includes('Program log:') && log.includes('data:')
            ) || [];

            for (const log of programLogs) {
                try {
                    const dataMatch = log.match(/Program log: data: (.+)/);
                    if (!dataMatch) continue;

                    const eventData = Buffer.from(dataMatch[1], 'base64');
                    const discriminator = eventData.slice(0, 8);
                    
                    if (Buffer.compare(discriminator, Buffer.from(sellEventDiscriminator)) === 0) {
                        return this.parseSellEventData(eventData);
                    }
                } catch (parseError) {
                    continue;
                }
            }

            return await this.parseSellFromInnerInstructions(tx);
            
        } catch (error) {
            logger.error('Error parsing sell event:', error.message);
            return null;
        }
    }

    // 🔥 NEW: Parse SellEvent data (similar structure to BuyEvent)
    parseSellEventData(eventData) {
        try {
            let offset = 8; // Skip discriminator
            
            const timestamp = eventData.readBigInt64LE(offset); offset += 8;
            const baseAmountIn = eventData.readBigUInt64LE(offset); offset += 8;
            const minQuoteAmountOut = eventData.readBigUInt64LE(offset); offset += 8;
            
            // Skip reserves
            offset += 32;
            
            const quoteAmountOut = eventData.readBigUInt64LE(offset); offset += 8;
            
            // Skip fee data
            offset += 32;
            
            const userQuoteAmountOut = eventData.readBigUInt64LE(offset); offset += 8;

            return {
                exactTokensSold: Number(baseAmountIn) / 1e6,
                exactSolReceived: Number(userQuoteAmountOut) / 1e9,
                totalSolBeforeFees: Number(quoteAmountOut) / 1e9,
                timestamp: Number(timestamp),
                success: true
            };
            
        } catch (error) {
            logger.error('Error parsing SellEvent data:', error.message);
            return null;
        }
    }

    // 🔥 NEW: Fallback sell parsing
    async parseSellFromInnerInstructions(tx) {
        try {
            const preBalances = tx.meta.preBalances;
            const postBalances = tx.meta.postBalances;
            
            if (!preBalances || !postBalances || preBalances.length !== postBalances.length) {
                throw new Error('Balance data incomplete');
            }

            // Calculate SOL difference for the user (first account)
            const solDifference = (postBalances[0] - preBalances[0]) / 1e9;
            const transactionFee = (tx.meta.fee || 0) / 1e9;
            const actualSolReceived = solDifference - transactionFee;

            return {
                exactTokensSold: 0, // Would need more complex parsing
                exactSolReceived: actualSolReceived,
                totalSolBeforeFees: actualSolReceived,
                timestamp: Date.now(),
                success: true,
                fallbackMethod: true
            };
            
        } catch (error) {
            logger.error('Error parsing sell from inner instructions:', error.message);
            return null;
        }
    }

    // 🔥 ENHANCED: Better pool derivation with multiple methods and detailed logging
    async findPool(tokenMint, retryAttempts = 0) {
        try {
            const mintPubkey = new PublicKey(tokenMint);
            
            // 🔥 METHOD 1: Original PumpSwap derivation (most likely)
            const method1Pool = await this.derivePoolMethod1(mintPubkey);
            if (method1Pool) {
                return method1Pool;
            }
        
            logger.warn(`⚠️ Pool not found with any method (attempt ${retryAttempts + 1})`);
            this.stats.poolsNotFound++;
            
            // 🔥 RETRY LOGIC: Keep trying for new migrations
            if (retryAttempts < this.config.maxRetries - 1) {
                this.stats.retryAttempts++;
                logger.info(`🔄 Retrying pool derivation in ${this.config.retryDelay}ms... (${retryAttempts + 1}/${this.config.maxRetries})`);
                
                await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                return await this.findPool(tokenMint, retryAttempts + 1);
            }
            
            logger.error(`❌ Pool not found after ${this.config.maxRetries} attempts`);
            return null;
            
        } catch (error) {
            this.stats.errors++;
            logger.error('❌ Error in pool derivation:', error.message);
            
            // Retry on error too
            if (retryAttempts < this.config.maxRetries - 1) {
                this.stats.retryAttempts++;
                logger.info(`🔄 Retrying after error in ${this.config.retryDelay}ms...`);
                
                await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                return await this.findPool(tokenMint, retryAttempts + 1);
            }
            
            return null;
        }
    }

    // 🔥 METHOD 1: Original derivation logic
    async derivePoolMethod1(mintPubkey) {
        try {
            logger.debug(`🔧 Method 1: Original PumpSwap derivation`);
            
            const [poolAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("pool-authority"), mintPubkey.toBytes()],
                this.PUMP_PROGRAM_ID
            );
            
            logger.debug(`   Pool Authority: ${poolAuthority.toString()}`);
            
            const poolIndexBuffer = Buffer.alloc(2);
            poolIndexBuffer.writeUInt16LE(0, 0);
            
            const [poolPda] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("pool"),
                    poolIndexBuffer,
                    poolAuthority.toBytes(),
                    mintPubkey.toBytes(),
                    this.WSOL_MINT.toBytes()
                ],
                this.PUMPSWAP_PROGRAM_ID
            );
            
            logger.debug(`   Derived Pool: ${poolPda.toString()}`);
            this.stats.poolsDerivied++;
            
            const poolAccountInfo = await this.connection.getAccountInfo(poolPda);
            if (poolAccountInfo) {
                this.stats.poolsFound++;
                return poolPda;
            } else {
                logger.debug(`❌ Pool derived but doesn't exist on-chain yet`);
                return null;
            }
            
        } catch (error) {
            logger.debug(`❌ Method 1 failed: ${error.message}`);
            return null;
        }
    }

    async getPoolCoinCreator(poolAddress) {
        try {
            const poolAccountInfo = await this.connection.getAccountInfo(poolAddress);
            if (!poolAccountInfo) return null;

            const coinCreatorOffset = 8 + 1 + 2 + 32 + 32 + 32 + 32 + 32 + 32 + 8;
            const coinCreatorBytes = poolAccountInfo.data.slice(coinCreatorOffset, coinCreatorOffset + 32);
            
            return new PublicKey(coinCreatorBytes);
        } catch (error) {
            logger.error('Error getting coin creator:', error.message);
            return null;
        }
    }

    async getProtocolFeeRecipients() {
        try {
            const [globalConfig] = PublicKey.findProgramAddressSync(
                [Buffer.from("global_config")],
                this.PUMPSWAP_PROGRAM_ID
            );

            const globalConfigInfo = await this.connection.getAccountInfo(globalConfig);
            if (!globalConfigInfo) return [];

            const data = globalConfigInfo.data;
            const protocolFeeRecipientsOffset = 8 + 32 + 8 + 8 + 1;
            const protocolFeeRecipients = [];
            
            for (let i = 0; i < 8; i++) {
                const recipientOffset = protocolFeeRecipientsOffset + (i * 32);
                const recipientBytes = data.slice(recipientOffset, recipientOffset + 32);
                const recipient = new PublicKey(recipientBytes);
                
                if (!recipient.equals(PublicKey.default)) {
                    protocolFeeRecipients.push(recipient);
                }
            }
            
            return protocolFeeRecipients;
        } catch (error) {
            logger.error('Error getting protocol fee recipients:', error.message);
            return [];
        }
    }

    async getExpectedSolOutput(poolAddress, sellTokenAmount, baseMint) {
        try {
            const poolBaseTokenAccount = getAssociatedTokenAddressSync(baseMint, poolAddress, true);
            const poolQuoteTokenAccount = getAssociatedTokenAddressSync(this.WSOL_MINT, poolAddress, true);

            const [baseReserveInfo, quoteReserveInfo] = await Promise.all([
                this.connection.getTokenAccountBalance(poolBaseTokenAccount),
                this.connection.getTokenAccountBalance(poolQuoteTokenAccount)
            ]);
            
            const baseReserve = new BN(baseReserveInfo.value.amount);
            const quoteReserve = new BN(quoteReserveInfo.value.amount);

            const k = baseReserve.mul(quoteReserve);
            const newBaseReserve = baseReserve.add(sellTokenAmount);
            const newQuoteReserve = k.div(newBaseReserve);
            const expectedSolOutput = quoteReserve.sub(newQuoteReserve);
            
            return expectedSolOutput;
        } catch (error) {
            logger.error('Error calculating expected SOL output:', error.message);
            return new BN(Math.floor(sellTokenAmount.toNumber() * 0.000001)); 
        }
    }

    // 🔥 ENHANCED: executeBuy with exact amount parsing
    async executeBuy(tokenMint, solAmount, customSlippage = null) {
        try {
            if (!this.wallet || !this.program) {
                throw new Error('Wallet or program not initialized for trading');
            }

            const slippageToUse = customSlippage !== null ? customSlippage : this.config.buySlippage;

            logger.info(`🚀 EXECUTING REAL BUY: ${solAmount} SOL → ${tokenMint}`);
            logger.info(`🎯 Using buy slippage: ${slippageToUse}%`);

            const poolAddress = await this.findPool(tokenMint);
            if (!poolAddress) {
                throw new Error(`Pool not found after ${this.config.maxRetries} attempts`);
            }

            logger.info(`🏊 Using pool: ${poolAddress.toString()}`);

            const mintPubkey = new PublicKey(tokenMint);
            const quoteMint = this.WSOL_MINT;

            const coinCreator = await this.getPoolCoinCreator(poolAddress);
            if (!coinCreator) {
                throw new Error('Coin creator not found');
            }

            const protocolFeeRecipients = await this.getProtocolFeeRecipients();
            if (protocolFeeRecipients.length === 0) {
                throw new Error('No protocol fee recipients found');
            }

            const protocolFeeRecipient = protocolFeeRecipients[0];

            // Derive required PDAs
            const [globalConfig] = PublicKey.findProgramAddressSync(
                [Buffer.from("global_config")],
                this.PUMPSWAP_PROGRAM_ID
            );

            const [eventAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("__event_authority")],
                this.PUMPSWAP_PROGRAM_ID
            );

            const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("creator_vault"), coinCreator.toBytes()],
                this.PUMPSWAP_PROGRAM_ID
            );

            // Token accounts
            const userBaseTokenAccount = getAssociatedTokenAddressSync(mintPubkey, this.wallet.publicKey);
            const userQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, this.wallet.publicKey);
            const poolBaseTokenAccount = getAssociatedTokenAddressSync(mintPubkey, poolAddress, true);
            const poolQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, poolAddress, true);
            const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(quoteMint, protocolFeeRecipient, true);
            const coinCreatorVaultAta = getAssociatedTokenAddressSync(quoteMint, coinCreatorVaultAuthority, true);

            // Calculate amounts - Following IDL: buy(base_amount_out, max_quote_amount_in)
            const maxQuoteAmountIn = new BN(solAmount * 1e9); // Convert SOL to lamports
            
            // Calculate expected tokens we'll receive (base_amount_out)
            const currentPrice = await this.calculatePrice(poolAddress, tokenMint);
            if (!currentPrice) {
                throw new Error('Could not get current price');
            }
            
            const slippageFactor = (100 - slippageToUse) / 100;
            const expectedTokensOut = (solAmount / currentPrice) * slippageFactor;
            const baseAmountOut = new BN(Math.floor(expectedTokensOut * 1e6)); // Assuming 6 decimals

            logger.info(`💰 Buying: max ${solAmount} SOL for ~${(expectedTokensOut / 1e6).toFixed(2)}M tokens`);
            logger.info(`💰 Current price: ${currentPrice.toFixed(12)} SOL per token`);

            const instructions = [];

            // Compute budget
            instructions.push(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 })
            );

            // Create token accounts if needed
            instructions.push(
                createAssociatedTokenAccountIdempotentInstruction(
                    this.wallet.publicKey,
                    userBaseTokenAccount,
                    this.wallet.publicKey,
                    mintPubkey
                ),
                createAssociatedTokenAccountIdempotentInstruction(
                    this.wallet.publicKey,
                    userQuoteTokenAccount,
                    this.wallet.publicKey,
                    quoteMint
                )
            );

            // Transfer SOL to WSOL account
            instructions.push(
                SystemProgram.transfer({
                    fromPubkey: this.wallet.publicKey,
                    toPubkey: userQuoteTokenAccount,
                    lamports: maxQuoteAmountIn.toNumber(),
                })
            );

            // Sync native (convert SOL to WSOL)
            instructions.push({
                keys: [{ pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true }],
                programId: TOKEN_PROGRAM_ID,
                data: Buffer.from([17]) // SyncNative instruction
            });

            // PumpSwap buy instruction - Following IDL: buy(base_amount_out, max_quote_amount_in)
            const buyIx = await this.program.methods
                .buy(baseAmountOut, maxQuoteAmountIn)
                .accounts({
                    pool: poolAddress,
                    user: this.wallet.publicKey,
                    globalConfig: globalConfig,
                    baseMint: mintPubkey,
                    quoteMint: quoteMint,
                    userBaseTokenAccount: userBaseTokenAccount,
                    userQuoteTokenAccount: userQuoteTokenAccount,
                    poolBaseTokenAccount: poolBaseTokenAccount,
                    poolQuoteTokenAccount: poolQuoteTokenAccount,
                    protocolFeeRecipient: protocolFeeRecipient,
                    protocolFeeRecipientTokenAccount: protocolFeeRecipientTokenAccount,
                    baseTokenProgram: TOKEN_PROGRAM_ID,
                    quoteTokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    eventAuthority: eventAuthority,
                    program: this.PUMPSWAP_PROGRAM_ID,
                    coinCreatorVaultAta: coinCreatorVaultAta,
                    coinCreatorVaultAuthority: coinCreatorVaultAuthority,
                })
                .instruction();

            instructions.push(buyIx);

            // Build and send transaction
            const { blockhash } = await this.connection.getLatestBlockhash();
            const message = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: instructions,
            }).compileToV0Message();

            const transaction = new VersionedTransaction(message);
            transaction.sign([this.wallet]);

            logger.info('📤 Sending buy transaction...');
            const signature = await this.connection.sendTransaction(transaction, {
                maxRetries: 3
            });
            
            // Wait for confirmation
            const latestBlockhash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
                signature: signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, 'confirmed');

            this.stats.buysExecuted++;

            logger.info(`✅ BUY SUCCESS!`);
            logger.info(`   Signature: ${signature}`);
            logger.info(`   Pool Used: ${poolAddress.toString()}`);
            logger.info(`   Explorer: https://solscan.io/tx/${signature}`);

            // 🔥 NEW: Parse exact amounts from transaction
            const exactAmounts = await this.parseBuyEventFromTransaction(signature);
            
            if (exactAmounts && exactAmounts.success) {
                this.stats.exactAmountsParsed++;
                logger.info(`✅ EXACT AMOUNTS PARSED:`);
                logger.info(`   SOL Spent: ${exactAmounts.exactSolSpent.toFixed(6)} SOL`);
                logger.info(`   Tokens Received: ${exactAmounts.exactTokensReceived.toLocaleString()} tokens`);
                logger.info(`   Effective Price: ${(exactAmounts.exactSolSpent / exactAmounts.exactTokensReceived).toFixed(12)} SOL per token`);
                
                return {
                    success: true,
                    signature: signature,
                    // 🔥 EXACT AMOUNTS from blockchain events
                    solSpent: exactAmounts.exactSolSpent,
                    tokensReceived: exactAmounts.exactTokensReceived,
                    // Original calculated amounts for comparison
                    estimatedSolSpent: solAmount,
                    estimatedTokensReceived: expectedTokensOut,
                    poolAddress: poolAddress.toString(),
                    calculatedPrice: exactAmounts.exactSolSpent / exactAmounts.exactTokensReceived,
                    type: 'BUY',
                    slippageUsed: slippageToUse,
                    exactData: exactAmounts
                };
            } else {
                // Fallback to original estimates if parsing fails
                this.stats.estimatesUsed++;
                logger.warn('⚠️ Could not parse exact amounts, using estimates');
                return {
                    success: true,
                    signature: signature,
                    solSpent: solAmount, // Estimate
                    tokensReceived: expectedTokensOut, // Estimate
                    poolAddress: poolAddress.toString(),
                    calculatedPrice: currentPrice,
                    type: 'BUY',
                    slippageUsed: slippageToUse,
                    exactData: null
                };
            }

        } catch (error) {
            this.stats.errors++;
            logger.error('❌ Buy failed:', error.message);
            throw error;
        }
    }

    // 🔥 ENHANCED: executeSell with exact amount parsing
    async executeSell(tokenMint, tokenAmount, customSlippage = null) {
        try {
            if (!this.wallet || !this.program) {
                throw new Error('Wallet or program not initialized for trading');
            }

            const slippageToUse = customSlippage !== null ? customSlippage : this.config.sellSlippage;
    
            logger.info(`🚀 EXECUTING REAL SELL: ${tokenAmount} tokens → SOL`);
    
            const poolAddress = await this.findPool(tokenMint);
            if (!poolAddress) {
                throw new Error('Pool not found');
            }
    
            logger.info(`🏊 Using pool: ${poolAddress.toString()}`);
    
            const mintPubkey = new PublicKey(tokenMint);
            const quoteMint = this.WSOL_MINT;
    
            const coinCreator = await this.getPoolCoinCreator(poolAddress);
            if (!coinCreator) {
                throw new Error('Coin creator not found');
            }
    
            const protocolFeeRecipients = await this.getProtocolFeeRecipients();
            if (protocolFeeRecipients.length === 0) {
                throw new Error('No protocol fee recipients found');
            }
    
            const protocolFeeRecipient = protocolFeeRecipients[0];
    
            const baseAmountIn = new BN(tokenAmount * 1e6);
            const expectedSolOutput = await this.getExpectedSolOutput(poolAddress, baseAmountIn, mintPubkey);
            const slippageFactor = new BN(100 - slippageToUse);
            const minQuoteOut = expectedSolOutput.mul(slippageFactor).div(new BN(100));
    
            logger.info(`💰 Selling ${tokenAmount} tokens for ~${(parseFloat(expectedSolOutput.toString()) / 1e9).toFixed(6)} SOL`);
    
            const [globalConfig] = PublicKey.findProgramAddressSync(
                [Buffer.from("global_config")],
                this.PUMPSWAP_PROGRAM_ID
            );
    
            const [eventAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("__event_authority")],
                this.PUMPSWAP_PROGRAM_ID
            );
    
            const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("creator_vault"), coinCreator.toBytes()],
                this.PUMPSWAP_PROGRAM_ID
            );
    
            const userBaseTokenAccount = getAssociatedTokenAddressSync(mintPubkey, this.wallet.publicKey);
            const userQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, this.wallet.publicKey);
            const poolBaseTokenAccount = getAssociatedTokenAddressSync(mintPubkey, poolAddress, true);
            const poolQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, poolAddress, true);
            const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(quoteMint, protocolFeeRecipient, true);
            const coinCreatorVaultAta = getAssociatedTokenAddressSync(quoteMint, coinCreatorVaultAuthority, true);
    
            const instructions = [];
    
            instructions.push(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 })
            );
    
            instructions.push(
                createAssociatedTokenAccountIdempotentInstruction(
                    this.wallet.publicKey,
                    userQuoteTokenAccount,
                    this.wallet.publicKey,
                    quoteMint
                )
            );
    
            const sellIx = await this.program.methods
                .sell(baseAmountIn, minQuoteOut)
                .accounts({
                    pool: poolAddress,
                    user: this.wallet.publicKey,
                    globalConfig: globalConfig,
                    baseMint: mintPubkey,
                    quoteMint: quoteMint,
                    userBaseTokenAccount: userBaseTokenAccount,
                    userQuoteTokenAccount: userQuoteTokenAccount,
                    poolBaseTokenAccount: poolBaseTokenAccount,
                    poolQuoteTokenAccount: poolQuoteTokenAccount,
                    protocolFeeRecipient: protocolFeeRecipient,
                    protocolFeeRecipientTokenAccount: protocolFeeRecipientTokenAccount,
                    baseTokenProgram: TOKEN_PROGRAM_ID,
                    quoteTokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    eventAuthority: eventAuthority,
                    program: this.PUMPSWAP_PROGRAM_ID,
                    coinCreatorVaultAta: coinCreatorVaultAta,
                    coinCreatorVaultAuthority: coinCreatorVaultAuthority,
                })
                .instruction();
    
            instructions.push(sellIx);
    
            const closeAccountIx = createCloseAccountInstruction(
                userQuoteTokenAccount,
                this.wallet.publicKey, 
                this.wallet.publicKey  
            );
            
            instructions.push(closeAccountIx);
    
            const { blockhash } = await this.connection.getLatestBlockhash();
            const message = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: instructions,
            }).compileToV0Message();
    
            const transaction = new VersionedTransaction(message);
            transaction.sign([this.wallet]);
    
            logger.info('📤 Sending sell transaction with automatic wSOL unwrapping...');
            const signature = await this.connection.sendTransaction(transaction, {
                maxRetries: 3
            });
            
            // Wait for confirmation
            const latestBlockhash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
                signature: signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, 'confirmed');
    
            this.stats.sellsExecuted++;

            logger.info(`✅ SELL SUCCESS!`);
            logger.info(`   Signature: ${signature}`);
            logger.info(`   Pool Used: ${poolAddress.toString()}`);
            logger.info(`   Explorer: https://solscan.io/tx/${signature}`);

            // 🔥 NEW: Parse exact amounts from sell transaction
            const exactAmounts = await this.parseSellEventFromTransaction(signature);
            
            if (exactAmounts && exactAmounts.success) {
                this.stats.exactAmountsParsed++;
                logger.info(`✅ EXACT SELL AMOUNTS PARSED:`);
                logger.info(`   Tokens Sold: ${exactAmounts.exactTokensSold.toLocaleString()} tokens`);
                logger.info(`   SOL Received: ${exactAmounts.exactSolReceived.toFixed(6)} SOL`);
                
                return {
                    success: true,
                    signature: signature,
                    solReceived: exactAmounts.exactSolReceived,
                    tokensSpent: exactAmounts.exactTokensSold,
                    poolAddress: poolAddress.toString(),
                    type: 'SELL',
                    unwrapped: true,
                    slippageUsed: slippageToUse,
                    exactData: exactAmounts
                };
            } else {
                // Fallback to estimates
                this.stats.estimatesUsed++;
                const solReceived = parseFloat(expectedSolOutput.toString()) / 1e9;
                logger.warn('⚠️ Could not parse exact sell amounts, using estimates');
                
                return {
                    success: true,
                    signature: signature,
                    solReceived: solReceived,
                    tokensSpent: tokenAmount,
                    poolAddress: poolAddress.toString(),
                    type: 'SELL',
                    unwrapped: true,
                    slippageUsed: slippageToUse,
                    exactData: null
                };
            }
    
        } catch (error) {
            this.stats.errors++;
            logger.error('❌ Sell failed:', error.message);
            throw error;
        }
    }

    async updatePositionAfterSell(positionId, actualTokensSold, actualSolReceived, actualPnL, signature, reason) {
        try {
            const position = this.positions.get(positionId);
            if (!position) {
                logger.error(`Position ${positionId} not found for update after sell`);
                return;
            }
    
            logger.info(`📊 UPDATING POSITION AFTER SELL: ${position.symbol}`);
            logger.info(`   Actual tokens sold: ${actualTokensSold.toLocaleString()}`);
            logger.info(`   Actual SOL received: ${actualSolReceived.toFixed(6)} SOL`);
            logger.info(`   Actual PnL: ${actualPnL >= 0 ? '+' : ''}${actualPnL.toFixed(6)} SOL`);
    
            // Update position data with exact amounts
            const sellData = {
                tokenAmount: actualTokensSold,
                solReceived: actualSolReceived,
                pnl: actualPnL,
                signature: signature,
                reason: reason
            };
    
            // Call completeSell with exact data
            await this.completeSell(positionId, sellData);
    
            logger.info(`✅ Position ${position.symbol} updated with exact sell data`);
    
        } catch (error) {
            logger.error(`❌ Failed to update position after sell: ${error.message}`);
            throw error;
        }
    }

    getSlippageSettings() {
        return {
            buySlippage: this.config.buySlippage,
            sellSlippage: this.config.sellSlippage
        };
    }

    // Method to update slippage settings at runtime
    updateSlippageSettings(buySlippage = null, sellSlippage = null) {
        if (buySlippage !== null) {
            this.config.buySlippage = buySlippage;
            logger.info(`🎯 Updated buy slippage to: ${buySlippage}%`);
        }
        if (sellSlippage !== null) {
            this.config.sellSlippage = sellSlippage;
            logger.info(`🎯 Updated sell slippage to: ${sellSlippage}%`);
        }
    }

    async getTokenBalance(tokenMint) {
        try {
            if (!this.wallet) return 0;
            
            const mintPubkey = new PublicKey(tokenMint);
            const tokenAccount = getAssociatedTokenAddressSync(mintPubkey, this.wallet.publicKey);
            
            const balance = await this.connection.getTokenAccountBalance(tokenAccount);
            return parseFloat(balance.value.amount) / Math.pow(10, balance.value.decimals);
        } catch (error) {
            return 0;
        }
    }

    async getMarketData(tokenMint) {
        try {
            
            const poolAddress = await this.findPool(tokenMint);
            if (!poolAddress) {
                return null;
            }

            const poolInfo = await this.getPoolInfo(poolAddress);
            const reserves = await this.getPoolReserves(poolAddress);
            const price = await this.calculatePrice(poolAddress, tokenMint);

            if (!poolInfo || !reserves || !price) {
                return null;
            }

            return {
                poolAddress: poolAddress.toString(),
                baseMint: poolInfo.baseMint.toString(),
                quoteMint: poolInfo.quoteMint.toString(),
                price: price,
                baseReserve: reserves.baseAmountUI,
                quoteReserve: reserves.quoteAmountUI,
                tvl: reserves.quoteAmountUI * 2
            };
        } catch (error) {
            logger.error('❌ Error getting market data:', error.message);
            return null;
        }
    }

    async getPoolInfo(poolAddress) {
        try {
            const poolAccountInfo = await this.connection.getAccountInfo(poolAddress);
            if (!poolAccountInfo) return null;

            const data = poolAccountInfo.data;
            const baseMint = new PublicKey(data.slice(43, 75));
            const quoteMint = new PublicKey(data.slice(75, 107));
            
            return { baseMint, quoteMint };
        } catch (error) {
            return null;
        }
    }

    async getPoolReserves(poolAddress) {
        try {
            const poolInfo = await this.getPoolInfo(poolAddress);
            if (!poolInfo) return null;

            const poolBaseTokenAccount = getAssociatedTokenAddressSync(poolInfo.baseMint, poolAddress, true);
            const poolQuoteTokenAccount = getAssociatedTokenAddressSync(poolInfo.quoteMint, poolAddress, true);

            const [baseReserveInfo, quoteReserveInfo] = await Promise.all([
                this.connection.getTokenAccountBalance(poolBaseTokenAccount),
                this.connection.getTokenAccountBalance(poolQuoteTokenAccount)
            ]);

            return {
                baseAmountUI: baseReserveInfo.value.uiAmount,
                quoteAmountUI: quoteReserveInfo.value.uiAmount
            };
        } catch (error) {
            return null;
        }
    }

    async calculatePrice(poolAddress, tokenMint) {
        try {
            const reserves = await this.getPoolReserves(poolAddress);
            if (!reserves || reserves.baseAmountUI <= 0) return null;
            
            return reserves.quoteAmountUI / reserves.baseAmountUI;
        } catch (error) {
            return null;
        }
    }

    getStats() {
        return {
            ...this.stats,
            wallet: this.wallet?.publicKey.toString(),
            successRate: this.stats.poolsDerivied > 0 ? 
                ((this.stats.poolsFound / this.stats.poolsDerivied) * 100).toFixed(1) + '%' : '0%',
            retrySuccessRate: this.stats.retryAttempts > 0 ?
                ((this.stats.poolsFound / (this.stats.poolsDerivied + this.stats.retryAttempts)) * 100).toFixed(1) + '%' : 'N/A',
            exactParsingRate: (this.stats.buysExecuted + this.stats.sellsExecuted) > 0 ?
                ((this.stats.exactAmountsParsed / (this.stats.buysExecuted + this.stats.sellsExecuted)) * 100).toFixed(1) + '%' : '0%'
        };
    }
}

module.exports = PumpSwapService;