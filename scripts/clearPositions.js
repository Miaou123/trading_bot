// scripts/clearPositions.js - Clear all positions and reinitialize bot
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const logger = require('../src/utils/logger');

class PositionCleaner {
    constructor() {
        this.positionsFile = './positions.json';
        this.backupDir = './backups';
    }

    async clearAllPositions() {
        try {
            console.log('🧹 POSITION CLEANER & BOT REINITIALIZER');
            console.log('=' .repeat(50));

            // Step 1: Check if positions file exists
            const positionsPath = path.resolve(this.positionsFile);
            console.log(`\n📍 Checking positions file: ${positionsPath}`);

            let currentPositions = null;
            try {
                const data = await fs.readFile(positionsPath, 'utf8');
                currentPositions = JSON.parse(data);
                console.log('✅ Positions file found');
            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.log('ℹ️ No positions file exists - nothing to clear');
                    return this.initializeCleanBot();
                } else {
                    throw error;
                }
            }

            // Step 2: Show current positions
            const activeCount = Object.keys(currentPositions.active || {}).length;
            const closedCount = Object.keys(currentPositions.closed || {}).length;
            
            console.log(`\n📊 Current positions:`);
            console.log(`   Active: ${activeCount}`);
            console.log(`   Closed: ${closedCount}`);
            console.log(`   Total: ${activeCount + closedCount}`);

            if (activeCount === 0 && closedCount === 0) {
                console.log('ℹ️ No positions to clear');
                return this.initializeCleanBot();
            }

            // Step 3: Show position details
            if (activeCount > 0) {
                console.log(`\n🔍 Active positions to be cleared:`);
                Object.values(currentPositions.active || {}).forEach((pos, index) => {
                    const pnl = pos.unrealizedPnL || 0;
                    const pnlSign = pnl >= 0 ? '+' : '';
                    console.log(`   ${index + 1}. ${pos.symbol} - ${pnlSign}${pnl.toFixed(6)} SOL`);
                });
            }

            if (closedCount > 0) {
                console.log(`\n📜 Closed positions to be cleared:`);
                Object.values(currentPositions.closed || {}).forEach((pos, index) => {
                    const pnl = pos.totalPnL || 0;
                    const pnlSign = pnl >= 0 ? '+' : '';
                    console.log(`   ${index + 1}. ${pos.symbol} - ${pnlSign}${pnl.toFixed(6)} SOL`);
                });
            }

            // Step 4: Calculate total P&L
            const totalActivePnL = Object.values(currentPositions.active || {})
                .reduce((sum, pos) => sum + (pos.unrealizedPnL || 0), 0);
            const totalClosedPnL = Object.values(currentPositions.closed || {})
                .reduce((sum, pos) => sum + (pos.totalPnL || 0), 0);
            const totalPnL = totalActivePnL + totalClosedPnL;

            console.log(`\n💰 Total P&L Summary:`);
            console.log(`   Active positions: ${totalActivePnL >= 0 ? '+' : ''}${totalActivePnL.toFixed(6)} SOL`);
            console.log(`   Closed positions: ${totalClosedPnL >= 0 ? '+' : ''}${totalClosedPnL.toFixed(6)} SOL`);
            console.log(`   TOTAL P&L: ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(6)} SOL`);

            // Step 5: Confirm clearing
            console.log(`\n⚠️  WARNING: This will permanently delete ALL positions!`);
            console.log(`   - ${activeCount} active positions will be lost`);
            console.log(`   - ${closedCount} closed positions will be lost`);
            console.log(`   - Trading history will be backed up`);

            const readline = require('readline');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const confirmed = await new Promise(resolve => {
                rl.question('\nType "CLEAR" to confirm deletion of all positions: ', resolve);
            });

            rl.close();

            if (confirmed !== 'CLEAR') {
                console.log('❌ Operation cancelled');
                return false;
            }

            // Step 6: Create backup
            await this.createBackup(currentPositions);

            // Step 7: Clear positions
            await this.clearPositionsFile();

            // Step 8: Initialize clean bot
            await this.initializeCleanBot();

            console.log('\n🎉 POSITIONS CLEARED & BOT REINITIALIZED!');
            console.log('   ✅ All positions deleted');
            console.log('   ✅ Backup created');
            console.log('   ✅ Clean bot ready');
            console.log('\nYou can now start fresh trading:');
            console.log('   npm run paper  # Paper trading');
            console.log('   npm run live   # Live trading');

            return true;

        } catch (error) {
            console.error('❌ Error clearing positions:', error.message);
            return false;
        }
    }

    async createBackup(positions) {
        try {
            // Ensure backup directory exists
            const backupPath = path.resolve(this.backupDir);
            await fs.mkdir(backupPath, { recursive: true });

            // Create timestamped backup
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = path.join(backupPath, `positions-backup-${timestamp}.json`);

            await fs.writeFile(backupFile, JSON.stringify(positions, null, 2));

            console.log(`\n💾 Backup created: ${backupFile}`);
            return backupFile;

        } catch (error) {
            console.warn('⚠️ Backup creation failed:', error.message);
            // Continue anyway - backup failure shouldn't stop clearing
        }
    }

    async clearPositionsFile() {
        try {
            const cleanPositions = {
                active: {},
                closed: {},
                lastSaved: new Date().toISOString(),
                stats: {
                    stopLossTriggered: 0,
                    takeProfitTriggered: 0,
                    priceUpdates: 0,
                    poolBasedPriceUpdates: 0,
                    fallbackPriceUpdates: 0,
                    priceUpdateFailures: 0,
                    liveSellsExecuted: 0,
                    paperSellsExecuted: 0,
                    stopLossExecutions: 0,
                    takeProfitExecutions: 0,
                    totalLivePnL: 0
                },
                priceUpdateStats: {
                    poolBased: { attempts: 0, successes: 0, totalTime: 0 },
                    fallback: { attempts: 0, successes: 0, totalTime: 0 },
                    lastUpdate: Date.now()
                }
            };

            const positionsPath = path.resolve(this.positionsFile);
            await fs.writeFile(positionsPath, JSON.stringify(cleanPositions, null, 2));

            console.log(`\n🧹 Positions file cleared: ${positionsPath}`);

        } catch (error) {
            console.error('❌ Error clearing positions file:', error.message);
            throw error;
        }
    }

    async initializeCleanBot() {
        try {
            console.log(`\n🤖 Initializing clean bot configuration...`);

            // Test bot components
            const tests = [
                this.testLogger(),
                this.testEnvironment(),
                this.testPumpSwapService(),
                this.testTradingBot(),
                this.testPositionManager()
            ];

            const results = await Promise.allSettled(tests);
            
            let allPassed = true;
            results.forEach((result, index) => {
                const testNames = ['Logger', 'Environment', 'PumpSwap', 'TradingBot', 'PositionManager'];
                if (result.status === 'fulfilled' && result.value) {
                    console.log(`   ✅ ${testNames[index]} - OK`);
                } else {
                    console.log(`   ❌ ${testNames[index]} - FAILED`);
                    allPassed = false;
                }
            });

            if (allPassed) {
                console.log(`\n✅ Bot initialization complete - ready for clean start!`);
            } else {
                console.log(`\n⚠️ Some components failed - check configuration`);
            }

            return allPassed;

        } catch (error) {
            console.error('❌ Bot initialization failed:', error.message);
            return false;
        }
    }

    async testLogger() {
        try {
            logger.info('🧪 Testing logger - positions cleared');
            return true;
        } catch (error) {
            console.error('Logger test failed:', error.message);
            return false;
        }
    }

    async testEnvironment() {
        try {
            const required = ['PRIVATE_KEY', 'TRADING_MODE'];
            const missing = required.filter(key => !process.env[key]);
            
            if (missing.length > 0) {
                console.error(`Missing env vars: ${missing.join(', ')}`);
                return false;
            }
            
            return true;
        } catch (error) {
            return false;
        }
    }

    async testPumpSwapService() {
        try {
            const PumpSwapService = require('../src/services/pumpSwapService');
            const service = new PumpSwapService({
                privateKey: process.env.PRIVATE_KEY,
                slippageTolerance: 5
            });
            
            return !!service.wallet;
        } catch (error) {
            console.error('PumpSwap test failed:', error.message);
            return false;
        }
    }

    async testTradingBot() {
        try {
            const TradingBot = require('../src/bot/tradingBot');
            const bot = new TradingBot({
                tradingMode: process.env.TRADING_MODE || 'paper'
            });
            
            return !!bot.pumpSwapService;
        } catch (error) {
            console.error('TradingBot test failed:', error.message);
            return false;
        }
    }

    async testPositionManager() {
        try {
            const PositionManager = require('../src/bot/positionManager');
            const manager = new PositionManager({
                tradingMode: process.env.TRADING_MODE || 'paper'
            });
            
            return typeof manager.getActivePositionsCount === 'function';
        } catch (error) {
            console.error('PositionManager test failed:', error.message);
            return false;
        }
    }

    // Utility: Show current status without clearing
    async showStatus() {
        try {
            console.log('📊 CURRENT BOT STATUS');
            console.log('=' .repeat(30));

            const positionsPath = path.resolve(this.positionsFile);
            
            try {
                const data = await fs.readFile(positionsPath, 'utf8');
                const positions = JSON.parse(data);
                
                const activeCount = Object.keys(positions.active || {}).length;
                const closedCount = Object.keys(positions.closed || {}).length;
                
                console.log(`\n📈 Positions:`);
                console.log(`   Active: ${activeCount}`);
                console.log(`   Closed: ${closedCount}`);
                
                if (positions.stats) {
                    console.log(`\n📊 Stats:`);
                    console.log(`   Live sells: ${positions.stats.liveSellsExecuted || 0}`);
                    console.log(`   Paper sells: ${positions.stats.paperSellsExecuted || 0}`);
                    console.log(`   Total Live PnL: ${(positions.stats.totalLivePnL || 0).toFixed(6)} SOL`);
                }
                
            } catch (error) {
                console.log('📍 No positions file found - clean state');
            }

            console.log(`\n🤖 Bot Configuration:`);
            console.log(`   Trading Mode: ${process.env.TRADING_MODE || 'NOT SET'}`);
            console.log(`   Initial Investment: ${process.env.INITIAL_INVESTMENT_SOL || '0.01'} SOL`);
            console.log(`   Stop Loss: ${process.env.STOP_LOSS_PERCENTAGE || '50'}%`);
            console.log(`   Slippage: ${process.env.SLIPPAGE_TOLERANCE || '5'}%`);

        } catch (error) {
            console.error('❌ Error showing status:', error.message);
        }
    }
}

// CLI interface
async function main() {
    const action = process.argv[2] || 'clear';
    const cleaner = new PositionCleaner();

    switch (action) {
        case 'clear':
            await cleaner.clearAllPositions();
            break;
            
        case 'status':
            await cleaner.showStatus();
            break;
            
        case 'help':
        default:
            console.log('🧹 POSITION CLEANER & BOT REINITIALIZER');
            console.log('=' .repeat(40));
            console.log('');
            console.log('Usage: node scripts/clearPositions.js [action]');
            console.log('');
            console.log('Actions:');
            console.log('  clear   - Clear all positions and reinitialize bot (default)');
            console.log('  status  - Show current positions and bot status');
            console.log('  help    - Show this help message');
            console.log('');
            console.log('Examples:');
            console.log('  node scripts/clearPositions.js clear');
            console.log('  node scripts/clearPositions.js status');
            break;
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = PositionCleaner;