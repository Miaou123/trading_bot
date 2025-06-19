// src/services/telegramService.js - Telegram notifications for trading bot
const TelegramBot = require('node-telegram-bot-api');
const logger = require('../utils/logger');

class TelegramService {
    constructor(config = {}) {
        this.config = {
            token: config.token || process.env.TELEGRAM_BOT_TOKEN,
            userId: config.userId || process.env.TELEGRAM_USER_ID,
            enabled: config.enabled !== undefined ? config.enabled : (process.env.ENABLE_TELEGRAM_NOTIFICATIONS === 'true'),
            tradingMode: config.tradingMode || process.env.TRADING_MODE || 'paper'
        };

        this.bot = null;
        this.isInitialized = false;

        if (this.config.enabled && this.config.token && this.config.userId) {
            this.initialize();
        } else if (this.config.enabled) {
            logger.warn('📱 Telegram notifications enabled but missing TOKEN or USER_ID');
        }
    }

    async initialize() {
        try {
            this.bot = new TelegramBot(this.config.token, { polling: false });
            
            // Test the connection
            await this.bot.getMe();
            this.isInitialized = true;
            
            logger.info('📱 Telegram service initialized successfully');
            
            // Send startup message
            await this.sendStartupMessage();
            
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram service:', error.message);
            this.isInitialized = false;
        }
    }

    async sendStartupMessage() {
        if (!this.isInitialized) return;

        const modeEmoji = this.config.tradingMode === 'live' ? '🔴' : '📝';
        const message = `${modeEmoji} *Trading Bot Started*\n\n` +
                       `🤖 Mode: \`${this.config.tradingMode.toUpperCase()}\`\n` +
                       `⏰ Started: ${new Date().toLocaleString()}\n\n` +
                       `Ready to monitor your trades! 🚀`;

        await this.sendMessage(message);
    }

    async sendNewPositionAlert(position, alert) {
        if (!this.isInitialized) return;

        const modeEmoji = this.config.tradingMode === 'live' ? '🔴' : '📝';
        const twitterInfo = alert.twitter?.url && alert.twitter.url !== 'TESTING_MODE_NO_TWITTER_CHECK' 
            ? `[Twitter](${alert.twitter.url}) (${alert.twitter.likes || 0} likes)` 
            : 'No Twitter found';

        const message = `${modeEmoji} *NEW POSITION OPENED*\n\n` +
                       `🪙 **${position.symbol}**\n` +
                       `📋 Address: \`${position.tokenAddress}\`\n` +
                       `📈 [DexScreener Chart](https://dexscreener.com/solana/${position.tokenAddress})\n\n` +
                       
                       `💰 Investment: \`${position.investedAmount.toFixed(4)} SOL\`\n` +
                       `📊 Entry Price: \`${position.entryPrice.toFixed(8)} SOL\`\n` +
                       `🎯 Quantity: \`${parseFloat(position.quantity).toLocaleString()}\` tokens\n\n` +
                       
                       `**📈 Take Profit Levels:**\n` +
                       position.takeProfitLevels.map(tp => 
                           `• TP${tp.level}: \`${tp.targetPrice.toFixed(8)} SOL\` (+${tp.percentage}%) - Sell ${tp.sellPercentage}%`
                       ).join('\n') + '\n\n' +
                       
                       `**🛡️ Risk Management:**\n` +
                       `• Stop Loss: \`${position.stopLossPrice.toFixed(8)} SOL\` (-${((1 - position.stopLossPrice/position.entryPrice) * 100).toFixed(1)}%)\n\n` +
                       
                       `**🐦 Social:**\n${twitterInfo}\n\n` +
                       `⏰ ${new Date().toLocaleString()}`;

        await this.sendMessage(message);
    }

    async sendTakeProfitAlert(position, tpData) {
        if (!this.isInitialized) return;

        const modeEmoji = this.config.tradingMode === 'live' ? '🔴' : '📝';
        const remainingPercentage = (parseFloat(position.remainingQuantity) / parseFloat(position.quantity) * 100);
        const totalInvested = position.investedAmount;
        const currentValue = parseFloat(position.remainingQuantity) * position.currentPrice;
        const totalPnL = (position.totalRealizedPnL || 0) + (currentValue - (totalInvested * remainingPercentage / 100));
        const pnlPercentage = (totalPnL / totalInvested) * 100;

        const message = `${modeEmoji} *TAKE PROFIT HIT!* 🎯\n\n` +
                       `🪙 **${position.symbol}** (${position.tokenAddress.slice(0, 8)}...)\n` +
                       `📊 TP${tpData.level} triggered at \`${tpData.triggerPrice.toFixed(8)} SOL\`\n` +
                       `💹 Gain: **+${tpData.gainPercentage.toFixed(1)}%**\n` +
                       `📤 Sold: ${tpData.sellPercentage}% of remaining position\n\n` +
                       
                       `**💰 Current Bag:**\n` +
                       `• Remaining: \`${parseFloat(position.remainingQuantity).toLocaleString()}\` tokens (${remainingPercentage.toFixed(1)}% of original)\n` +
                       `• Current Value: \`${currentValue.toFixed(4)} SOL\`\n` +
                       `• Total PnL: \`${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(4)} SOL\` (${pnlPercentage >= 0 ? '+' : ''}${pnlPercentage.toFixed(1)}%)\n\n` +
                       
                       `**🛡️ New Stop Loss:**\n` +
                       (tpData.trailingStopLoss ? 
                           `• Updated to: \`${tpData.trailingStopLoss.newStopLoss.toFixed(8)} SOL\`\n` +
                           `• Protection: ${tpData.trailingStopLoss.stopLossInfo}\n` +
                           `• Previous SL: \`${tpData.trailingStopLoss.oldStopLoss.toFixed(8)} SOL\`\n\n`
                           : `• Current: \`${position.stopLossPrice.toFixed(8)} SOL\`\n\n`) +
                       
                       `⏰ ${new Date().toLocaleString()}`;

        await this.sendMessage(message);
    }

