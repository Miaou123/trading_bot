// src/notifications/telegramTrading.js - Simple trading notifications
const TelegramBot = require('node-telegram-bot-api');
const logger = require('../utils/logger');

class TelegramTradingNotifier {
    constructor(config = {}) {
        this.config = {
            botToken: config.botToken || process.env.TELEGRAM_BOT_TOKEN,
            channelId: config.channelId || process.env.TRADING_RESULTS_CHANNEL_ID,
            enabled: process.env.ENABLE_TELEGRAM_NOTIFICATIONS !== 'false',
            ...config
        };

        this.bot = null;
        this.isEnabled = false;

        if (this.config.botToken && this.config.channelId) {
            try {
                this.bot = new TelegramBot(this.config.botToken);
                this.isEnabled = true;
                logger.info(`📱 Telegram trading notifications enabled: ${this.config.channelId}`);
            } catch (error) {
                logger.warn('⚠️ Telegram bot initialization failed:', error.message);
            }
        } else {
            logger.info('📱 Telegram notifications disabled (missing token or channel)');
        }
    }

    async sendBuyNotification(position, alert) {
        if (!this.isEnabled) return;

        try {
            const tokenPrice = parseFloat(position.entryPrice);
            const tokenAmount = parseFloat(position.quantity);
            const investedSOL = position.investedAmount;
            
            // Calculate market cap (assuming 1B total supply for new tokens)
            const totalSupply = 1000000000;
            const marketCap = tokenPrice * totalSupply;
            
            // Calculate stop loss and take profit market caps
            const stopLossValue = position.stopLoss;
            const stopLossPrice = stopLossValue / tokenAmount;
            const stopLossMarketCap = stopLossPrice * totalSupply;
            
            // Take profit calculations
            const takeProfits = position.takeProfitLevels.map((tp, index) => {
                const tpPrice = tp.targetValue / tokenAmount;
                const tpMarketCap = tpPrice * totalSupply;
                return {
                    level: index + 1,
                    percentage: tp.sellPercentage,
                    price: tpPrice,
                    marketCap: tpMarketCap
                };
            });

            const message = this.formatBuyMessage({
                symbol: position.symbol,
                tokenAddress: position.tokenAddress,
                entryPrice: tokenPrice,
                tokenAmount: tokenAmount,
                investedSOL: investedSOL,
                entryMarketCap: marketCap,
                stopLossMarketCap: stopLossMarketCap,
                takeProfits: takeProfits,
                twitterLikes: alert.twitter?.likes || 0,
                twitterViews: alert.twitter?.views || 0,
                positionId: position.id,
                timestamp: new Date().toLocaleString()
            });

            await this.sendMessage(message);
            logger.info(`📱 Buy notification sent for ${position.symbol}`);

        } catch (error) {
            logger.error('❌ Failed to send buy notification:', error);
        }
    }

    async sendSellNotification(position, sellData) {
        if (!this.isEnabled) return;

        try {
            const { sellQuantity, soldValue, pnl, reason } = sellData;
            const sellPrice = soldValue / sellQuantity;
            
            // Calculate market cap at sell
            const totalSupply = 1000000000;
            const sellMarketCap = sellPrice * totalSupply;
            
            // Calculate performance
            const entryValue = (sellQuantity / parseFloat(position.quantity)) * position.investedAmount;
            const performancePercent = ((soldValue - entryValue) / entryValue) * 100;

            const message = this.formatSellMessage({
                symbol: position.symbol,
                tokenAddress: position.tokenAddress,
                sellPrice: sellPrice,
                sellQuantity: sellQuantity,
                soldValue: soldValue,
                pnl: pnl,
                performancePercent: performancePercent,
                sellMarketCap: sellMarketCap,
                entryMarketCap: parseFloat(position.entryPrice) * totalSupply,
                reason: reason,
                positionId: position.id,
                timestamp: new Date().toLocaleString()
            });

            await this.sendMessage(message);
            logger.info(`📱 Sell notification sent for ${position.symbol}`);

        } catch (error) {
            logger.error('❌ Failed to send sell notification:', error);
        }
    }

