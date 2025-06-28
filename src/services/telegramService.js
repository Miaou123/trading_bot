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

        this.solPriceCache = {
            price: null,
            lastUpdated: null,
            cacheDuration: 60000 // 1 minute cache
        };
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

        // 🔥 NEW: Get SOL price in USD from CoinGecko (free, no API key needed)
        async getSolPriceUSD() {
            try {
                // Check cache first
                const now = Date.now();
                if (this.solPriceCache.price && 
                    this.solPriceCache.lastUpdated && 
                    (now - this.solPriceCache.lastUpdated) < this.solPriceCache.cacheDuration) {
                    return this.solPriceCache.price;
                }
    
                // Fetch fresh price from CoinGecko
                const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
                const data = await response.json();
                
                if (data?.solana?.usd) {
                    const price = data.solana.usd;
                    
                    // Update cache
                    this.solPriceCache = {
                        price: price,
                        lastUpdated: now,
                        cacheDuration: 60000
                    };
                    
                    logger.debug(`💰 SOL Price: $${price}`);
                    return price;
                }
                
                throw new Error('Invalid response format');
                
            } catch (error) {
                logger.error(`❌ Failed to fetch SOL price: ${error.message}`);
                // Return fallback price or null
                return this.solPriceCache.price || 200; // Fallback to ~$200 if no cached price
            }
        }
    
        // 🔥 NEW: Helper to format SOL amounts with USD equivalent
        async formatSolWithUSD(solAmount, decimals = 4) {
            const solPrice = await this.getSolPriceUSD();
            const usdAmount = solAmount * solPrice;
            
            return `\`${solAmount.toFixed(decimals)} SOL\` (~$${usdAmount.toFixed(2)})`;
        }
    
        // 🔥 NEW: Helper to format token price in both SOL and USD
        async formatTokenPrice(priceInSol, decimals = 8) {
            const solPrice = await this.getSolPriceUSD();
            const priceInUSD = priceInSol * solPrice;
            
            if (priceInUSD < 0.01) {
                // For very small USD amounts, show more decimals
                return `\`${priceInSol.toFixed(decimals)} SOL\` (~$${priceInUSD.toFixed(6)})`;
            } else {
                return `\`${priceInSol.toFixed(decimals)} SOL\` (~$${priceInUSD.toFixed(4)})`;
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

        // Format amounts with USD
        const investmentFormatted = await this.formatSolWithUSD(position.investedAmount);
        const entryPriceFormatted = await this.formatTokenPrice(position.entryPrice);
        const stopLossFormatted = await this.formatTokenPrice(position.stopLossPrice);

        const message = `${modeEmoji} *NEW POSITION OPENED*\n\n` +
                       `🪙 **${position.symbol}**\n` +
                       `📋 \`${position.tokenAddress}\`\n` +
                       `📈 [Chart](https://dexscreener.com/solana/${position.tokenAddress})\n\n` +
                       
                       `💰 Investment: ${investmentFormatted}\n` +
                       `📊 Entry Price: ${entryPriceFormatted}\n` +
                       `🎯 Quantity: \`${parseFloat(position.quantity).toLocaleString()}\` tokens\n\n` +
                       (position.txHash ? `📝 Entry Signature: \`${position.txHash}\`\n🔗 [View on Solscan](https://solscan.io/tx/${position.txHash})\n` : '') +
                       `\n` +
                       
                       `**📈 Take Profit Levels:**\n` +
                       await Promise.all(position.takeProfitLevels.map(async tp => {
                           const tpFormatted = await this.formatTokenPrice(tp.targetPrice);
                           return `• TP${tp.level}: ${tpFormatted} (+${tp.percentage}%) - Sell ${tp.sellPercentage}%`;
                       })).then(lines => lines.join('\n')) + '\n\n' +
                       
                       `**🛡️ Risk Management:**\n` +
                       `• Stop Loss: ${stopLossFormatted} (-${((1 - position.stopLossPrice/position.entryPrice) * 100).toFixed(1)}%)\n\n` +
                       
                       `**🐦 Social:**\n${twitterInfo}\n\n` +
                       `⏰ ${new Date().toLocaleString()}`;

        await this.sendMessage(message);
    }

    async sendTakeProfitAlert(position, tpData) {
        if (!this.isInitialized) return;
    
        const modeEmoji = this.config.tradingMode === 'live' ? '🔴' : '📝';

        // 🔥 DEBUG: Log what telegram service receives
        logger.info(`🔍 TELEGRAM SERVICE RECEIVED:`);
        logger.info(`   tpData object:`, JSON.stringify(tpData, null, 2));
        logger.info(`   tpData.tokensSold: ${tpData.tokensSold} (type: ${typeof tpData.tokensSold})`);
        logger.info(`   tpData.solReceived: ${tpData.solReceived} (type: ${typeof tpData.solReceived})`);

        
        // Get transaction details from tpData (passed from position manager)
        const tokensSold = tpData.tokensSold || 0;
        const solReceived = tpData.solReceived || 0;
        const transactionPnL = tpData.transactionPnL || 0;
        
        // Calculate remaining amounts AFTER the sell
        const originalQuantity = parseFloat(position.quantity);
        const remainingQuantity = parseFloat(position.remainingQuantity);
        const remainingPercentage = (remainingQuantity / originalQuantity) * 100;
        
        // Calculate current values
        const totalInvested = position.investedAmount;
        const currentValue = remainingQuantity * position.currentPrice;
        const totalRealizedPnL = (position.totalRealizedPnL || 0);
        const totalUnrealizedPnL = currentValue - (totalInvested * remainingPercentage / 100);
        const totalPnL = totalRealizedPnL + totalUnrealizedPnL;
        const pnlPercentage = (totalPnL / totalInvested) * 100;
    
        // Format amounts with USD
        const triggerPriceFormatted = await this.formatTokenPrice(tpData.triggerPrice);
        const tokensSoldFormatted = tokensSold.toLocaleString();
        const solReceivedFormatted = await this.formatSolWithUSD(solReceived);
        const currentValueFormatted = await this.formatSolWithUSD(currentValue);
        const totalPnLFormatted = await this.formatSolWithUSD(Math.abs(totalPnL));
    
        const message = `${modeEmoji} *TAKE PROFIT HIT!* 🎯\n\n` +
                       `🪙 **${position.symbol}** (${position.tokenAddress.slice(0, 8)}...)\n` +
                       `📊 TP${tpData.level} triggered at ${triggerPriceFormatted}\n` +
                       `💹 Gain: **+${tpData.gainPercentage.toFixed(1)}%**\n\n` +
                       
                       `**📤 Transaction Recap:**\n` +
                       `• Sold: \`${tokensSoldFormatted}\` **${position.symbol}**  for ${solReceivedFormatted}\n` +
                       `• [View on Solscan](https://solscan.io/tx/${tpData.signature || ''})\n` +
                       
                       `**💰 Current Bag:**\n` +
                       `• Remaining: \`${remainingQuantity.toLocaleString()}\` tokens (${remainingPercentage.toFixed(1)}% of original)\n` +
                       `• Current Value: ${currentValueFormatted}\n` +
                       `• Total PnL: ${totalPnL >= 0 ? '+' : '-'}${totalPnLFormatted} (${pnlPercentage >= 0 ? '+' : ''}${pnlPercentage.toFixed(1)}%)\n\n` +
                       
                       `**🛡️ New Stop Loss:**\n` +
                       (tpData.trailingStopLoss ? 
                           `• Updated to: ${await this.formatTokenPrice(tpData.trailingStopLoss.newStopLoss)}\n` +
                           `• Protection: ${tpData.trailingStopLoss.stopLossInfo}\n` +
                           `• Previous SL: ${await this.formatTokenPrice(tpData.trailingStopLoss.oldStopLoss)}\n\n`
                           : `• Current: ${await this.formatTokenPrice(position.stopLossPrice)}\n\n`) +
                       
                       `⏰ ${new Date().toLocaleString()}`;
    
        await this.sendMessage(message);
    }

    // 🔥 UPDATED: Enhanced stop loss alert with USD amounts
    async sendStopLossAlert(position, slData) {
        if (!this.isInitialized) return;

        const modeEmoji = this.config.tradingMode === 'live' ? '🔴' : '📝';
        
        const totalRealizedPnL = position.totalRealizedPnL || 0;
        const remainingValue = parseFloat(position.remainingQuantity || 0) * slData.triggerPrice;
        const remainingInvestmentRatio = parseFloat(position.remainingQuantity || 0) / parseFloat(position.quantity);
        const remainingOriginalInvestment = position.investedAmount * remainingInvestmentRatio;
        const finalSellPnL = remainingValue - remainingOriginalInvestment;
        
        const totalPnL = totalRealizedPnL + finalSellPnL;
        const pnlPercentage = (totalPnL / position.investedAmount) * 100;
        const isProfit = totalPnL >= 0;
        const resultEmoji = isProfit ? '💚' : '❌';
        
        const startTime = position.entryTime || position.createdAt;
        const endTime = position.closedAt || Date.now();
        const duration = startTime ? this.formatDuration(endTime - startTime) : 'Unknown';
        const actualExitPrice = slData.triggerPrice;

        // Format amounts with USD
        const investmentFormatted = await this.formatSolWithUSD(position.investedAmount);
        const entryPriceFormatted = await this.formatTokenPrice(position.entryPrice);
        const exitPriceFormatted = await this.formatTokenPrice(actualExitPrice);
        const totalPnLFormatted = await this.formatSolWithUSD(Math.abs(totalPnL));
        
        const message = `${modeEmoji} *POSITION CLOSED* ${resultEmoji}\n\n` +
                       `🪙 **${position.symbol}** (${position.tokenAddress.slice(0, 8)}...)\n` +
                       `🛑 Stop Loss triggered at ${exitPriceFormatted}\n` +
                       `📉 Loss from entry: **-${Math.abs(slData.lossPercentage).toFixed(1)}%**\n\n` +
                       
                       `**📊 Final Results:**\n` +
                       `• Initial Investment: ${investmentFormatted}\n` +
                       `• Entry Price: ${entryPriceFormatted}\n` +
                       `• Exit Price: ${exitPriceFormatted}\n` +
                       `• Duration: ${duration}\n\n` +
                       (slData.signature ? `• Exit Signature: \`${slData.signature}\`\n• [View on Solscan](https://solscan.io/tx/${slData.signature})\n` : '') +
                       `\n` +
                       
                       `**💰 P&L Summary:**\n` +
                       `• Total P&L: ${totalPnL >= 0 ? '+' : '-'}${totalPnLFormatted}\n` +
                       `• Total Return: **${pnlPercentage >= 0 ? '+' : ''}${pnlPercentage.toFixed(1)}%**\n` +
                       `• Result: ${isProfit ? '✅ PROFIT' : '❌ LOSS'}\n\n` +
                       
                       (position.partialSells && position.partialSells.length > 0 ? 
                           `**📤 Previous Take Profits:**\n` +
                           await Promise.all(position.partialSells.map(async sell => {
                               const sellPnLFormatted = await this.formatSolWithUSD(Math.abs(sell.pnl));
                               return `• ${sell.reason}: ${sell.pnl >= 0 ? '+' : '-'}${sellPnLFormatted}`;
                           })).then(lines => lines.join('\n')) + '\n\n' : '') +
                       
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