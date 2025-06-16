// src/services/pumpSwapService.js - Complete PumpSwap integration
const { 
    Connection, 
    PublicKey, 
    SystemProgram, 
    TransactionInstruction,
    ComputeBudgetProgram 
} = require('@solana/web3.js');
const { 
    getAssociatedTokenAddressSync, 
    createAssociatedTokenAccountIdempotentInstruction,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getMint
} = require('@solana/spl-token');
const BN = require('bn.js');
const { AnchorProvider, Program, Wallet } = require('@coral-xyz/anchor');
const logger = require('../utils/logger');

class PumpSwapService {
    constructor(connection, wallet, pumpSwapIDL) {
        this.connection = connection;
        this.wallet = wallet;
        this.PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
        this.WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
        
        // Initialize Anchor program
        this.initializeProgram(pumpSwapIDL);
        
        // Cache for expensive lookups
        this.protocolFeeRecipientsCache = null;
        this.globalConfigCache = null;
    }

    initializeProgram(pumpSwapIDL) {
        try {
            const provider = new AnchorProvider(
                this.connection,
                new Wallet(this.wallet),
                { commitment: "confirmed" }
            );
            
            this.program = new Program(pumpSwapIDL, provider);
            logger.debug('✅ PumpSwap Anchor program initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize PumpSwap program:', error);
            throw error;
        }
    }

    // 🔍 POOL DISCOVERY
    async findPool(tokenMint) {
        try {
            const bs58 = require('bs58');
            const pools = await this.connection.getProgramAccounts(this.PUMPSWAP_PROGRAM_ID, {
                filters: [
                    {
                        memcmp: {
                            offset: 0,
                            bytes: bs58.encode(Buffer.from([241, 154, 109, 4, 17, 177, 109, 188])) // Pool discriminator
                        }
                    },
                    {
                        memcmp: {
                            offset: 1 + 2 + 32, // Skip pool_bump + index + creator
                            bytes: tokenMint.toBase58()
                        }
                    }
                ]
            });

            if (pools.length === 0) {
                logger.debug(`❌ No PumpSwap pool found for ${tokenMint.toBase58()}`);
                return null;
            }

            const poolAddress = pools[0].pubkey;
            logger.debug(`✅ PumpSwap pool found: ${poolAddress.toBase58()}`);
            return poolAddress;

        } catch (error) {
            logger.error("Error finding PumpSwap pool:", error);
            return null;
        }
    }

    // 📊 POOL DATA & PRICING
    async getPoolReserves(poolAddress, tokenMint) {
        try {
            const poolBaseTokenAccount = getAssociatedTokenAddressSync(tokenMint, poolAddress, true);
            const poolQuoteTokenAccount = getAssociatedTokenAddressSync(this.WSOL_MINT, poolAddress, true);

            const [baseReserveInfo, quoteReserveInfo, baseMintInfo] = await Promise.all([
                this.connection.getTokenAccountBalance(poolBaseTokenAccount),
                this.connection.getTokenAccountBalance(poolQuoteTokenAccount),
                getMint(this.connection, tokenMint)
            ]);

            return {
                baseReserve: new BN(baseReserveInfo.value.amount),
                quoteReserve: new BN(quoteReserveInfo.value.amount),
                baseDecimals: baseMintInfo.decimals,
                quoteDecimals: 9, // SOL always 9 decimals
                poolBaseTokenAccount,
                poolQuoteTokenAccount
            };
        } catch (error) {
            logger.error("Error getting pool reserves:", error);
            return null;
        }
    }

    async getTokenPrice(tokenMint, poolAddress = null) {
        try {
            // Find pool if not provided
            if (!poolAddress) {
                poolAddress = await this.findPool(tokenMint);
                if (!poolAddress) return null;
            }

            const reserves = await this.getPoolReserves(poolAddress, tokenMint);
            if (!reserves) return null;

            const { baseReserve, quoteReserve, baseDecimals } = reserves;
            
            // Calculate price accounting for decimals
            // price = (quoteReserve / 10^9) / (baseReserve / 10^baseDecimals)
            const price = quoteReserve
                .mul(new BN(10).pow(new BN(baseDecimals)))
                .div(baseReserve)
                .div(new BN(10).pow(new BN(9)));

            const priceFloat = parseFloat(price.toString()) / Math.pow(10, baseDecimals);

            return {
                price: priceFloat,
                poolAddress: poolAddress.toString(),
                baseReserve: baseReserve,
                quoteReserve: quoteReserve,
                source: 'pumpswap_pool'
            };

        } catch (error) {
            logger.error("Error getting token price:", error);
            return null;
        }
    }

