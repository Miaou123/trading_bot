// src/services/pumpSwapService.js - REAL PumpSwap trading with buy/sell execution
const { Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } = require('@solana/spl-token');
const BN = require('bn.js');
const logger = require('../utils/logger');
const bs58 = require('bs58');
const anchor = require('@coral-xyz/anchor');

class PumpSwapService {
    constructor(config = {}) {
        this.connection = new Connection(
            config.rpcUrl || process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        this.config = {
            slippageTolerance: config.slippageTolerance || 5,
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
            errors: 0
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
                    secretKey = bs58.decode(privateKey);
                }
            } else {
                secretKey = privateKey;
            }
            
            this.wallet = Keypair.fromSecretKey(secretKey);
            logger.info(`💼 Wallet initialized: ${this.wallet.publicKey.toString()}`);
            
            // Initialize Anchor if IDL is already loaded
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

    // Derive pool address from token mint
    async findPool(tokenMint) {
        try {
            const mintPubkey = new PublicKey(tokenMint);
            logger.info(`🔍 Deriving PumpSwap pool for: ${tokenMint}`);
            
            // Step 1: Derive pool authority from Pump.fun program
            const [poolAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("pool-authority"), mintPubkey.toBytes()],
                this.PUMP_PROGRAM_ID
            );
            
            // Step 2: Derive pool address from PumpSwap program
            const poolIndexBuffer = Buffer.alloc(2);
            poolIndexBuffer.writeUInt16LE(0, 0); // Pool index 0 (canonical)
            
            const [poolPda] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("pool"),
                    poolIndexBuffer,
                    poolAuthority.toBytes(),
                    mintPubkey.toBytes(),          // base mint (token)
                    this.WSOL_MINT.toBytes()       // quote mint (WSOL)
                ],
                this.PUMPSWAP_PROGRAM_ID
            );
            
            logger.info(`✅ Pool derived: ${poolPda.toString()}`);
            this.stats.poolsDerivied++;
            
