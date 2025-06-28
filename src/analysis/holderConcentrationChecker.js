// src/analysis/holderConcentrationChecker.js - Simplified using getTokenLargestAccounts
const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');
const BigNumber = require('bignumber.js');

class HolderConcentrationChecker {
    constructor() {
        this.connection = new Connection(
            process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        // Configuration
        this.CONCENTRATION_THRESHOLD = 70; // Don't trade if top holders have >70%
        this.TIMEOUT_MS = 1000; // 1 second timeout
        this.MAX_RETRIES = 2; // 2 retries only
    }

    /**
     * Check if token has safe holder concentration for trading
     * @param {string} tokenAddress - Token mint address
     * @returns {Promise<{safe: boolean, concentration: number, reason?: string}>}
     */
    async checkConcentration(tokenAddress) {
        const startTime = Date.now();
        
        for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
            try {
                logger.info(`🔍 Checking holder concentration for ${tokenAddress} (attempt ${attempt + 1}/${this.MAX_RETRIES + 1})`);
                
                // Get top 20 holders using standard Solana RPC with timeout
                const holders = await this.getTopHoldersWithTimeout(tokenAddress);
                
                if (!holders || holders.length === 0) {
                    logger.warn(`⚠️ No holders found for ${tokenAddress}`);
                    return {
                        safe: false,
                        concentration: 100,
                        reason: 'No holder data available - considered invalid'
                    };
                }

                // Calculate concentration (assumes 1B pump.fun supply)
                const concentration = this.calculateConcentration(holders);
                const safe = concentration < this.CONCENTRATION_THRESHOLD;
                const duration = Date.now() - startTime;
                
                logger.info(`📊 Concentration: ${concentration.toFixed(1)}% in ${duration}ms (${safe ? 'SAFE' : 'RISKY'})`);
                
                return {
                    safe,
                    concentration,
                    holderCount: holders.length,
                    duration,
                    ...(safe ? {} : { reason: `Top holders control ${concentration.toFixed(1)}% of supply` })
                };

            } catch (error) {
                const duration = Date.now() - startTime;
                
                if (attempt < this.MAX_RETRIES) {
                    logger.warn(`⚠️ Holder check attempt ${attempt + 1} failed: ${error.message} - retrying`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                } else {
                    logger.warn(`⚠️ All holder check attempts failed for ${tokenAddress} after ${duration}ms - skipping`);
                    return {
                        safe: false,
                        concentration: 100,
                        duration,
                        reason: 'Holder check failed - token considered invalid'
                    };
                }
            }
        }
    }

    /**
     * Get top holders with timeout
     * @param {string} tokenAddress 
     * @returns {Promise<Array>}
     */
    async getTopHoldersWithTimeout(tokenAddress) {
        return Promise.race([
            this.getTokenLargestAccounts(tokenAddress),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`Timeout after ${this.TIMEOUT_MS}ms`)), this.TIMEOUT_MS)
            )
        ]);
    }

    /**
     * Get top 20 token holders using standard Solana RPC
     * @param {string} tokenAddress 
     * @returns {Promise<Array>}
     */
    async getTokenLargestAccounts(tokenAddress) {
        const mintPubkey = new PublicKey(tokenAddress);
        const response = await this.connection.getTokenLargestAccounts(mintPubkey);
        
        if (!response.value || response.value.length === 0) {
            throw new Error('No token accounts found');
        }

        // Convert to our format
        const holders = response.value.map(account => ({
            address: account.address.toString(),
            balance: account.amount,
            decimals: account.decimals
        }));

        logger.debug(`📊 Found ${holders.length} largest holders`);
        return holders;
    }

    /**
     * Calculate concentration percentage for pump.fun tokens (1B supply)
     * @param {Array} holders - Top 20 holders from getTokenLargestAccounts
     * @returns {number}
     */
    calculateConcentration(holders) {
        if (!holders || holders.length === 0) {
            return 100;
        }

        // Pump.fun tokens: 1 billion supply with 6 decimals
        const PUMP_FUN_TOTAL_SUPPLY = new BigNumber('1000000000000000');

        // Sum up all top holders (usually top 20)
        const topHolderSupply = holders.reduce((sum, holder) => {
            return sum.plus(new BigNumber(holder.balance || '0'));
        }, new BigNumber(0));

        if (topHolderSupply.eq(0)) {
            return 100;
        }

        // Calculate percentage of 1B supply held by top holders
        const concentration = topHolderSupply.dividedBy(PUMP_FUN_TOTAL_SUPPLY).multipliedBy(100);
        
        // Add penalty for having very few holders
        const holderPenalty = holders.length < 5 ? (5 - holders.length) * 10 : 0;
        
        return Math.min(100, concentration.toNumber() + holderPenalty);
    }

    /**
     * Quick concentration check - returns boolean
     * @param {string} tokenAddress 
     * @returns {Promise<boolean>}
     */
    async isSafeToTrade(tokenAddress) {
        const result = await this.checkConcentration(tokenAddress);
        return result.safe;
    }

    /**
     * Set custom concentration threshold
     * @param {number} threshold - Percentage threshold (0-100)
     */
    setConcentrationThreshold(threshold) {
        if (threshold >= 0 && threshold <= 100) {
            this.CONCENTRATION_THRESHOLD = threshold;
            logger.info(`📊 Concentration threshold updated to ${threshold}%`);
        }
    }

    /**
     * Get current configuration
     * @returns {Object}
     */
    getConfig() {
        return {
            concentrationThreshold: this.CONCENTRATION_THRESHOLD,
            timeoutMs: this.TIMEOUT_MS,
            maxRetries: this.MAX_RETRIES
        };
    }
}

module.exports = HolderConcentrationChecker;