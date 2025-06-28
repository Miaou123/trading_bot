// scripts/getTradingRecap.js - Clean trading bot performance recap with timeframe support
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');

class TradingRecap {
    constructor(timeframe = null) {
        this.positionsFile = './positions.json';
        this.tradesHistoryFile = './trades_history.json';
        this.timeframe = timeframe;
        this.timeframeStart = this.calculateTimeframeStart(timeframe);
    }

    calculateTimeframeStart(timeframe) {
        if (!timeframe) return null;
        
        const now = Date.now();
        const timeframeLower = timeframe.toLowerCase();
        
        // Parse timeframe (e.g., "1h", "6h", "1d", "7d", "30d", "1w", "1m", "1y")
        const match = timeframeLower.match(/^(\d+)([hdwmy])$/);
        if (!match) {
            throw new Error(`Invalid timeframe format: ${timeframe}. Use format like 1h, 6h, 1d, 7d, 30d, 1w, 1m, 1y`);
        }
        
        const [, amount, unit] = match;
        const value = parseInt(amount);
        
        switch (unit) {
            case 'h': // hours
                return now - (value * 60 * 60 * 1000);
            case 'd': // days
                return now - (value * 24 * 60 * 60 * 1000);
            case 'w': // weeks
                return now - (value * 7 * 24 * 60 * 60 * 1000);
            case 'm': // months (approximate)
                return now - (value * 30 * 24 * 60 * 60 * 1000);
            case 'y': // years (approximate)
                return now - (value * 365 * 24 * 60 * 60 * 1000);
            default:
                throw new Error(`Unsupported time unit: ${unit}`);
        }
    }

    formatTimeframe() {
        if (!this.timeframe) return 'All Time';
        
        const timeframeLower = this.timeframe.toLowerCase();
        const match = timeframeLower.match(/^(\d+)([hdwmy])$/);
        if (!match) return this.timeframe;
        
        const [, amount, unit] = match;
        const value = parseInt(amount);
        
        const unitNames = {
            'h': value === 1 ? 'Hour' : 'Hours',
            'd': value === 1 ? 'Day' : 'Days', 
            'w': value === 1 ? 'Week' : 'Weeks',
            'm': value === 1 ? 'Month' : 'Months',
            'y': value === 1 ? 'Year' : 'Years'
        };
        
        return `Last ${value} ${unitNames[unit]}`;
    }

    filterByTimeframe(items, timeProperty = 'entryTime') {
        if (!this.timeframeStart) return items;
        
        return items.filter(item => {
            const timestamp = item[timeProperty] || item.createdAt || item.timestamp;
            return timestamp && timestamp >= this.timeframeStart;
        });
    }

    filterActivePositionsByTimeframe(activePositions) {
        if (!this.timeframeStart) return activePositions;
        
        return activePositions.filter(pos => {
            const entryTime = pos.entryTime || pos.createdAt;
            return entryTime && entryTime >= this.timeframeStart;
        });
    }

    async generateRecap() {
        try {
            const timeframeText = this.formatTimeframe();
            console.log(`📊 TRADING BOT PERFORMANCE RECAP - ${timeframeText}`);
            console.log('=' .repeat(50 + timeframeText.length));
            
            // Load data from both files
            const allActivePositions = await this.loadActivePositions();
            const allTradeHistory = await this.loadTradeHistory();
            
            // Apply timeframe filtering
            const activePositions = this.filterActivePositionsByTimeframe(allActivePositions);
            const tradeHistory = this.filterByTimeframe(allTradeHistory, 'exitTime');
            
            if (activePositions.length === 0 && tradeHistory.length === 0) {
                console.log(`❌ No trading data found for timeframe: ${timeframeText}`);
                console.log(`   Total positions: ${allActivePositions.length} active, ${allTradeHistory.length} completed`);
                return;
            }

            // Show filtering info if timeframe is applied
            if (this.timeframeStart) {
                console.log(`\n🕐 TIMEFRAME FILTER: ${timeframeText}`);
                console.log(`   From: ${new Date(this.timeframeStart).toLocaleString()}`);
                console.log(`   Filtered: ${activePositions.length}/${allActivePositions.length} active, ${tradeHistory.length}/${allTradeHistory.length} completed`);
            }

            // Generate comprehensive recap
            this.showOverallStats(activePositions, tradeHistory);
            this.showActivePositions(activePositions);
            this.showCompletedTrades(tradeHistory);
            this.showTimeAnalysis(tradeHistory);
            this.showRecommendations(activePositions, tradeHistory);

        } catch (error) {
            console.error('❌ Error generating recap:', error.message);
        }
    }

