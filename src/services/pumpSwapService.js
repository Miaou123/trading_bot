// src/services/pumpSwapService.js - FIXED: Better pool derivation and debugging
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
            retryAttempts: 0 // 🔥 NEW: Track retry attempts
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

    // 🔥 METHOD 2: Alternative seed structure
    async derivePoolMethod2(mintPubkey) {
        try {
            logger.debug(`🔧 Method 2: Alternative seed derivation`);
            
            // Try different seed combinations
            const alternatives = [
                [Buffer.from("pool"), mintPubkey.toBytes(), this.WSOL_MINT.toBytes()],
                [Buffer.from("amm"), mintPubkey.toBytes(), this.WSOL_MINT.toBytes()],
                [Buffer.from("swap"), mintPubkey.toBytes(), this.WSOL_MINT.toBytes()]
            ];
            
            for (let i = 0; i < alternatives.length; i++) {
                const [poolPda] = PublicKey.findProgramAddressSync(
                    alternatives[i],
                    this.PUMPSWAP_PROGRAM_ID
                );
                
                logger.debug(`   Alternative ${i + 1}: ${poolPda.toString()}`);
                
                const poolAccountInfo = await this.connection.getAccountInfo(poolPda);
                if (poolAccountInfo) {
                    this.stats.poolsFound++;
                    logger.info(`✅ Method 2 SUCCESS: Alternative ${i + 1} exists`);
                    return poolPda;
                }
            }
            
            logger.debug(`❌ Method 2: No alternative derivations found`);
            return null;
            
        } catch (error) {
            logger.debug(`❌ Method 2 failed: ${error.message}`);
            return null;
        }
    }

    // 🔥 METHOD 3: Try multiple pool indices
    async derivePoolWithIndices(mintPubkey) {
        try {
            logger.debug(`🔧 Method 3: Multiple pool indices`);
            
            const [poolAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("pool-authority"), mintPubkey.toBytes()],
                this.PUMP_PROGRAM_ID
            );
            
            // Try indices 0-5
            for (let index = 0; index <= 5; index++) {
                const poolIndexBuffer = Buffer.alloc(2);
                poolIndexBuffer.writeUInt16LE(index, 0);
                
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
                
                logger.debug(`   Index ${index}: ${poolPda.toString()}`);
                
                const poolAccountInfo = await this.connection.getAccountInfo(poolPda);
                if (poolAccountInfo) {
                    this.stats.poolsFound++;
                    logger.info(`✅ Method 3 SUCCESS: Index ${index} exists`);
                    return poolPda;
                }
            }
            
            logger.debug(`❌ Method 3: No indices 0-5 found`);
            return null;
            
        } catch (error) {
            logger.debug(`❌ Method 3 failed: ${error.message}`);
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

            return {
                success: true,
                signature: signature,
                solSpent: solAmount,
                tokensReceived: expectedTokensOut,
                poolAddress: poolAddress.toString(),
                alculatedPrice: currentPrice,
                type: 'BUY',
                slippageUsed: slippageToUse
            };

        } catch (error) {
            this.stats.errors++;
            logger.error('❌ Buy failed:', error.message);
            throw error;
        }
    }

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
            const solReceived = parseFloat(expectedSolOutput.toString()) / 1e9;
    
            logger.info(`✅ SELL SUCCESS!`);
            logger.info(`   Signature: ${signature}`);
            logger.info(`   Pool Used: ${poolAddress.toString()}`);
            logger.info(`   SOL Received: ~${solReceived.toFixed(6)} SOL (automatically unwrapped)`);
            logger.info(`   Explorer: https://solscan.io/tx/${signature}`);
    
            return {
                success: true,
                signature: signature,
                solReceived: solReceived,
                tokensSpent: tokenAmount,
                poolAddress: poolAddress.toString(),
                type: 'SELL',
                unwrapped: true,
                slippageUsed: slippageToUse
            };
    
        } catch (error) {
            this.stats.errors++;
            logger.error('❌ Sell failed:', error.message);
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
                ((this.stats.poolsFound / (this.stats.poolsDerivied + this.stats.retryAttempts)) * 100).toFixed(1) + '%' : 'N/A'
        };
    }
}

module.exports = PumpSwapService;