// src/services/pumpSwapService.js - FIXED: Complete service with corrected event parsing
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
            estimatesUsed: 0,
            lastTradeData: null
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
            logger.info('✅ Anchor program initialized');
            return true;
        } catch (error) {
            logger.error('❌ Anchor initialization failed:', error.message);
            return false;
        }
    }

    // 🔥 FIXED: Using the original working pool derivation logic
    async findPool(tokenMint, retryAttempts = 0) {
        try {
            const mintPubkey = new PublicKey(tokenMint);
            
            logger.debug(`🔧 Pool derivation for: ${tokenMint} (attempt ${retryAttempts + 1})`);
            
            // 🔥 CORRECT METHOD: Original working derivation logic
            const [poolAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("pool-authority"), mintPubkey.toBytes()],
                this.PUMP_PROGRAM_ID  // Uses PUMP_PROGRAM_ID to derive pool authority
            );
            
            logger.debug(`   Pool Authority: ${poolAuthority.toString()}`);
            
            const poolIndexBuffer = Buffer.alloc(2);
            poolIndexBuffer.writeUInt16LE(0, 0);  // Start with index 0
            
            const [poolPda] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("pool"),
                    poolIndexBuffer,
                    poolAuthority.toBytes(),  // Use derived pool authority as creator
                    mintPubkey.toBytes(),     // base_mint
                    this.WSOL_MINT.toBytes()  // quote_mint
                ],
                this.PUMPSWAP_PROGRAM_ID
            );
            
            logger.debug(`   Derived Pool: ${poolPda.toString()}`);
            this.stats.poolsDerivied++;
            
            const poolAccountInfo = await this.connection.getAccountInfo(poolPda);
            if (poolAccountInfo) {
                this.stats.poolsFound++;
                logger.debug(`✅ Pool found: ${poolPda.toString()}`);
                return poolPda;
            } 
            
            logger.debug(`❌ Pool derived but doesn't exist on-chain yet`);
            
            // 🔥 RETRY LOGIC: Keep trying for new migrations
            if (retryAttempts < this.config.maxRetries - 1) {
                this.stats.retryAttempts++;
                logger.info(`🔄 Retrying pool derivation in ${this.config.retryDelay}ms... (${retryAttempts + 1}/${this.config.maxRetries})`);
                
                await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                return await this.findPool(tokenMint, retryAttempts + 1);
            }
            
            this.stats.poolsNotFound++;
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

    async getGlobalConfig() {
        try {
            const [globalConfig] = PublicKey.findProgramAddressSync(
                [Buffer.from('global_config')],  // FIXED: Use underscore not hyphen
                this.PUMPSWAP_PROGRAM_ID
            );
            logger.debug(`🔧 Global Config: ${globalConfig.toString()}`);
            return globalConfig;
        } catch (error) {
            logger.error('Error getting global config:', error.message);
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
            const globalConfig = await this.getGlobalConfig();
            if (!globalConfig) return [];

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
    
            const slippageToUse = customSlippage !== null ? 
                customSlippage : this.config.buySlippage;
    
            logger.info(`🚀 EXECUTING REAL BUY: ${solAmount} SOL → ${tokenMint}`);
            logger.info(`🎯 Using buy slippage: ${slippageToUse}%`);
    
            // Find the pool
            const poolAddress = await this.findPool(tokenMint);
            if (!poolAddress) {
                throw new Error('Pool not found for this token');
            }
    
            logger.info(`🏊 Using pool: ${poolAddress.toString()}`);
    
            const mintPubkey = new PublicKey(tokenMint);
            const quoteMint = this.WSOL_MINT;
    
            // Get current price
            const currentPrice = await this.calculatePrice(poolAddress, tokenMint);
            if (!currentPrice) {
                throw new Error('Could not calculate current price');
            }
    
            // Calculate amounts
            const maxQuoteAmountIn = new BN(Math.floor(solAmount * 1e9));
            const estimatedTokensOut = maxQuoteAmountIn.toNumber() / (currentPrice * 1e9) * 1e6;
            const baseAmountOut = new BN(Math.floor(estimatedTokensOut * (1 - slippageToUse / 100)));
    
            logger.info(`💰 Buying: max ${solAmount} SOL for ~${(baseAmountOut.toNumber() / 1e6).toFixed(2)}M tokens`);
            logger.info(`💰 Current price: ${currentPrice.toFixed(12)} SOL per token`);
    
            // Get required accounts
            const globalConfig = await this.getGlobalConfig();
            const protocolFeeRecipients = await this.getProtocolFeeRecipients();
            const protocolFeeRecipient = protocolFeeRecipients[0] || this.wallet.publicKey;
    
            const userBaseTokenAccount = getAssociatedTokenAddressSync(mintPubkey, this.wallet.publicKey);
            const userQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, this.wallet.publicKey);
            const poolBaseTokenAccount = getAssociatedTokenAddressSync(mintPubkey, poolAddress, true);
            const poolQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, poolAddress, true);
            const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(quoteMint, protocolFeeRecipient, true);
    
            const [eventAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from('__event_authority')],
                this.PUMPSWAP_PROGRAM_ID
            );
    
            let coinCreatorVaultAta, coinCreatorVaultAuthority;

            try {
                // Get the coin creator from pool data
                const coinCreator = await this.getPoolCoinCreator(poolAddress);
                
                if (coinCreator && !coinCreator.equals(PublicKey.default)) {
                    // 🔥 EXACT derivation from IDL: "creator_vault" + coin_creator
                    const [derivedCoinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
                        [Buffer.from("creator_vault"), coinCreator.toBytes()],
                        this.PUMPSWAP_PROGRAM_ID
                    );
                    
                    coinCreatorVaultAuthority = derivedCoinCreatorVaultAuthority;
                    coinCreatorVaultAta = getAssociatedTokenAddressSync(quoteMint, coinCreatorVaultAuthority, true);
                    
                    logger.debug(`🎨 Coin Creator: ${coinCreator.toString()}`);
                    logger.debug(`🏦 Coin Creator Vault Authority: ${coinCreatorVaultAuthority.toString()}`);
                    
                } else {
                    // If no coin creator, use wallet as fallback
                    coinCreatorVaultAuthority = this.wallet.publicKey;
                    coinCreatorVaultAta = getAssociatedTokenAddressSync(quoteMint, this.wallet.publicKey);
                    
                    logger.debug(`💰 Using wallet as coin creator fallback: ${this.wallet.publicKey.toString()}`);
                }
                
            } catch (error) {
                logger.error(`⚠️ Error getting coin creator, using wallet: ${error.message}`);
                coinCreatorVaultAuthority = this.wallet.publicKey;
                coinCreatorVaultAta = getAssociatedTokenAddressSync(quoteMint, this.wallet.publicKey);
            }
    
            // Build instructions
            const instructions = [];
    
            instructions.push(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })
            );
    
            // Create token accounts if needed
            instructions.push(
                createAssociatedTokenAccountIdempotentInstruction(
                    this.wallet.publicKey,
                    userBaseTokenAccount,
                    this.wallet.publicKey,
                    mintPubkey
                )
            );
    
            instructions.push(
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
    
            // PumpSwap buy instruction
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
    
            // Close WSOL account to get rent back
            instructions.push(
                createCloseAccountInstruction(
                    userQuoteTokenAccount,
                    this.wallet.publicKey,
                    this.wallet.publicKey
                )
            );
    
            // 🔥 NEW: Build and send transaction with direct event parsing
            const signature = await this.sendAndConfirmWithDirectEventParsing(instructions);
    
            this.stats.buysExecuted++;
    
            logger.info(`✅ BUY SUCCESS!`);
            logger.info(`   Signature: ${signature}`);
            logger.info(`   Pool Used: ${poolAddress.toString()}`);
            logger.info(`   Explorer: https://solscan.io/tx/${signature}`);
    
            // 🔥 NEW: Get exact amounts from direct event parsing
            const exactAmounts = this.getLastTradeData();
            
            if (exactAmounts && exactAmounts.success) {
                this.stats.exactAmountsParsed++;
                logger.info(`✅ EXACT AMOUNTS PARSED:`);
                logger.info(`   SOL Spent: ${exactAmounts.exactSolSpent.toFixed(6)} SOL`);
                logger.info(`   Tokens Received: ${exactAmounts.exactTokensReceived.toLocaleString()} tokens`);
                logger.info(`   Effective Price: ${(exactAmounts.exactSolSpent / exactAmounts.exactTokensReceived).toFixed(12)} SOL per token`);
                
                return {
                    success: true,
                    signature: signature,
                    solSpent: exactAmounts.exactSolSpent,
                    tokensReceived: exactAmounts.exactTokensReceived,
                    poolAddress: poolAddress.toString(),
                    calculatedPrice: exactAmounts.exactSolSpent / exactAmounts.exactTokensReceived,
                    type: 'BUY',
                    slippageUsed: slippageToUse,
                    exactData: exactAmounts
                };
            } else {
                // Use estimates if parsing fails
                this.stats.estimatesUsed++;
                logger.warn('⚠️ Could not parse exact amounts, using estimates');
                return {
                    success: true,
                    signature: signature,
                    solSpent: solAmount,
                    tokensReceived: baseAmountOut.toNumber() / 1e6,
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
    
    // 2. Replace your executeSell method with this enhanced version:
    async executeSell(tokenMint, tokenAmount, customSlippage = null) {
        try {
            if (!this.wallet || !this.program) {
                throw new Error('Wallet or program not initialized for trading');
            }
    
            const slippageToUse = customSlippage !== null ? 
                customSlippage : this.config.sellSlippage;
    
            logger.info(`🚀 EXECUTING REAL SELL: ${tokenAmount} tokens → SOL`);
            logger.info(`🎯 Using sell slippage: ${slippageToUse}%`);
    
            // Find the pool
            const poolAddress = await this.findPool(tokenMint);
            if (!poolAddress) {
                throw new Error('Pool not found for this token');
            }
    
            logger.info(`🏊 Using pool: ${poolAddress.toString()}`);
    
            const mintPubkey = new PublicKey(tokenMint);
            const quoteMint = this.WSOL_MINT;
    
            // Calculate amounts
            const baseAmountIn = new BN(Math.floor(tokenAmount * 1e6));
            const expectedSolOutput = await this.getExpectedSolOutput(poolAddress, baseAmountIn, mintPubkey);
            const minQuoteAmountOut = new BN(Math.floor(expectedSolOutput.toNumber() * (1 - slippageToUse / 100)));
    
            logger.info(`💰 Selling: ${tokenAmount} tokens for ~${(expectedSolOutput.toNumber() / 1e9).toFixed(6)} SOL`);
            logger.info(`💰 Min SOL expected: ${(minQuoteAmountOut.toNumber() / 1e9).toFixed(6)} SOL`);
    
            // Get required accounts
            const globalConfig = await this.getGlobalConfig();
            const protocolFeeRecipients = await this.getProtocolFeeRecipients();
            const protocolFeeRecipient = protocolFeeRecipients[0] || this.wallet.publicKey;
    
            const userBaseTokenAccount = getAssociatedTokenAddressSync(mintPubkey, this.wallet.publicKey);
            const userQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, this.wallet.publicKey);
            const poolBaseTokenAccount = getAssociatedTokenAddressSync(mintPubkey, poolAddress, true);
            const poolQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, poolAddress, true);
            const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(quoteMint, protocolFeeRecipient, true);
    
            const [eventAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from('__event_authority')],
                this.PUMPSWAP_PROGRAM_ID
            );
    
            let coinCreatorVaultAta, coinCreatorVaultAuthority;
            
            try {
                const coinCreator = await this.getPoolCoinCreator(poolAddress);
                
                if (coinCreator && !coinCreator.equals(PublicKey.default)) {
                    // 🔥 CORRECT: Same as buy method
                    const [derivedCoinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
                        [Buffer.from("creator_vault"), coinCreator.toBytes()],
                        this.PUMPSWAP_PROGRAM_ID  // ✅ Correct program
                    );
                    
                    coinCreatorVaultAuthority = derivedCoinCreatorVaultAuthority;
                    coinCreatorVaultAta = getAssociatedTokenAddressSync(quoteMint, coinCreatorVaultAuthority, true);
                } else {
                    coinCreatorVaultAuthority = this.wallet.publicKey;
                    coinCreatorVaultAta = getAssociatedTokenAddressSync(quoteMint, this.wallet.publicKey);
                }
            } catch (error) {
                coinCreatorVaultAuthority = this.wallet.publicKey;
                coinCreatorVaultAta = getAssociatedTokenAddressSync(quoteMint, this.wallet.publicKey);
            }
    
            // Build instructions
            const instructions = [];
    
            instructions.push(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })
            );
    
            // Create WSOL account if needed
            instructions.push(
                createAssociatedTokenAccountIdempotentInstruction(
                    this.wallet.publicKey,
                    userQuoteTokenAccount,
                    this.wallet.publicKey,
                    quoteMint
                )
            );
    
            // PumpSwap sell instruction
            const sellIx = await this.program.methods
                .sell(baseAmountIn, minQuoteAmountOut)
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
    
            // Close WSOL account to unwrap SOL
            instructions.push(
                createCloseAccountInstruction(
                    userQuoteTokenAccount,
                    this.wallet.publicKey,
                    this.wallet.publicKey
                )
            );
    
            // 🔥 NEW: Build and send transaction with direct event parsing
            const signature = await this.sendAndConfirmWithDirectEventParsing(instructions);
    
            this.stats.sellsExecuted++;
    
            logger.info(`✅ SELL SUCCESS!`);
            logger.info(`   Signature: ${signature}`);
            logger.info(`   Pool Used: ${poolAddress.toString()}`);
            logger.info(`   Explorer: https://solscan.io/tx/${signature}`);
    
            // 🔥 NEW: Get exact amounts from direct event parsing
            const exactAmounts = this.getLastTradeData();
            
            if (exactAmounts && exactAmounts.success) {
                this.stats.exactAmountsParsed++;
                logger.info(`✅ EXACT AMOUNTS PARSED:`);
                logger.info(`   Tokens Sold: ${exactAmounts.exactTokensSold.toLocaleString()} tokens`);
                logger.info(`   SOL Received: ${exactAmounts.exactSolReceived.toFixed(6)} SOL`);
                
                return {
                    success: true,
                    signature: signature,
                    solReceived: exactAmounts.exactSolReceived,
                    tokensSpent: exactAmounts.exactTokensSold,
                    poolAddress: poolAddress.toString(),
                    calculatedPrice: exactAmounts.exactSolReceived / exactAmounts.exactTokensSold,
                    type: 'SELL',
                    slippageUsed: slippageToUse,
                    exactData: exactAmounts
                };
            } else {
                // Use estimates if parsing fails
                this.stats.estimatesUsed++;
                logger.warn('⚠️ Could not parse exact amounts, using estimates');
                return {
                    success: true,
                    signature: signature,
                    solReceived: expectedSolOutput.toNumber() / 1e9,
                    tokensSpent: tokenAmount,
                    poolAddress: poolAddress.toString(),
                    calculatedPrice: (expectedSolOutput.toNumber() / 1e9) / tokenAmount,
                    type: 'SELL',
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
    
    // 3. ADD these new methods to your class:
    
    // 🔥 NEW: Send transaction and parse events directly from confirmation logs
    async sendAndConfirmWithDirectEventParsing(instructions) {
        try {
            // Build transaction
            const { blockhash } = await this.connection.getLatestBlockhash();
            const message = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: instructions,
            }).compileToV0Message();
    
            const transaction = new VersionedTransaction(message);
            transaction.sign([this.wallet]);
    
            logger.info('📤 Sending transaction...');
            const signature = await this.connection.sendTransaction(transaction, {
                maxRetries: 3
            });
            
            logger.info(`📡 Transaction sent: ${signature}`);
            logger.info(`🕐 Waiting for confirmation...`);
    
            // Wait for confirmation
            const latestBlockhash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
                signature: signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, 'confirmed');
    
            // 🔥 Get transaction details with logs (ONLY ONE getTransaction call needed!)
            const txDetails = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });
    
            if (!txDetails || !txDetails.meta) {
                throw new Error('Could not retrieve transaction details');
            }
    
            logger.info(`📊 Transaction confirmed! Compute units: ${txDetails.meta.computeUnitsConsumed}`);
    
            // 🔥 PARSE EVENTS DIRECTLY FROM LOGS (NO separate getTransaction calls!)
            const eventData = this.parseEventsFromLogs(txDetails.meta.logMessages || []);
            
            if (eventData) {
                logger.info(`🎉 EVENT PARSED SUCCESSFULLY!`);
                this.stats.exactAmountsParsed++;
                
                // Store the exact amounts for retrieval
                this.lastTradeData = {
                    signature,
                    timestamp: Date.now(),
                    ...eventData
                };
            } else {
                logger.warn(`⚠️ Could not parse event data, will use estimates`);
                this.stats.estimatesUsed++;
                this.lastTradeData = null;
            }
    
            return signature;
    
        } catch (error) {
            logger.error(`❌ Transaction failed:`, error.message);
            throw error;
        }
    }
    
    // 🔥 NEW: Parse events directly from log messages
    parseEventsFromLogs(logMessages) {
        try {
            logger.info(`🔍 Parsing events from ${logMessages.length} log messages`);
    
            const buyEventDiscriminator = [103, 244, 82, 31, 44, 245, 119, 119];
            const sellEventDiscriminator = [62, 47, 55, 10, 165, 3, 220, 42];
    
            // 🔥 Look for "Program data:" logs (this is where events are!)
            const programDataLogs = logMessages.filter(log => 
                log.startsWith('Program data:')
            );
    
            logger.info(`🎯 Found ${programDataLogs.length} program data logs`);
    
            for (let i = 0; i < programDataLogs.length; i++) {
                const log = programDataLogs[i];
                logger.info(`🔍 Examining program data log ${i + 1}: ${log.substring(0, 50)}...`);
    
                try {
                    // Extract base64 data after "Program data: "
                    const dataString = log.substring('Program data: '.length).trim();
                    
                    if (!dataString || dataString.length < 20) {
                        logger.info(`   ❌ Data string too short, skipping`);
                        continue;
                    }
    
                    const eventData = Buffer.from(dataString, 'base64');
                    logger.info(`   ✅ Decoded ${eventData.length} bytes`);
    
                    if (eventData.length < 8) {
                        logger.info(`   ❌ Event data too short (< 8 bytes), skipping`);
                        continue;
                    }
    
                    const discriminator = Array.from(eventData.slice(0, 8));
                    logger.info(`   Discriminator: [${discriminator.join(', ')}]`);
    
                    // Check for BuyEvent
                    if (this.arraysEqual(discriminator, buyEventDiscriminator)) {
                        logger.info(`   🎉 FOUND BUY EVENT!`);
                        return this.parseBuyEventData(eventData);
                    }
    
                    // Check for SellEvent  
                    if (this.arraysEqual(discriminator, sellEventDiscriminator)) {
                        logger.info(`   🎉 FOUND SELL EVENT!`);
                        return this.parseSellEventData(eventData);
                    }
    
                    logger.info(`   ❌ Unknown event discriminator`);
    
                } catch (parseError) {
                    logger.error(`   💥 Error parsing log ${i + 1}:`, parseError.message);
                    continue;
                }
            }
    
            logger.warn(`❌ No BuyEvent or SellEvent found in logs`);
            return null;
    
        } catch (error) {
            logger.error('💥 Error parsing events from logs:', error.message);
            return null;
        }
    }
    
    // 🔥 Helper function to compare arrays
    arraysEqual(a, b) {
        return a.length === b.length && a.every((val, i) => val === b[i]);
    }
    
    // 🔥 ENHANCED: Parse BuyEvent with detailed logging
    parseBuyEventData(eventData) {
        try {
            logger.info(`🔍 PARSING BUY EVENT (${eventData.length} bytes)`);
            
            let offset = 8; // Skip discriminator
            
            // Parse according to IDL structure
            const timestamp = eventData.readBigInt64LE(offset); offset += 8;
            const baseAmountOut = eventData.readBigUInt64LE(offset); offset += 8;
            const maxQuoteAmountIn = eventData.readBigUInt64LE(offset); offset += 8;
            
            // Skip user reserves
            const userBaseTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
            const userQuoteTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
            
            // Skip pool reserves
            const poolBaseTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
            const poolQuoteTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
            
            const quoteAmountIn = eventData.readBigUInt64LE(offset); offset += 8;
            const lpFeeBasisPoints = eventData.readBigUInt64LE(offset); offset += 8;
            const lpFee = eventData.readBigUInt64LE(offset); offset += 8;
            const protocolFeeBasisPoints = eventData.readBigUInt64LE(offset); offset += 8;
            const protocolFee = eventData.readBigUInt64LE(offset); offset += 8;
            const quoteAmountInWithLpFee = eventData.readBigUInt64LE(offset); offset += 8;
            const userQuoteAmountIn = eventData.readBigUInt64LE(offset); offset += 8;
    
            logger.info(`🎯 BUY EVENT PARSED:`);
            logger.info(`   🪙 Tokens Received: ${Number(baseAmountOut) / 1e6}`);
            logger.info(`   💰 SOL Spent: ${Number(userQuoteAmountIn) / 1e9}`);
            logger.info(`   💵 LP Fee: ${Number(lpFee) / 1e9} SOL`);
            logger.info(`   🏛️ Protocol Fee: ${Number(protocolFee) / 1e9} SOL`);
            logger.info(`   📈 Price: ${(Number(userQuoteAmountIn) / Number(baseAmountOut) * 1e3).toFixed(6)} SOL per 1000 tokens`);
    
            return {
                eventType: 'buy',
                exactTokensReceived: Number(baseAmountOut) / 1e6,
                exactSolSpent: Number(userQuoteAmountIn) / 1e9,
                totalSolWithFees: Number(quoteAmountIn) / 1e9,
                maxSolRequested: Number(maxQuoteAmountIn) / 1e9,
                lpFee: Number(lpFee) / 1e9,
                protocolFee: Number(protocolFee) / 1e9,
                timestamp: Number(timestamp),
                success: true,
                method: 'direct_event_parsing'
            };
    
        } catch (error) {
            logger.error('💥 Error parsing BuyEvent:', error.message);
            return null;
        }
    }
    
    // 🔥 ENHANCED: Parse SellEvent with detailed logging
    parseSellEventData(eventData) {
        try {
            logger.info(`🔍 PARSING SELL EVENT (${eventData.length} bytes)`);
            
            let offset = 8; // Skip discriminator
            
            // Parse according to IDL structure
            const timestamp = eventData.readBigInt64LE(offset); offset += 8;
            const baseAmountIn = eventData.readBigUInt64LE(offset); offset += 8;
            const minQuoteAmountOut = eventData.readBigUInt64LE(offset); offset += 8;
            
            // Skip user reserves
            const userBaseTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
            const userQuoteTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
            
            // Skip pool reserves
            const poolBaseTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
            const poolQuoteTokenReserves = eventData.readBigUInt64LE(offset); offset += 8;
            
            const quoteAmountOut = eventData.readBigUInt64LE(offset); offset += 8;
            const lpFeeBasisPoints = eventData.readBigUInt64LE(offset); offset += 8;
            const lpFee = eventData.readBigUInt64LE(offset); offset += 8;
            const protocolFeeBasisPoints = eventData.readBigUInt64LE(offset); offset += 8;
            const protocolFee = eventData.readBigUInt64LE(offset); offset += 8;
            const quoteAmountOutWithoutLpFee = eventData.readBigUInt64LE(offset); offset += 8;
            const userQuoteAmountOut = eventData.readBigUInt64LE(offset); offset += 8;
    
            logger.info(`🎯 SELL EVENT PARSED:`);
            logger.info(`   🪙 Tokens Sold: ${Number(baseAmountIn) / 1e6}`);
            logger.info(`   💰 SOL Received: ${Number(userQuoteAmountOut) / 1e9}`);
            logger.info(`   💵 LP Fee: ${Number(lpFee) / 1e9} SOL`);
            logger.info(`   🏛️ Protocol Fee: ${Number(protocolFee) / 1e9} SOL`);
            logger.info(`   📈 Price: ${(Number(userQuoteAmountOut) / Number(baseAmountIn) * 1e3).toFixed(6)} SOL per 1000 tokens`);
    
            return {
                eventType: 'sell',
                exactTokensSold: Number(baseAmountIn) / 1e6,
                exactSolReceived: Number(userQuoteAmountOut) / 1e9,
                totalSolBeforeFees: Number(quoteAmountOut) / 1e9,
                minSolExpected: Number(minQuoteAmountOut) / 1e9,
                lpFee: Number(lpFee) / 1e9,
                protocolFee: Number(protocolFee) / 1e9,
                timestamp: Number(timestamp),
                success: true,
                method: 'direct_event_parsing'
            };
    
        } catch (error) {
            logger.error('💥 Error parsing SellEvent:', error.message);
            return null;
        }
    }
    
    // 🔥 NEW: Get the last parsed trade data
    getLastTradeData() {
        return this.lastTradeData || null;
    }
    
    // 🔥 NEW: Check if we have exact amounts from last trade
    hasExactAmounts() {
        return this.lastTradeData && this.lastTradeData.method === 'direct_event_parsing';
    }

    async getTokenBalance(tokenMint) {
        try {
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