    async loadActivePositions() {
        try {
            const data = await fs.readFile(path.resolve(this.positionsFile), 'utf8');
            const positions = JSON.parse(data);
            return Object.values(positions.active || {});
        } catch (error) {
            if (error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }

    async loadTradeHistory() {
        try {
            const data = await fs.readFile(path.resolve(this.tradesHistoryFile), 'utf8');
            const history = JSON.parse(data);
            return history.trades || [];
        } catch (error) {
            if (error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }

    showOverallStats(activePositions, completedTrades) {
        const totalActiveInvestment = activePositions.reduce((sum, pos) => sum + pos.investedAmount, 0);
        const totalCompletedInvestment = completedTrades.reduce((sum, trade) => sum + trade.investedAmount, 0);
        const totalInvestment = totalActiveInvestment + totalCompletedInvestment;
        
        const totalRealizedPnL = completedTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
        const totalUnrealizedPnL = activePositions.reduce((sum, pos) => sum + (pos.unrealizedPnL || 0), 0);
        const totalPnL = totalRealizedPnL + totalUnrealizedPnL;
        
        const profitableTrades = completedTrades.filter(trade => (trade.pnl || 0) > 0);
        const winRate = completedTrades.length > 0 ? (profitableTrades.length / completedTrades.length * 100) : 0;
        
        console.log('\n💰 OVERALL PERFORMANCE');
        console.log('-'.repeat(30));
        console.log(`📈 Total Trades: ${completedTrades.length} completed`);
        console.log(`🟢 Active Positions: ${activePositions.length}`);
        console.log(`💵 Total Investment: ${totalInvestment.toFixed(6)} SOL ($${(totalInvestment * 200).toFixed(2)})`);
        console.log(`💎 Realized P&L: ${totalRealizedPnL >= 0 ? '+' : ''}${totalRealizedPnL.toFixed(6)} SOL`);
        console.log(`📊 Unrealized P&L: ${totalUnrealizedPnL >= 0 ? '+' : ''}${totalUnrealizedPnL.toFixed(6)} SOL`);
        console.log(`🎯 TOTAL P&L: ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(6)} SOL ($${(totalPnL * 200).toFixed(2)})`);
        console.log(`📈 Win Rate: ${winRate.toFixed(1)}% (${profitableTrades.length}/${completedTrades.length})`);
        console.log(`💹 ROI: ${totalInvestment > 0 ? ((totalPnL / totalInvestment) * 100).toFixed(2) : '0.00'}%`);
    }

    showActivePositions(activePositions) {
        if (activePositions.length === 0) return;
        
        console.log('\n🟢 ACTIVE POSITIONS');
        console.log('-'.repeat(25));
        
        activePositions.forEach((pos, index) => {
            const pnl = pos.unrealizedPnL || 0;
            const pnlPercent = pos.priceChange || 0;
            const duration = this.formatDuration(Date.now() - pos.entryTime);
            const status = pos.status || 'ACTIVE';
            
            console.log(`\n${index + 1}. ${pos.symbol || pos.tokenAddress.slice(0,8)} [${status}]`);
            console.log(`   💰 P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
            console.log(`   ⏱️  Duration: ${duration}`);
            console.log(`   💎 Price: ${pos.entryPrice.toFixed(8)} → ${(pos.currentPrice || pos.entryPrice).toFixed(8)} SOL`);
            console.log(`   🔗 Token: ${pos.tokenAddress.slice(0,8)}...${pos.tokenAddress.slice(-4)}`);
            
            if (pos.status && pos.status.includes('FAILED')) {
                console.log(`   ⚠️  Error: ${pos.errorMessage?.split('\n')[0] || 'Execution failed'}`);
            }
        });
    }

    showCompletedTrades(completedTrades) {
        if (completedTrades.length === 0) return;
        
        console.log('\n🔴 COMPLETED TRADES');
        console.log('-'.repeat(25));
        
        // Show most recent first
        const recentTrades = completedTrades
            .sort((a, b) => b.exitTime - a.exitTime)
            .slice(0, 10); // Show last 10 trades
        
        recentTrades.forEach((trade, index) => {
            const pnl = trade.pnl || 0;
            const pnlPercent = trade.pnlPercentage || 0;
            const duration = this.formatDuration(trade.duration || 0);
            const reason = trade.exitReason || 'Unknown';
            
            console.log(`\n${index + 1}. ${trade.symbol || trade.tokenAddress.slice(0,8)}`);
            console.log(`   💰 P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
            console.log(`   ⏱️  Duration: ${duration}`);
            console.log(`   🎯 Exit: ${reason}`);
            console.log(`   🔗 Token: ${trade.tokenAddress.slice(0,8)}...${trade.tokenAddress.slice(-4)}`);
        });
        
        if (completedTrades.length > 10) {
            console.log(`\n... and ${completedTrades.length - 10} more trades in history`);
        }
    }

    showTimeAnalysis(completedTrades) {
        if (completedTrades.length === 0) return;
        
        console.log('\n⏰ TIME ANALYSIS');
        console.log('-'.repeat(18));
        
        // Calculate average hold time
        const avgDuration = completedTrades.reduce((sum, trade) => sum + (trade.duration || 0), 0) / completedTrades.length;
        console.log(`⏱️  Average Hold Time: ${this.formatDuration(avgDuration)}`);
        
        // Trading period
        if (completedTrades.length > 1) {
            const firstTrade = Math.min(...completedTrades.map(t => t.entryTime));
            const lastTrade = Math.max(...completedTrades.map(t => t.exitTime));
            
            console.log(`🕐 First Trade: ${new Date(firstTrade).toLocaleString()}`);
            console.log(`🕐 Last Trade: ${new Date(lastTrade).toLocaleString()}`);
            console.log(`📅 Trading Period: ${this.formatDuration(lastTrade - firstTrade)}`);
        }
    }

    showRecommendations(activePositions, completedTrades) {
        console.log('\n💡 RECOMMENDATIONS');
        console.log('-'.repeat(20));
        
        // Failed positions
        const failedPositions = activePositions.filter(pos => pos.status && pos.status.includes('FAILED'));
        if (failedPositions.length > 0) {
            console.log(`⚠️  ${failedPositions.length} failed position(s) need attention`);
            console.log(`   Run: node scripts/clearPositions.js clear`);
        }
        
        // Win rate analysis
        const profitableCount = completedTrades.filter(trade => (trade.pnl || 0) > 0).length;
        const winRate = completedTrades.length > 0 ? (profitableCount / completedTrades.length * 100) : 0;
        
        if (winRate < 30 && completedTrades.length >= 5) {
            console.log(`📉 Low win rate (${winRate.toFixed(1)}%) - consider adjusting strategy`);
        }
        
        // Average loss vs profit analysis
        const profits = completedTrades.filter(t => (t.pnl || 0) > 0).map(t => t.pnl);
        const losses = completedTrades.filter(t => (t.pnl || 0) < 0).map(t => Math.abs(t.pnl));
        
        if (profits.length > 0 && losses.length > 0) {
            const avgProfit = profits.reduce((a, b) => a + b, 0) / profits.length;
            const avgLoss = losses.reduce((a, b) => a + b, 0) / losses.length;
            const profitLossRatio = avgProfit / avgLoss;
            
            if (profitLossRatio < 1) {
                console.log(`📊 Poor profit/loss ratio (${profitLossRatio.toFixed(2)}) - losses too big vs profits`);
            }
        }
        
        // No positions warnings
        if (activePositions.length === 0 && completedTrades.length > 0) {
            console.log(`🤔 No active positions - bot may have stopped or all closed`);
        }
        
        console.log(`\n🧹 Utility Commands:`);
        console.log(`   Check wallet: node scripts/sellAllTokens.js show`);
        console.log(`   Clean tokens: node scripts/sellAllTokens.js clean`);
        console.log(`   Clear positions: node scripts/clearPositions.js clear`);
    }

    formatDuration(milliseconds) {
        const seconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2);
    const action = args[0] || 'recap';
    
    // Check if first argument looks like a timeframe
    const timeframePattern = /^(\d+)([hdwmy])$/i;
    let timeframe = null;
    let actualAction = action;
    
    if (timeframePattern.test(action)) {
        // First argument is a timeframe
        timeframe = action;
        actualAction = args[1] || 'recap';
    } else if (args[1] && timeframePattern.test(args[1])) {
        // Second argument is a timeframe
        timeframe = args[1];
    }

    const recap = new TradingRecap(timeframe);

    switch (actualAction) {
        case 'recap':
        case 'summary':
        case 'stats':
            await recap.generateRecap();
            break;
            
        case 'help':
            console.log('📊 TRADING BOT RECAP TOOL');
            console.log('=' .repeat(30));
            console.log('');
            console.log('Shows comprehensive trading performance from:');
            console.log('  • positions.json (active positions)');
            console.log('  • trades_history.json (completed trades)');
            console.log('');
            console.log('Usage: node scripts/getTradingRecap.js [timeframe] [action]');
            console.log('       node scripts/getTradingRecap.js [action] [timeframe]');
            console.log('');
            console.log('Timeframes:');
            console.log('  1h, 6h, 12h    - Hours');
            console.log('  1d, 7d, 30d    - Days');
            console.log('  1w, 4w         - Weeks');
            console.log('  1m, 6m, 12m    - Months');
            console.log('  1y             - Years');
            console.log('  (none)         - All time');
            console.log('');
            console.log('Actions:');
            console.log('  recap    - Show comprehensive trading recap (default)');
            console.log('  help     - Show this help message');
            console.log('');
            console.log('Examples:');
            console.log('  node scripts/getTradingRecap.js                # All time recap');
            console.log('  node scripts/getTradingRecap.js 1d             # Last 24 hours');
            console.log('  node scripts/getTradingRecap.js 7d             # Last 7 days');
            console.log('  node scripts/getTradingRecap.js 1h recap       # Last hour recap');
            console.log('  node scripts/getTradingRecap.js recap 30d      # Last 30 days recap');
            console.log('  node scripts/getTradingRecap.js 1w             # Last week');
            console.log('  node scripts/getTradingRecap.js 6m             # Last 6 months');
            break;
            
        default:
            await recap.generateRecap();
            break;
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = TradingRecap;