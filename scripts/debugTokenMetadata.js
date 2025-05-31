// scripts/debugTokenMetadata.js - Debug token metadata to find Twitter URLs
require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const logger = require('../src/utils/logger');

class TokenMetadataDebugger {
    constructor() {
        this.connection = new Connection(
            process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        this.httpClient = axios.create({
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TokenDebugger/1.0)'
            }
        });
    }

    // Method 1: Get token metadata from Solana blockchain directly
    async getOnChainMetadata(tokenAddress) {
        try {
            console.log(`\n🔍 METHOD 1: On-Chain Metadata`);
            console.log(`=`.repeat(40));
            
            const mintPubkey = new PublicKey(tokenAddress);
            
            // Get mint account info
            const mintInfo = await this.connection.getAccountInfo(mintPubkey);
            if (!mintInfo) {
                throw new Error('Token mint not found');
            }
            
            console.log(`✅ Mint account found:`);
            console.log(`   • Owner: ${mintInfo.owner.toString()}`);
            console.log(`   • Data length: ${mintInfo.data.length} bytes`);
            console.log(`   • Lamports: ${mintInfo.lamports}`);
            
            // Try to find metadata account (Metaplex standard)
            const metadataSeed = [
                Buffer.from('metadata'),
                new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s').toBuffer(),
                mintPubkey.toBuffer()
            ];
            
            const [metadataAddress] = PublicKey.findProgramAddressSync(
                metadataSeed,
                new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
            );
            
            console.log(`🔍 Looking for metadata at: ${metadataAddress.toString()}`);
            
            const metadataAccount = await this.connection.getAccountInfo(metadataAddress);
            if (metadataAccount) {
                console.log(`✅ Metadata account found:`);
                console.log(`   • Data length: ${metadataAccount.data.length} bytes`);
                
                // Try to parse metadata (simplified)
                const data = metadataAccount.data;
                console.log(`📊 Raw metadata (first 200 bytes):`, data.slice(0, 200));
                
                // Look for URL patterns in the raw data
                const dataString = data.toString('utf-8', 0, Math.min(1000, data.length));
                console.log(`📝 Metadata as string:`, dataString.replace(/\0/g, ''));
                
                const twitterUrls = this.findTwitterUrls(dataString);
                if (twitterUrls.length > 0) {
                    console.log(`🐦 Twitter URLs found in on-chain metadata:`, twitterUrls);
                } else {
                    console.log(`❌ No Twitter URLs found in on-chain metadata`);
                }
                
                return {
                    method: 'onchain',
                    found: true,
                    data: dataString,
                    twitterUrls: twitterUrls,
                    rawData: data
                };
            } else {
                console.log(`❌ No metadata account found`);
                return { method: 'onchain', found: false };
            }
            
        } catch (error) {
            console.log(`❌ On-chain metadata failed: ${error.message}`);
            return { method: 'onchain', found: false, error: error.message };
        }
    }

    // Method 2: Get metadata from Helius API
    async getHeliusMetadata(tokenAddress) {
        try {
            console.log(`\n🔍 METHOD 2: Helius API Metadata`);
            console.log(`=`.repeat(40));
            
            if (!process.env.HELIUS_RPC_URL) {
                throw new Error('HELIUS_RPC_URL not configured');
            }
            
            const response = await this.httpClient.post(process.env.HELIUS_RPC_URL, {
                jsonrpc: '2.0',
                id: 'token-metadata',
                method: 'getAsset',
                params: {
                    id: tokenAddress
                }
            });
            
            if (response.data.result) {
                const asset = response.data.result;
                console.log(`✅ Helius asset data found:`);
                console.log(`📊 Asset data:`, JSON.stringify(asset, null, 2));
                
                // Check various fields for Twitter URLs
                const fieldsToCheck = [
                    'content.metadata.description',
                    'content.metadata.external_url', 
                    'content.metadata.animation_url',
                    'content.metadata.name',
                    'content.metadata.symbol',
                    'content.json_uri',
                    'creators',
                    'attributes'
                ];
                
                const twitterUrls = [];
                for (const field of fieldsToCheck) {
                    const value = this.getNestedValue(asset, field);
                    if (value) {
                        const urls = this.findTwitterUrls(JSON.stringify(value));
                        twitterUrls.push(...urls);
                    }
                }
                
                if (twitterUrls.length > 0) {
                    console.log(`🐦 Twitter URLs found in Helius data:`, twitterUrls);
                } else {
                    console.log(`❌ No Twitter URLs found in Helius data`);
                }
                
                return {
                    method: 'helius',
                    found: true,
                    data: asset,
                    twitterUrls: [...new Set(twitterUrls)] // Remove duplicates
                };
            } else {
                console.log(`❌ No Helius data found`);
                return { method: 'helius', found: false };
            }
            
        } catch (error) {
            console.log(`❌ Helius metadata failed: ${error.message}`);
            return { method: 'helius', found: false, error: error.message };
        }
    }

    // Method 3: Get metadata from external JSON URI
    async getExternalMetadata(tokenAddress) {
        try {
            console.log(`\n🔍 METHOD 3: External JSON Metadata`);
            console.log(`=`.repeat(40));
            
            // First, try to get the JSON URI from on-chain metadata
            const onChainResult = await this.getOnChainMetadata(tokenAddress);
            if (!onChainResult.found) {
                throw new Error('Need on-chain metadata to find JSON URI');
            }
            
            // Look for JSON URI in the data
            const dataString = onChainResult.data;
            const jsonUriMatch = dataString.match(/https?:\/\/[^\s\0]+\.json/);
            
            if (!jsonUriMatch) {
                throw new Error('No JSON URI found in metadata');
            }
            
            const jsonUri = jsonUriMatch[0];
            console.log(`🔗 Found JSON URI: ${jsonUri}`);
            
            const response = await this.httpClient.get(jsonUri);
            console.log(`✅ External metadata loaded:`);
            console.log(`📊 JSON data:`, JSON.stringify(response.data, null, 2));
            
            const twitterUrls = this.findTwitterUrls(JSON.stringify(response.data));
            if (twitterUrls.length > 0) {
                console.log(`🐦 Twitter URLs found in external JSON:`, twitterUrls);
            } else {
                console.log(`❌ No Twitter URLs found in external JSON`);
            }
            
            return {
                method: 'external_json',
                found: true,
                jsonUri: jsonUri,
                data: response.data,
                twitterUrls: twitterUrls
            };
            
        } catch (error) {
            console.log(`❌ External metadata failed: ${error.message}`);
            return { method: 'external_json', found: false, error: error.message };
        }
    }

    // Method 4: Check DexScreener for metadata
    async getDexScreenerMetadata(tokenAddress) {
        try {
            console.log(`\n🔍 METHOD 4: DexScreener Metadata`);
            console.log(`=`.repeat(40));
            
            const response = await this.httpClient.get(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
            );
            
            if (response.data.pairs && response.data.pairs.length > 0) {
                const pair = response.data.pairs[0];
                console.log(`✅ DexScreener data found:`);
                console.log(`📊 Pair data:`, JSON.stringify(pair, null, 2));
                
                const twitterUrls = this.findTwitterUrls(JSON.stringify(pair));
                if (twitterUrls.length > 0) {
                    console.log(`🐦 Twitter URLs found in DexScreener:`, twitterUrls);
                } else {
                    console.log(`❌ No Twitter URLs found in DexScreener`);
                }
                
                return {
                    method: 'dexscreener',
                    found: true,
                    data: pair,
                    twitterUrls: twitterUrls
                };
            } else {
                console.log(`❌ No DexScreener data found`);
                return { method: 'dexscreener', found: false };
            }
            
        } catch (error) {
            console.log(`❌ DexScreener failed: ${error.message}`);
            return { method: 'dexscreener', found: false, error: error.message };
        }
    }

    // Method 5: Check PumpPortal WebSocket message format
    simulateWebSocketMessage(tokenAddress, twitterUrl) {
        console.log(`\n🔍 METHOD 5: WebSocket Message Simulation`);
        console.log(`=`.repeat(40));
        
        // Simulate what PumpPortal might send
        const possibleFormats = [
            {
                name: 'Direct twitter field',
                data: {
                    txType: 'create',
                    mint: tokenAddress,
                    name: 'Bitcoin',
                    symbol: 'BTC',
                    twitter: twitterUrl
                }
            },
            {
                name: 'Twitter in description',
                data: {
                    txType: 'create',
                    mint: tokenAddress,
                    name: 'Bitcoin',
                    symbol: 'BTC',
                    description: `Check out Bitcoin! ${twitterUrl}`
                }
            },
            {
                name: 'Twitter in uri metadata',
                data: {
                    txType: 'create',
                    mint: tokenAddress,
                    name: 'Bitcoin',
                    symbol: 'BTC',
                    uri: `https://example.com/metadata.json?twitter=${encodeURIComponent(twitterUrl)}`
                }
            },
            {
                name: 'Nested in metadata object',
                data: {
                    txType: 'create',
                    mint: tokenAddress,
                    name: 'Bitcoin',
                    symbol: 'BTC',
                    metadata: {
                        twitter: twitterUrl,
                        description: 'Bitcoin token'
                    }
                }
            }
        ];
        
        possibleFormats.forEach(format => {
            console.log(`\n📱 Testing format: ${format.name}`);
            console.log(`📊 Message:`, JSON.stringify(format.data, null, 2));
            
            const extractedUrl = this.extractTwitterUrlFromMessage(format.data);
            if (extractedUrl) {
                console.log(`✅ Twitter URL extracted: ${extractedUrl}`);
            } else {
                console.log(`❌ No Twitter URL extracted`);
            }
        });
        
        return possibleFormats;
    }

    // Helper: Extract Twitter URL from WebSocket message (like your bot does)
    extractTwitterUrlFromMessage(tokenData) {
        // Test your bot's extraction logic
        const fields = ['twitter', 'description', 'name', 'uri', 'metadata'];
        
        for (const field of fields) {
            if (tokenData[field]) {
                const url = this.findTwitterUrls(JSON.stringify(tokenData[field]));
                if (url.length > 0) {
                    return url[0];
                }
            }
        }
        
        // Check nested metadata
        if (tokenData.metadata) {
            for (const [key, value] of Object.entries(tokenData.metadata)) {
                if (typeof value === 'string') {
                    const url = this.findTwitterUrls(value);
                    if (url.length > 0) {
                        return url[0];
                    }
                }
            }
        }
        
        return null;
    }

    // Helper: Find Twitter URLs in text
    findTwitterUrls(text) {
        if (!text) return [];
        
        const patterns = [
            /https?:\/\/(www\.)?(twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/\d+/g,
            /https?:\/\/(twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/\d+/g,
            /(twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/\d+/g
        ];
        
        const urls = [];
        for (const pattern of patterns) {
            const matches = text.match(pattern);
            if (matches) {
                matches.forEach(match => {
                    let url = match;
                    if (!url.startsWith('http')) {
                        url = 'https://' + url;
                    }
                    urls.push(url);
                });
            }
        }
        
        return [...new Set(urls)]; // Remove duplicates
    }

    // Helper: Get nested object value by path
    getNestedValue(obj, path) {
        return path.split('.').reduce((current, key) => {
            return current && current[key] !== undefined ? current[key] : null;
        }, obj);
    }

    // Comprehensive debug of token
    async debugToken(tokenAddress, expectedTwitterUrl = null) {
        console.log(`🧪 COMPREHENSIVE TOKEN METADATA DEBUG`);
        console.log(`=`.repeat(60));
        console.log(`🎯 Token: ${tokenAddress}`);
        if (expectedTwitterUrl) {
            console.log(`🐦 Expected Twitter: ${expectedTwitterUrl}`);
        }
        console.log(`⏰ Time: ${new Date().toLocaleString()}`);
        
        const results = [];
        
        // Test all methods
        const methods = [
            () => this.getOnChainMetadata(tokenAddress),
            () => this.getHeliusMetadata(tokenAddress),
            () => this.getExternalMetadata(tokenAddress),
            () => this.getDexScreenerMetadata(tokenAddress)
        ];
        
        for (let i = 0; i < methods.length; i++) {
            try {
                const result = await methods[i]();
                results.push(result);
                
                if (result.twitterUrls && result.twitterUrls.length > 0) {
                    console.log(`✅ Method ${i + 1} (${result.method}) found Twitter URLs!`);
                } else {
                    console.log(`❌ Method ${i + 1} (${result.method}) no Twitter URLs found`);
                }
                
                // Small delay between methods
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                console.log(`💥 Method ${i + 1} crashed: ${error.message}`);
                results.push({
                    method: `method_${i + 1}`,
                    found: false,
                    error: error.message
                });
            }
        }
        
        // Test WebSocket simulation
        if (expectedTwitterUrl) {
            console.log(`\n🧪 Testing WebSocket message formats...`);
            this.simulateWebSocketMessage(tokenAddress, expectedTwitterUrl);
        }
        
        // Final summary
        console.log(`\n📊 FINAL SUMMARY`);
        console.log(`=`.repeat(40));
        
        const successfulMethods = results.filter(r => r.found && r.twitterUrls && r.twitterUrls.length > 0);
        
        if (successfulMethods.length > 0) {
            console.log(`✅ SUCCESS! Found Twitter URLs in ${successfulMethods.length} methods:`);
            successfulMethods.forEach(method => {
                console.log(`   • ${method.method}: ${method.twitterUrls.join(', ')}`);
            });
            
            const allUrls = [...new Set(successfulMethods.flatMap(m => m.twitterUrls))];
            console.log(`\n🐦 Unique Twitter URLs found: ${allUrls.length}`);
            allUrls.forEach(url => console.log(`   • ${url}`));
            
        } else {
            console.log(`❌ NO TWITTER URLs FOUND IN ANY METHOD`);
            console.log(`\n🔍 Possible reasons:`);
            console.log(`   • Twitter URL not included in token metadata during creation`);
            console.log(`   • URL stored in a field we're not checking`);
            console.log(`   • URL format doesn't match our patterns`);
            console.log(`   • Token metadata not yet indexed by APIs`);
            console.log(`\n💡 Solutions:`);
            console.log(`   • Check the token creation transaction for metadata`);
            console.log(`   • Look at pump.fun directly for the token page`);
            console.log(`   • Check if creator included Twitter in description/website`);
        }
        
        return results;
    }
}

// CLI Usage
async function main() {
    const tokenAddress = process.argv[2];
    const expectedTwitterUrl = process.argv[3];
    
    if (!tokenAddress) {
        console.log('Usage: node scripts/debugTokenMetadata.js <TOKEN_ADDRESS> [EXPECTED_TWITTER_URL]');
        console.log('');
        console.log('Examples:');
        console.log('  # Debug your Bitcoin token');
        console.log('  node scripts/debugTokenMetadata.js 7nF252FEM8KRCPHAahVJciukZUWieSd1ne6EPQ51pump');
        console.log('');
        console.log('  # Debug with expected Twitter URL for verification');
        console.log('  node scripts/debugTokenMetadata.js 7nF252FEM8KRCPHAahVJciukZUWieSd1ne6EPQ51pump https://x.com/Bitcoin/status/1927884384670978065');
        console.log('');
        console.log('This will check:');
        console.log('  ✅ On-chain Solana metadata');
        console.log('  ✅ Helius API metadata');
        console.log('  ✅ External JSON metadata');
        console.log('  ✅ DexScreener data');
        console.log('  ✅ WebSocket message simulation');
        process.exit(1);
    }
    
    const debuggerMetadata = new TokenMetadataDebugger();
    
    try {
        await debuggerMetadata.debugToken(tokenAddress, expectedTwitterUrl);
        
    } catch (error) {
        console.error('❌ Debug failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = TokenMetadataDebugger;