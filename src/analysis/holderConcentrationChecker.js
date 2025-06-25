// src/analysis/holderConcentrationChecker.js - Simplified holder concentration checker
const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');
const BigNumber = require('bignumber.js');

class HolderConcentrationChecker {
    constructor() {
        this.connection = new Connection(
            process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        // Configuration for concentration limits
        this.CONCENTRATION_THRESHOLD = 70; // Don't trade if top holders have >70%
        this.TOP_HOLDERS_COUNT = 20; // Check top 20 holders
        this.TIMEOUT_MS = 3000; // 3 second timeout (faster)
        this.RETRY_DELAY_MS = 500; // 0.5 second retry delay
        this.MAX_RETRIES = 1; // Only 1 retry for speed
    }

    /**
     * Check if token has safe holder concentration for trading
     * @param {string} tokenAddress - Token mint address
     * @returns {Promise<{safe: boolean, concentration: number, reason?: string}>}
     */
    async checkConcentration(tokenAddress) {
        const startTime = Date.now();
        let attempt = 0;
        
        while (attempt <= this.MAX_RETRIES) {
            try {
                logger.info(`🔍 Checking holder concentration for ${tokenAddress} (attempt ${attempt + 1}/${this.MAX_RETRIES + 1})`);
                
                // Get top holders using Helius with timeout
                const holders = await this.getTopHoldersWithTimeout(tokenAddress);
                
                if (!holders || holders.length === 0) {
                    logger.warn(`⚠️ No holders found for ${tokenAddress}`);
                    return {
                        safe: false,
                        concentration: 100,
                        reason: 'No holder data available - considered invalid'
                    };
                }

                // Calculate concentration
                const concentration = this.calculateConcentration(holders);
                const safe = concentration < this.CONCENTRATION_THRESHOLD;
                const duration = Date.now() - startTime;
                
                logger.info(`📊 Concentration check result: ${concentration.toFixed(2)}% in ${duration}ms (${safe ? 'SAFE' : 'RISKY'})`);
                
                return {
                    safe,
                    concentration,
                    holderCount: holders.length,
                    duration,
                    ...(safe ? {} : { reason: `Top holders control ${concentration.toFixed(1)}% of supply` })
                };

            } catch (error) {
                attempt++;
                const duration = Date.now() - startTime;
                
                if (attempt <= this.MAX_RETRIES) {
                    logger.warn(`⚠️ Holder check attempt ${attempt} failed for ${tokenAddress}: ${error.message} - retrying in ${this.RETRY_DELAY_MS}ms`);
                    await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS));
                } else {
                    logger.error(`❌ All holder check attempts failed for ${tokenAddress} after ${duration}ms: ${error.message}`);
                    return {
                        safe: false,
                        concentration: 100,
                        duration,
                        reason: `Check failed after ${this.MAX_RETRIES + 1} attempts - token considered invalid`
                    };
                }
            }
        }
    }

    /**
     * Get top holders with timeout wrapper
     * @param {string} tokenAddress 
     * @returns {Promise<Array>}
     */
    async getTopHoldersWithTimeout(tokenAddress) {
        return Promise.race([
            this.getTopHolders(tokenAddress),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`Timeout after ${this.TIMEOUT_MS}ms`)), this.TIMEOUT_MS)
            )
        ]);
    }

    /**
     * Get top token holders using Helius API
     * @param {string} tokenAddress 
     * @returns {Promise<Array>}
     */
    async getTopHolders(tokenAddress) {
        try {
            // Try Helius first
            return await this.fetchHoldersFromHelius(tokenAddress);
        } catch (error) {
            logger.warn(`⚠️ Helius request failed: ${error.message} - trying RPC fallback`);
            // Fallback to RPC method
            return await this.getHoldersViaRPC(tokenAddress);
        }
    }

    /**
     * Fetch holders using Helius API
     * @param {string} tokenAddress 
     * @returns {Promise<Array>}
     */
    async fetchHoldersFromHelius(tokenAddress) {
        if (!process.env.HELIUS_RPC_URL) {
            throw new Error('No Helius RPC URL configured');
        }

        const response = await fetch(process.env.HELIUS_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'holder-check',
                method: 'getTokenAccounts',
                params: {
                    mint: tokenAddress,
                    limit: this.TOP_HOLDERS_COUNT,
                    sortBy: 'amount',
                    sortOrder: 'desc'
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Helius API error: ${response.status}`);
        }

        const data = await response.json();
        
        if (data.error) {
            throw new Error(`Helius error: ${data.error.message}`);
        }

        const accounts = data.result?.token_accounts || [];
        logger.debug(`📊 Found ${accounts.length} holders via Helius`);

        return accounts.map(account => ({
            address: account.owner,
            balance: account.amount,
            decimals: account.decimals || 6
        }));
    }

    /**
     * Fallback method using standard RPC
     * @param {string} tokenAddress 
     * @returns {Promise<Array>}
     */
    async getHoldersViaRPC(tokenAddress) {
        try {
            logger.debug(`🔄 Fallback: Getting holders via RPC for ${tokenAddress}`);
            
            const mintPubkey = new PublicKey(tokenAddress);
            const accounts = await this.connection.getProgramAccounts(
                new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // Token Program
                {
                    filters: [
                        { dataSize: 165 }, // Token account size
                        { memcmp: { offset: 0, bytes: mintPubkey.toString() } } // Filter by mint
                    ]
                }
            );

            const holders = accounts
                .map(account => {
                    try {
                        const accountData = AccountLayout.decode(account.account.data);
                        return {
                            address: account.pubkey.toString(),
                            balance: accountData.amount.toString(),
                            decimals: 6 // Default, should get from mint
                        };
                    } catch (error) {
                        return null;
                    }
                })
                .filter(holder => holder && new BigNumber(holder.balance).gt(0))
                .sort((a, b) => new BigNumber(b.balance).minus(new BigNumber(a.balance)).toNumber())
                .slice(0, this.TOP_HOLDERS_COUNT);

            logger.debug(`📊 Found ${holders.length} holders via RPC fallback`);
            return holders;

        } catch (error) {
            logger.error(`❌ RPC fallback failed: ${error.message}`);
            return [];
        }
    }

    /**
     * Calculate concentration percentage of top holders
     * @param {Array} holders 
     * @returns {number}
     */
    calculateConcentration(holders) {
        if (!holders || holders.length === 0) {
            return 100; // Assume worst case
        }

        const totalSupply = holders.reduce((sum, holder) => {
            return sum.plus(new BigNumber(holder.balance));
        }, new BigNumber(0));

        if (totalSupply.eq(0)) {
            return 100;
        }

        // Calculate percentage held by all returned holders
        const concentration = totalSupply.dividedBy(totalSupply).multipliedBy(100);
        
        // If we got fewer holders than requested, it might indicate concentration
        // Add penalty for having too few unique holders
        const holderPenalty = holders.length < 10 ? (10 - holders.length) * 5 : 0;
        
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
        } else {
            logger.warn(`⚠️ Invalid threshold: ${threshold}. Must be 0-100`);
        }
    }

    /**
     * Get current configuration
     * @returns {Object}
     */
    getConfig() {
        return {
            concentrationThreshold: this.CONCENTRATION_THRESHOLD,
            topHoldersCount: this.TOP_HOLDERS_COUNT,
            timeoutMs: this.TIMEOUT_MS
        };
    }
}

module.exports = HolderConcentrationChecker;