    // 💰 PRICE CALCULATIONS
    async calculateBuyPrice(poolAddress, tokenMint, tokenAmountOut) {
        const reserves = await this.getPoolReserves(poolAddress, tokenMint);
        if (!reserves) return null;

        const { baseReserve, quoteReserve } = reserves;
        
        // AMM formula: k = x * y (constant product)
        // After buy: (x + dx) * (y - dy) = k
        const k = baseReserve.mul(quoteReserve);
        const newBaseReserve = baseReserve.add(new BN(tokenAmountOut));
        const newQuoteReserve = k.div(newBaseReserve);
        const solNeeded = quoteReserve.sub(newQuoteReserve);

        return {
            solNeeded: solNeeded,
            pricePerToken: solNeeded.div(new BN(tokenAmountOut)),
            slippageImpact: solNeeded.mul(new BN(10000)).div(quoteReserve), // basis points
            newBaseReserve,
            newQuoteReserve
        };
    }

    async calculateSellPrice(poolAddress, tokenMint, tokenAmountIn) {
        const reserves = await this.getPoolReserves(poolAddress, tokenMint);
        if (!reserves) return null;

        const { baseReserve, quoteReserve } = reserves;
        
        // AMM formula for selling tokens
        const k = baseReserve.mul(quoteReserve);
        const newBaseReserve = baseReserve.sub(new BN(tokenAmountIn));
        const newQuoteReserve = k.div(newBaseReserve);
        const solReceived = newQuoteReserve.sub(quoteReserve);

        return {
            solReceived: solReceived,
            pricePerToken: solReceived.div(new BN(tokenAmountIn)),
            slippageImpact: solReceived.mul(new BN(10000)).div(quoteReserve),
            newBaseReserve,
            newQuoteReserve
        };
    }

    // 🏗️ ACCOUNT GENERATION
    async generateAccounts(poolAddress, tokenMint, userPublicKey) {
        try {
            // Get required data
            const [coinCreator, protocolFeeRecipients] = await Promise.all([
                this.getPoolCoinCreator(poolAddress),
                this.getProtocolFeeRecipients()
            ]);

            if (!coinCreator) {
                throw new Error("Could not get coin creator from pool");
            }
            if (protocolFeeRecipients.length === 0) {
                throw new Error("No protocol fee recipients found");
            }

            // Generate PDAs
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

            const coinCreatorVaultAta = getAssociatedTokenAddressSync(
                this.WSOL_MINT, 
                coinCreatorVaultAuthority, 
                true
            );

            const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(
                this.WSOL_MINT, 
                protocolFeeRecipients[0]
            );

            return {
                pool: poolAddress,
                user: userPublicKey,
                globalConfig,
                baseMint: tokenMint,
                quoteMint: this.WSOL_MINT,
                userBaseTokenAccount: getAssociatedTokenAddressSync(tokenMint, userPublicKey),
                userQuoteTokenAccount: getAssociatedTokenAddressSync(this.WSOL_MINT, userPublicKey),
                poolBaseTokenAccount: getAssociatedTokenAddressSync(tokenMint, poolAddress, true),
                poolQuoteTokenAccount: getAssociatedTokenAddressSync(this.WSOL_MINT, poolAddress, true),
                protocolFeeRecipient: protocolFeeRecipients[0],
                protocolFeeRecipientTokenAccount,
                baseTokenProgram: TOKEN_PROGRAM_ID,
                quoteTokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                eventAuthority,
                program: this.PUMPSWAP_PROGRAM_ID,
                coinCreatorVaultAta,
                coinCreatorVaultAuthority
            };

        } catch (error) {
            logger.error("Error generating PumpSwap accounts:", error);
            throw error;
        }
    }

    // 🛒 BUY OPERATIONS
    async buildBuyInstructions(tokenMint, tokenAmountOut, maxSolIn, slippagePercent = 1) {
        try {
            const poolAddress = await this.findPool(tokenMint);
            if (!poolAddress) {
                throw new Error("Pool not found for token");
            }

            // Calculate pricing
            const priceInfo = await this.calculateBuyPrice(poolAddress, tokenMint, tokenAmountOut);
            if (!priceInfo) {
                throw new Error("Could not calculate buy price");
            }

            // Apply slippage protection
            const slippageFactor = new BN(100 + slippagePercent);
            const maxQuoteAmountIn = priceInfo.solNeeded.mul(slippageFactor).div(new BN(100));
            const finalMaxSolIn = maxSolIn ? new BN(maxSolIn) : maxQuoteAmountIn;

            // Generate accounts
            const accounts = await this.generateAccounts(poolAddress, tokenMint, this.wallet.publicKey);

            // Build instructions
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
                    accounts.userBaseTokenAccount,
                    this.wallet.publicKey,
                    tokenMint
                ),
                createAssociatedTokenAccountIdempotentInstruction(
                    this.wallet.publicKey,
                    accounts.userQuoteTokenAccount,
                    this.wallet.publicKey,
                    this.WSOL_MINT
                )
            );

            // Buy instruction
            const buyIx = await this.program.methods
                .buy(new BN(tokenAmountOut), finalMaxSolIn)
                .accounts(accounts)
                .instruction();

            instructions.push(buyIx);