            // Verify pool exists
            const poolAccountInfo = await this.connection.getAccountInfo(poolPda);
            if (poolAccountInfo) {
                logger.info(`✅ Pool exists on-chain!`);
                this.stats.poolsFound++;
                return poolPda;
            } else {
                logger.warn(`⚠️ Pool derived but doesn't exist on-chain`);
                this.stats.poolsNotFound++;
                return null;
            }
            
        } catch (error) {
            this.stats.errors++;
            logger.error('❌ Error deriving PumpSwap pool:', error.message);
            return null;
        }
    }

    // Get pool coin creator (from your .ts code)
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

    // Get protocol fee recipients (from your .ts code)
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

    // Calculate expected SOL output for sells (from your .ts code)
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

            // AMM constant product formula
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

    // 🚀 REAL BUY EXECUTION - Based on your .ts code patterns
    async executeBuy(tokenMint, solAmount, slippage = null) {
        try {
            if (!this.wallet || !this.program) {
                throw new Error('Wallet or program not initialized for trading');
            }

            logger.info(`🚀 EXECUTING REAL BUY: ${solAmount} SOL → ${tokenMint}`);

            const poolAddress = await this.findPool(tokenMint);
            if (!poolAddress) {
                throw new Error('Pool not found');
            }

            const mintPubkey = new PublicKey(tokenMint);
            const quoteMint = this.WSOL_MINT;

            // Get required accounts
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

            // Calculate amounts
            const quoteAmountIn = new BN(solAmount * 1e9); // Convert SOL to lamports
            const minBaseOut = new BN(0); // Accept any amount for testing

            logger.info(`💰 Buying with ${solAmount} SOL (${quoteAmountIn.toString()} lamports)`);

            // Build transaction instructions
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
                    lamports: quoteAmountIn.toNumber(),
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
                .buy(quoteAmountIn, minBaseOut)
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

            // Send transaction
            const { blockhash } = await this.connection.getLatestBlockhash();
            const message = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: instructions,
            }).compileToV0Message();

            const transaction = new VersionedTransaction(message);
            transaction.sign([this.wallet]);

            logger.info('📤 Sending buy transaction...');
            const signature = await this.connection.sendAndConfirmTransaction(transaction, {
                commitment: 'confirmed',
                maxRetries: 3
            });

            this.stats.buysExecuted++;

            logger.info(`✅ BUY SUCCESS!`);
            logger.info(`   Signature: ${signature}`);
            logger.info(`   Explorer: https://solscan.io/tx/${signature}`);

            return {
                success: true,
                signature: signature,
                solSpent: solAmount,
                type: 'BUY'
            };

        } catch (error) {
            this.stats.errors++;
            logger.error('❌ Buy failed:', error.message);
            throw error;
        }
    }

    // 🚀 REAL SELL EXECUTION - Based on your .ts code patterns
    async executeSell(tokenMint, tokenAmount, slippage = null) {
        try {
            if (!this.wallet || !this.program) {
                throw new Error('Wallet or program not initialized for trading');
            }

            logger.info(`🚀 EXECUTING REAL SELL: ${tokenAmount} tokens → SOL`);

            const poolAddress = await this.findPool(tokenMint);
            if (!poolAddress) {
                throw new Error('Pool not found');
            }

            const mintPubkey = new PublicKey(tokenMint);
            const quoteMint = this.WSOL_MINT;

            // Get required accounts
            const coinCreator = await this.getPoolCoinCreator(poolAddress);
            if (!coinCreator) {
                throw new Error('Coin creator not found');
            }

            const protocolFeeRecipients = await this.getProtocolFeeRecipients();
            if (protocolFeeRecipients.length === 0) {
                throw new Error('No protocol fee recipients found');
            }

            const protocolFeeRecipient = protocolFeeRecipients[0];

            // Calculate amounts
            const baseAmountIn = new BN(tokenAmount * 1e6); // Assuming 6 decimals
            const expectedSolOutput = await this.getExpectedSolOutput(poolAddress, baseAmountIn, mintPubkey);
            const slippageToUse = slippage || this.config.slippageTolerance;
            const slippageFactor = new BN(100 - slippageToUse);
            const minQuoteOut = expectedSolOutput.mul(slippageFactor).div(new BN(100));

            logger.info(`💰 Selling ${tokenAmount} tokens for ~${(parseFloat(expectedSolOutput.toString()) / 1e9).toFixed(6)} SOL`);

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

            // Build transaction instructions
            const instructions = [];

            // Compute budget
            instructions.push(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 })
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

            // Send transaction
            const { blockhash } = await this.connection.getLatestBlockhash();
            const message = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: instructions,
            }).compileToV0Message();

            const transaction = new VersionedTransaction(message);
            transaction.sign([this.wallet]);

            logger.info('📤 Sending sell transaction...');
            const signature = await this.connection.sendAndConfirmTransaction(transaction, {
                commitment: 'confirmed',
                maxRetries: 3
            });

            this.stats.sellsExecuted++;
            const solReceived = parseFloat(expectedSolOutput.toString()) / 1e9;

            logger.info(`✅ SELL SUCCESS!`);
            logger.info(`   Signature: ${signature}`);
            logger.info(`   SOL Received: ~${solReceived.toFixed(6)} SOL`);
            logger.info(`   Explorer: https://solscan.io/tx/${signature}`);

            return {
                success: true,
                signature: signature,
                solReceived: solReceived,
                tokensSpent: tokenAmount,
                type: 'SELL'
            };

        } catch (error) {
            this.stats.errors++;
            logger.error('❌ Sell failed:', error.message);
            throw error;
        }
    }

    // Get current token balance
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

    // Get market data (same as before but cleaner)
    async getMarketData(tokenMint) {
        try {
            logger.info(`📊 Getting market data for: ${tokenMint}`);
            
            const poolAddress = await this.findPool(tokenMint);
            if (!poolAddress) {
                return null;
            }

            // Get pool info and reserves
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

    // Helper methods for market data (simplified versions)
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
                ((this.stats.poolsFound / this.stats.poolsDerivied) * 100).toFixed(1) + '%' : '0%'
        };
    }
}

module.exports = PumpSwapService;