    async sendStopLossAlert(position, slData) {
        if (!this.isInitialized) return;
    
        const modeEmoji = this.config.tradingMode === 'live' ? '🔴' : '📝';
        
        // 🔥 FIXED: Calculate accurate totals using all realized PnL + any remaining value
        const totalRealizedPnL = position.totalRealizedPnL || 0;
        const remainingValue = parseFloat(position.remainingQuantity || 0) * (position.currentPrice || slData.triggerPrice);
        const remainingInvestmentRatio = parseFloat(position.remainingQuantity || 0) / parseFloat(position.quantity);
        const remainingOriginalInvestment = position.investedAmount * remainingInvestmentRatio;
        const finalSellPnL = remainingValue - remainingOriginalInvestment; // This should be the loss from the stop loss
        
        const totalPnL = totalRealizedPnL + finalSellPnL;
        const pnlPercentage = (totalPnL / position.investedAmount) * 100;
        const isProfit = totalPnL >= 0;
        const resultEmoji = isProfit ? '💚' : '❌';
        
        // 🔥 FIXED: Calculate actual duration
        const startTime = position.entryTime || position.createdAt;
        const endTime = position.closedAt || Date.now();
        const duration = startTime ? this.formatDuration(endTime - startTime) : 'Unknown';
    
        // 🔥 FIXED: Get actual exit price (should come from the sell transaction)
        const actualExitPrice = slData.triggerPrice; // This is where the stop loss triggered
        
        const message = `${modeEmoji} *POSITION CLOSED* ${resultEmoji}\n\n` +
                       `🪙 **${position.symbol}** (${position.tokenAddress.slice(0, 8)}...)\n` +
                       `🛑 Stop Loss triggered at \`${actualExitPrice.toFixed(8)} SOL\`\n` +
                       `📉 Loss from entry: **-${Math.abs(slData.lossPercentage).toFixed(1)}%**\n\n` +
                       
                       `**📊 Final Results:**\n` +
                       `• Initial Investment: \`${position.investedAmount.toFixed(4)} SOL\`\n` +
                       `• Entry Price: \`${position.entryPrice.toFixed(8)} SOL\`\n` +
                       `• Exit Price: \`${actualExitPrice.toFixed(8)} SOL\`\n` +
                       `• Duration: ${duration}\n\n` +
                       
                       `**💰 P&L Summary:**\n` +
                       `• Total P&L: \`${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(4)} SOL\`\n` +
                       `• Total Return: **${pnlPercentage >= 0 ? '+' : ''}${pnlPercentage.toFixed(1)}%**\n` +
                       `• Result: ${isProfit ? '✅ PROFIT' : '❌ LOSS'}\n\n` +
                       
                       (position.partialSells && position.partialSells.length > 0 ? 
                           `**📤 Previous Take Profits:**\n` +
                           position.partialSells.map(sell => 
                               `• ${sell.reason}: ${sell.pnl >= 0 ? '+' : ''}${sell.pnl.toFixed(4)} SOL`
                           ).join('\n') + '\n\n' : '') +
                       
                       `⏰ ${new Date().toLocaleString()}`;
    
        await this.sendMessage(message);
    }

    async sendMessage(text) {
        if (!this.isInitialized || !this.config.userId) return;

        try {
            await this.bot.sendMessage(this.config.userId, text, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
            
            logger.debug('📱 Telegram message sent successfully');
        } catch (error) {
            logger.error('❌ Failed to send Telegram message:', error.message);
        }
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

    // Status and control methods
    isEnabled() {
        return this.config.enabled && this.isInitialized;
    }

    async testConnection() {
        if (!this.isInitialized) return false;
        
        try {
            await this.sendMessage('🧪 *Test Message*\n\nTelegram service is working correctly! ✅');
            return true;
        } catch (error) {
            logger.error('❌ Telegram test failed:', error.message);
            return false;
        }
    }

    async sendErrorAlert(error, context = 'Trading Bot') {
        if (!this.isInitialized) return;

        const message = `🚨 *ERROR ALERT*\n\n` +
                       `Context: ${context}\n` +
                       `Error: \`${error.message}\`\n` +
                       `Time: ${new Date().toLocaleString()}`;

        await this.sendMessage(message);
    }
}

module.exports = TelegramService;