            return {
                instructions,
                accounts,
                expectedSolNeeded: priceInfo.solNeeded,
                maxSolIn: finalMaxSolIn,
                pricePerToken: priceInfo.pricePerToken,
                slippageImpact: priceInfo.slippageImpact,
                poolAddress
            };

        } catch (error) {
            logger.error("Error building buy instructions:", error);
            throw error;
        }
    }

    // 💸 SELL OPERATIONS
    async buildSellInstructions(tokenMint, tokenAmountIn, minSolOut, slippagePercent = 1) {
        try {
            const poolAddress = await this.findPool(tokenMint);
            if (!poolAddress) {
                throw new Error("Pool not found for token");
            }

            // Calculate pricing
            const priceInfo = await this.calculateSellPrice(poolAddress, tokenMint, tokenAmountIn);
            if (!priceInfo) {
                throw new Error("Could not calculate sell price");
            }

            // Apply slippage protection
            const slippageFactor = new BN(100 - slippagePercent);
            const minQuoteAmountOut = priceInfo.solReceived.mul(slippageFactor).div(new BN(100));
            const finalMinSolOut = minSolOut ? new BN(minSolOut) : minQuoteAmountOut;

            // Generate accounts
            const accounts = await this.generateAccounts(poolAddress, tokenMint, this.wallet.publicKey);

            // Build instructions
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
                    accounts.userQuoteTokenAccount,
                    this.wallet.publicKey,
                    this.WSOL_MINT
                )
            );

            // Sell instruction
            const sellIx = await this.program.methods
                .sell(new BN(tokenAmountIn), finalMinSolOut)
                .accounts(accounts)
                .instruction();

            instructions.push(sellIx);

            return {
                instructions,
                accounts,
                expectedSolReceived: priceInfo.solReceived,
                minSolOut: finalMinSolOut,
                pricePerToken: priceInfo.pricePerToken,
                slippageImpact: priceInfo.slippageImpact,
                poolAddress
            };

        } catch (error) {
            logger.error("Error building sell instructions:", error);
            throw error;
        }
    }

    // 🔧 HELPER METHODS
    async getPoolCoinCreator(poolAddress) {
        try {
            const poolAccountInfo = await this.connection.getAccountInfo(poolAddress);
            if (!poolAccountInfo) return null;

            // Parse Pool struct to get coin_creator field
            const coinCreatorOffset = 1 + 2 + 32 + 32 + 32 + 32 + 32 + 32 + 8; // 203 bytes
            const coinCreatorBytes = poolAccountInfo.data.slice(coinCreatorOffset, coinCreatorOffset + 32);
            
            return new PublicKey(coinCreatorBytes);
        } catch (error) {
            logger.error("Error getting coin creator:", error);
            return null;
        }
    }

    async getProtocolFeeRecipients() {
        // Use cache if available
        if (this.protocolFeeRecipientsCache) {
            return this.protocolFeeRecipientsCache;
        }

        try {
            const [globalConfig] = PublicKey.findProgramAddressSync(
                [Buffer.from("global_config")],
                this.PUMPSWAP_PROGRAM_ID
            );

            const globalConfigInfo = await this.connection.getAccountInfo(globalConfig);
            if (!globalConfigInfo) return [];

            const data = globalConfigInfo.data;
            const protocolFeeRecipientsOffset = 32 + 8 + 8 + 1; // 49 bytes
            const protocolFeeRecipients = [];
            
            for (let i = 0; i < 8; i++) {
                const recipientOffset = protocolFeeRecipientsOffset + (i * 32);
                const recipientBytes = data.slice(recipientOffset, recipientOffset + 32);
                const recipient = new PublicKey(recipientBytes);
                
                if (!recipient.equals(PublicKey.default)) {
                    protocolFeeRecipients.push(recipient);
                }
            }
            
            // Cache for 5 minutes
            this.protocolFeeRecipientsCache = protocolFeeRecipients;
            setTimeout(() => {
                this.protocolFeeRecipientsCache = null;
            }, 5 * 60 * 1000);
            
            return protocolFeeRecipients;
        } catch (error) {
            logger.error("Error getting protocol fee recipients:", error);
            return [];
        }
    }

    // 📈 CONVENIENCE METHODS
    async getMarketData(tokenMint) {
        try {
            const poolAddress = await this.findPool(tokenMint);
            if (!poolAddress) return null;

            const [priceInfo, reserves] = await Promise.all([
                this.getTokenPrice(tokenMint, poolAddress),
                this.getPoolReserves(poolAddress, tokenMint)
            ]);

            if (!priceInfo || !reserves) return null;

            return {
                price: priceInfo.price,
                poolAddress: poolAddress.toString(),
                liquidity: {
                    tokenReserve: reserves.baseReserve.toString(),
                    solReserve: reserves.quoteReserve.toString(),
                    tokenReserveFormatted: parseFloat(reserves.baseReserve.toString()) / Math.pow(10, reserves.baseDecimals),
                    solReserveFormatted: parseFloat(reserves.quoteReserve.toString()) / 1e9
                },
                decimals: reserves.baseDecimals
            };
        } catch (error) {
            logger.error("Error getting market data:", error);
            return null;
        }
    }

    // 🧹 CLEANUP
    clearCache() {
        this.protocolFeeRecipientsCache = null;
        this.globalConfigCache = null;
    }
}

module.exports = PumpSwapService;