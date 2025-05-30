// src/bot/riskManager.js - Risk Management System
const EventEmitter = require('events');
const logger = require('../utils/logger');

class RiskManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            maxConcurrentPositions: config.maxConcurrentPositions || 5,
            maxDailyLosses: config.maxDailyLosses || 1.0, // SOL
            maxSinglePositionSize: config.maxSinglePositionSize || 0.5, // SOL
            blacklistBundleDetected: config.blacklistBundleDetected !== false,
            blacklistHighRisk: config.blacklistHighRisk !== false,
            minLiquidity: config.minLiquidity || 10, // SOL
            maxPositionAge: config.maxPositionAge || 24 * 60 * 60 * 1000, // 24 hours
            emergencyStopLoss: config.emergencyStopLoss || 80, // 80% loss triggers emergency stop
            ...config
        };

        // Risk tracking
        this.dailyStats = {
            date: new Date().toDateString(),
            totalLosses: 0,
            totalTrades: 0,
            rejectedAlerts: 0,
            emergencyStops: 0
        };

        this.blacklistedTokens = new Set();
        this.emergencyMode = false;
        this.lastRiskCheck = Date.now();

        // Auto-reset daily stats
        this.startDailyReset();
        
        logger.info('🛡️ Risk Manager initialized');
        this.logRiskConfig();
    }

    logRiskConfig() {
        logger.info('📋 Risk Management Configuration:');
        logger.info(`   • Max Concurrent Positions: ${this.config.maxConcurrentPositions}`);
        logger.info(`   • Max Daily Losses: ${this.config.maxDailyLosses} SOL`);
        logger.info(`   • Max Single Position: ${this.config.maxSinglePositionSize} SOL`);
        logger.info(`   • Blacklist Bundle Detected: ${this.config.blacklistBundleDetected}`);
        logger.info(`   • Blacklist High Risk: ${this.config.blacklistHighRisk}`);
        logger.info(`   • Emergency Stop Loss: ${this.config.emergencyStopLoss}%`);
    }

    async checkAlert(alert) {
        try {
            this.lastRiskCheck = Date.now();
            
            logger.debug(`🛡️ Risk checking: ${alert.token.symbol}`);

            // Emergency mode check
            if (this.emergencyMode) {
                return {
                    approved: false,
                    reason: 'Emergency mode active - all trading suspended',
                    riskLevel: 'CRITICAL'
                };
            }

            // Daily loss limit check
            const dailyLossCheck = this.checkDailyLossLimit();
            if (!dailyLossCheck.approved) {
                return dailyLossCheck;
            }

            // Position count limit check
            const positionLimitCheck = this.checkPositionLimit();
            if (!positionLimitCheck.approved) {
                return positionLimitCheck;
            }

            // Token blacklist check
            const blacklistCheck = this.checkTokenBlacklist(alert.token.address);
            if (!blacklistCheck.approved) {
                return blacklistCheck;
            }

            // Analysis-based risk checks
            const analysisCheck = this.checkAnalysisRisk(alert.analysis);
            if (!analysisCheck.approved) {
                return analysisCheck;
            }

            // Twitter engagement risk check
            const engagementCheck = this.checkEngagementRisk(alert.twitter);
            if (!engagementCheck.approved) {
                return engagementCheck;
            }

            // Position size check (based on confidence)
            const positionSizeCheck = this.checkPositionSize(alert);
            if (!positionSizeCheck.approved) {
                return positionSizeCheck;
            }

            // Calculate overall risk score
            const riskScore = this.calculateRiskScore(alert);
            
            // Final approval
            const approved = riskScore.score >= this.getRiskThreshold(alert.confidence);
            
            if (approved) {
                this.dailyStats.totalTrades++;
                logger.info(`✅ Risk check passed: ${alert.token.symbol} (Score: ${riskScore.score}/100)`);
            } else {
                this.dailyStats.rejectedAlerts++;
                logger.info(`❌ Risk check failed: ${alert.token.symbol} (Score: ${riskScore.score}/100, Threshold: ${this.getRiskThreshold(alert.confidence)})`);
            }

            return {
                approved,
                reason: approved ? 'Risk check passed' : `Risk score too low: ${riskScore.score}/100`,
                riskLevel: riskScore.level,
                riskScore: riskScore.score,
                factors: riskScore.factors
            };

        } catch (error) {
            logger.error('Error in risk check:', error);
            return {
                approved: false,
                reason: 'Risk check error: ' + error.message,
                riskLevel: 'ERROR'
            };
        }
    }

    checkDailyLossLimit() {
        if (this.dailyStats.totalLosses >= this.config.maxDailyLosses) {
            logger.warn(`🚨 Daily loss limit reached: ${this.dailyStats.totalLosses}/${this.config.maxDailyLosses} SOL`);
            return {
                approved: false,
                reason: `Daily loss limit exceeded: ${this.dailyStats.totalLosses.toFixed(4)}/${this.config.maxDailyLosses} SOL`,
                riskLevel: 'HIGH'
            };
        }
        return { approved: true };
    }

    checkPositionLimit() {
        // This would be checked against actual position manager
        // For now, we'll assume it's injected or available
        const currentPositions = this.getCurrentPositionCount();
        
        if (currentPositions >= this.config.maxConcurrentPositions) {
            return {
                approved: false,
                reason: `Maximum concurrent positions reached: ${currentPositions}/${this.config.maxConcurrentPositions}`,
                riskLevel: 'MEDIUM'
            };
        }
        return { approved: true };
    }

    checkTokenBlacklist(tokenAddress) {
        if (this.blacklistedTokens.has(tokenAddress)) {
            return {
                approved: false,
                reason: 'Token is blacklisted',
                riskLevel: 'HIGH'
            };
        }
        return { approved: true };
    }

    checkAnalysisRisk(analysis) {
        // Bundle detection check
        if (this.config.blacklistBundleDetected && analysis.bundleDetected) {
            return {
                approved: false,
                reason: 'Bundle activity detected and blacklisted',
                riskLevel: 'HIGH'
            };
        }

        // High risk analysis check
        if (this.config.blacklistHighRisk && analysis.riskLevel === 'HIGH') {
            return {
                approved: false,
                reason: 'High risk analysis result',
                riskLevel: 'HIGH'
            };
        }

        // Extreme concentration check
        if (analysis.bundlePercentage > 70) {
            return {
                approved: false,
                reason: `Extreme bundle concentration: ${analysis.bundlePercentage}%`,
                riskLevel: 'VERY_HIGH'
            };
        }

        return { approved: true };
    }

    checkEngagementRisk(twitter) {
        // Suspicious engagement patterns
        if (twitter.likes > 0 && twitter.views > 0) {
            const engagementRatio = twitter.likes / twitter.views;
            
            // Unusually high engagement ratio (potential bot activity)
            if (engagementRatio > 0.1) { // 10% engagement rate is very high
                logger.warn(`⚠️ Suspicious engagement ratio: ${(engagementRatio * 100).toFixed(2)}%`);
                return {
                    approved: false,
                    reason: `Suspicious engagement ratio: ${(engagementRatio * 100).toFixed(2)}%`,
                    riskLevel: 'MEDIUM'
                };
            }
        }

        return { approved: true };
    }

    checkPositionSize(alert) {
        // Calculate intended position size
        const baseSize = parseFloat(process.env.INITIAL_INVESTMENT_SOL) || 0.1;
        let intendedSize = baseSize;

        // Adjust for confidence
        switch (alert.confidence) {
            case 'HIGH': intendedSize *= 1.5; break;
            case 'MEDIUM': intendedSize *= 1.0; break;
            case 'LOW': intendedSize *= 0.7; break;
            case 'VERY_LOW': intendedSize *= 0.5; break;
        }

        if (intendedSize > this.config.maxSinglePositionSize) {
            return {
                approved: false,
                reason: `Position size too large: ${intendedSize.toFixed(4)}/${this.config.maxSinglePositionSize} SOL`,
                riskLevel: 'MEDIUM'
            };
        }

        return { approved: true };
    }

    calculateRiskScore(alert) {
        let score = 50; // Base score
        const factors = [];

        // Twitter engagement scoring
        if (alert.twitter.likes >= 1000) {
            score += 15;
            factors.push('High Twitter likes (+15)');
        } else if (alert.twitter.likes >= 500) {
            score += 10;
            factors.push('Good Twitter likes (+10)');
        } else if (alert.twitter.likes >= 200) {
            score += 5;
            factors.push('Moderate Twitter likes (+5)');
        }

        if (alert.twitter.views >= 1000000) {
            score += 15;
            factors.push('High Twitter views (+15)');
        } else if (alert.twitter.views >= 500000) {
            score += 10;
            factors.push('Good Twitter views (+10)');
        } else if (alert.twitter.views >= 100000) {
            score += 5;
            factors.push('Moderate Twitter views (+5)');
        }

        // Event type bonus
        if (alert.eventType === 'migration') {
            score += 10;
            factors.push('Migration event (+10)');
        }

        // Risk penalties
        if (alert.analysis.bundleDetected) {
            score -= 20;
            factors.push('Bundle detected (-20)');
        }

        if (alert.analysis.riskLevel === 'HIGH') {
            score -= 15;
            factors.push('High risk analysis (-15)');
        } else if (alert.analysis.riskLevel === 'MEDIUM') {
            score -= 5;
            factors.push('Medium risk analysis (-5)');
        }

        if (alert.analysis.whaleCount > 8) {
            score -= 10;
            factors.push('High whale count (-10)');
        }

        if (alert.analysis.freshWalletCount > 10) {
            score -= 10;
            factors.push('High fresh wallet count (-10)');
        }

        // Confidence bonus
        switch (alert.confidence) {
            case 'HIGH':
                score += 10;
                factors.push('High confidence (+10)');
                break;
            case 'MEDIUM':
                score += 5;
                factors.push('Medium confidence (+5)');
                break;
            case 'LOW':
                score -= 5;
                factors.push('Low confidence (-5)');
                break;
            case 'VERY_LOW':
                score -= 10;
                factors.push('Very low confidence (-10)');
                break;
        }

        // Clamp score between 0 and 100
        score = Math.max(0, Math.min(100, score));

        // Determine risk level
        let level;
        if (score >= 80) level = 'LOW';
        else if (score >= 60) level = 'MEDIUM';
        else if (score >= 40) level = 'HIGH';
        else level = 'VERY_HIGH';

        return { score, level, factors };
    }

    getRiskThreshold(confidence) {
        // Different thresholds based on confidence
        switch (confidence) {
            case 'HIGH': return 60;
            case 'MEDIUM': return 70;
            case 'LOW': return 75;
            case 'VERY_LOW': return 80;
            default: return 75;
        }
    }

    recordLoss(amount) {
        this.dailyStats.totalLosses += amount;
        
        // Check if we should enter emergency mode
        if (this.dailyStats.totalLosses >= this.config.maxDailyLosses * 0.8) {
            logger.warn(`⚠️ Approaching daily loss limit: ${this.dailyStats.totalLosses.toFixed(4)}/${this.config.maxDailyLosses} SOL`);
        }

        if (amount >= this.config.maxSinglePositionSize * (this.config.emergencyStopLoss / 100)) {
            this.triggerEmergencyMode(`Large single loss: ${amount.toFixed(4)} SOL`);
        }
    }

    recordProfit(amount) {
        // Profits reduce daily loss count
        this.dailyStats.totalLosses = Math.max(0, this.dailyStats.totalLosses - amount);
    }

    blacklistToken(tokenAddress, reason = 'Manual blacklist') {
        this.blacklistedTokens.add(tokenAddress);
        logger.warn(`⚫ Token blacklisted: ${tokenAddress} (${reason})`);
        
        this.emit('tokenBlacklisted', { tokenAddress, reason });
    }

    removeFromBlacklist(tokenAddress) {
        this.blacklistedTokens.delete(tokenAddress);
        logger.info(`⚪ Token removed from blacklist: ${tokenAddress}`);
    }

    triggerEmergencyMode(reason) {
        this.emergencyMode = true;
        this.dailyStats.emergencyStops++;
        
        logger.error(`🚨 EMERGENCY MODE ACTIVATED: ${reason}`);
        
        this.emit('emergencyMode', { reason, timestamp: Date.now() });
        
        // Auto-disable emergency mode after 1 hour
        setTimeout(() => {
            this.disableEmergencyMode('Auto-recovery after 1 hour');
        }, 60 * 60 * 1000);
    }

    disableEmergencyMode(reason = 'Manual override') {
        this.emergencyMode = false;
        logger.info(`✅ Emergency mode disabled: ${reason}`);
        
        this.emit('emergencyModeDisabled', { reason, timestamp: Date.now() });
    }

    getCurrentPositionCount() {
        // This would typically be injected from position manager
        // For now, return a mock value
        return 0;
    }

    startDailyReset() {
        // Reset daily stats at midnight
        const msUntilMidnight = this.getMsUntilMidnight();
        
        setTimeout(() => {
            this.resetDailyStats();
            
            // Set up daily interval
            setInterval(() => {
                this.resetDailyStats();
            }, 24 * 60 * 60 * 1000);
            
        }, msUntilMidnight);
    }

    getMsUntilMidnight() {
        const now = new Date();
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        return midnight.getTime() - now.getTime();
    }

    resetDailyStats() {
        const oldStats = { ...this.dailyStats };
        
        this.dailyStats = {
            date: new Date().toDateString(),
            totalLosses: 0,
            totalTrades: 0,
            rejectedAlerts: 0,
            emergencyStops: 0
        };
        
        logger.info(`📊 Daily stats reset. Previous day: ${oldStats.totalTrades} trades, ${oldStats.totalLosses.toFixed(4)} SOL losses, ${oldStats.rejectedAlerts} rejections`);
    }

    getStats() {
        return {
            emergencyMode: this.emergencyMode,
            dailyStats: this.dailyStats,
            blacklistedTokens: this.blacklistedTokens.size,
            lastRiskCheck: new Date(this.lastRiskCheck).toISOString(),
            config: {
                maxConcurrentPositions: this.config.maxConcurrentPositions,
                maxDailyLosses: this.config.maxDailyLosses,
                maxSinglePositionSize: this.config.maxSinglePositionSize,
                emergencyStopLoss: this.config.emergencyStopLoss
            }
        };
    }

    getRiskSummary() {
        const lossPct = (this.dailyStats.totalLosses / this.config.maxDailyLosses * 100).toFixed(1);
        const rejectionRate = this.dailyStats.totalTrades > 0 ? 
            (this.dailyStats.rejectedAlerts / (this.dailyStats.totalTrades + this.dailyStats.rejectedAlerts) * 100).toFixed(1) : '0';
        
        return {
            status: this.emergencyMode ? '🚨 EMERGENCY' : '✅ ACTIVE',
            dailyLossUsage: `${lossPct}% (${this.dailyStats.totalLosses.toFixed(4)}/${this.config.maxDailyLosses} SOL)`,
            rejectionRate: `${rejectionRate}% (${this.dailyStats.rejectedAlerts} rejected)`,
            blacklistedTokens: this.blacklistedTokens.size,
            emergencyStops: this.dailyStats.emergencyStops
        };
    }

    // Manual controls
    setMaxDailyLosses(amount) {
        this.config.maxDailyLosses = amount;
        logger.info(`📊 Max daily losses updated: ${amount} SOL`);
    }

    setMaxConcurrentPositions(count) {
        this.config.maxConcurrentPositions = count;
        logger.info(`📊 Max concurrent positions updated: ${count}`);
    }

    enableBlacklistBundleDetected() {
        this.config.blacklistBundleDetected = true;
        logger.info('🛡️ Bundle detection blacklist enabled');
    }

    disableBlacklistBundleDetected() {
        this.config.blacklistBundleDetected = false;
        logger.info('🛡️ Bundle detection blacklist disabled');
    }
}

module.exports = RiskManager;