    formatBuyMessage(data) {
        const {
            symbol,
            tokenAddress,
            entryPrice,
            tokenAmount,
            investedSOL,
            entryMarketCap,
            stopLossMarketCap,
            takeProfits,
            twitterLikes,
            twitterViews,
            positionId,
            timestamp
        } = data;

        let message = `🟢 <b>BUY EXECUTED</b>\n\n`;
        message += `<b>Token:</b> ${symbol}\n`;
        message += `<code>${tokenAddress}</code>\n\n`;
        
        message += `<b>📊 Trade Details:</b>\n`;
        message += `• Amount: ${this.formatNumber(tokenAmount)} ${symbol}\n`;
        message += `• Price: ${entryPrice.toFixed(12)} SOL\n`;
        message += `• Invested: ${investedSOL} SOL\n`;
        message += `• Entry Market Cap: $${this.formatNumber(entryMarketCap)}\n\n`;
        
        message += `<b>🎯 Targets:</b>\n`;
        message += `• Stop Loss: $${this.formatNumber(stopLossMarketCap)} MC\n`;
        
        takeProfits.forEach(tp => {
            const multiplier = tp.marketCap / entryMarketCap;
            message += `• TP${tp.level} (${tp.percentage}%): $${this.formatNumber(tp.marketCap)} MC (${multiplier.toFixed(1)}x)\n`;
        });
        
        message += `\n<b>🐦 Twitter:</b>\n`;
        message += `• ${this.formatNumber(twitterLikes)} likes\n`;
        message += `• ${this.formatNumber(twitterViews)} views\n\n`;
        
        message += `<b>🔗 Links:</b>\n`;
        message += `📈 <a href="https://dexscreener.com/solana/${tokenAddress}">DexScreener</a> | `;
        message += `🔥 <a href="https://pump.fun/${tokenAddress}">Pump.fun</a>\n\n`;
        
        message += `<i>Position ID: ${positionId}\n`;
        message += `Time: ${timestamp}</i>`;

        return message;
    }

    formatSellMessage(data) {
        const {
            symbol,
            tokenAddress,
            sellPrice,
            sellQuantity,
            soldValue,
            pnl,
            performancePercent,
            sellMarketCap,
            entryMarketCap,
            reason,
            positionId,
            timestamp
        } = data;

        const isProfit = pnl > 0;
        const emoji = isProfit ? '🟢' : '🔴';
        const action = isProfit ? 'PROFIT' : 'LOSS';

        let message = `${emoji} <b>SELL EXECUTED - ${action}</b>\n\n`;
        message += `<b>Token:</b> ${symbol}\n`;
        message += `<code>${tokenAddress}</code>\n\n`;
        
        message += `<b>📊 Trade Details:</b>\n`;
        message += `• Sold: ${this.formatNumber(sellQuantity)} ${symbol}\n`;
        message += `• Price: ${sellPrice.toFixed(12)} SOL\n`;
        message += `• Value: ${soldValue.toFixed(4)} SOL\n`;
        message += `• PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(4)} SOL\n`;
        message += `• Performance: ${performancePercent > 0 ? '+' : ''}${performancePercent.toFixed(2)}%\n\n`;
        
        message += `<b>📈 Market Cap:</b>\n`;
        message += `• Entry: $${this.formatNumber(entryMarketCap)}\n`;
        message += `• Exit: $${this.formatNumber(sellMarketCap)}\n`;
        
        const mcMultiplier = sellMarketCap / entryMarketCap;
        message += `• Multiple: ${mcMultiplier.toFixed(2)}x\n\n`;
        
        message += `<b>Reason:</b> ${reason}\n\n`;
        
        message += `<b>🔗 Links:</b>\n`;
        message += `📈 <a href="https://dexscreener.com/solana/${tokenAddress}">DexScreener</a> | `;
        message += `🔥 <a href="https://pump.fun/${tokenAddress}">Pump.fun</a>\n\n`;
        
        message += `<i>Position ID: ${positionId}\n`;
        message += `Time: ${timestamp}</i>`;

        return message;
    }

    formatNumber(num) {
        if (num >= 1000000000) {
            return (num / 1000000000).toFixed(1) + 'B';
        }
        if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + 'M';
        }
        if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        }
        return Math.round(num).toLocaleString();
    }

    async sendMessage(message) {
        if (!this.bot || !this.config.channelId) {
            return;
        }

        try {
            await this.bot.sendMessage(this.config.channelId, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
        } catch (error) {
            logger.error('❌ Telegram message send failed:', error);
            throw error;
        }
    }

    async testNotification() {
        if (!this.isEnabled) {
            throw new Error('Telegram notifications not enabled');
        }

        const testMessage = `🧪 <b>Test Notification</b>\n\nTrading bot notifications are working correctly!\n\n<i>Time: ${new Date().toLocaleString()}</i>`;
        
        await this.sendMessage(testMessage);
        logger.info('📱 Test notification sent');
    }

    getStatus() {
        return {
            enabled: this.isEnabled,
            botToken: !!this.config.botToken,
            channelId: this.config.channelId,
            configured: this.isEnabled
        };
    }
}

module.exports = TelegramTradingNotifier;