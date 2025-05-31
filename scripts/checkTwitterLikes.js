// scripts/checkTwitterLikes.js - Standalone Twitter like checker for debugging
require('dotenv').config();
const axios = require('axios');
const logger = require('../src/utils/logger');

class TwitterLikeChecker {
    constructor() {
        this.httpClient = axios.create({
            timeout: 10000, // 10 second timeout
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
    }

    // Extract tweet ID from various Twitter URL formats
    extractTweetId(url) {
        console.log(`🔍 Extracting tweet ID from: ${url}`);
        
        // Handle different URL formats
        const patterns = [
            /status\/(\d+)/,           // Standard: /status/123456
            /\/(\d+)$/,               // Sometimes just ends with ID
            /twitter\.com\/.*\/(\d+)/, // Alternative format
            /x\.com\/.*\/(\d+)/       // x.com format
        ];
        
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                console.log(`✅ Tweet ID found: ${match[1]}`);
                return match[1];
            }
        }
        
        console.log(`❌ Could not extract tweet ID from URL`);
        return null;
    }

    // Method 1: Twitter Syndication API (used by your bot)
    async checkLikesMethod1(twitterUrl) {
        const startTime = Date.now();
        try {
            console.log(`\n🔍 METHOD 1: Twitter Syndication API`);
            
            const tweetId = this.extractTweetId(twitterUrl);
            if (!tweetId) {
                throw new Error('Could not extract tweet ID');
            }

            const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=a`;
            console.log(`📡 API URL: ${url}`);
            
            const response = await this.httpClient.get(url, {
                headers: {
                    'Referer': 'https://platform.twitter.com/',
                    'Origin': 'https://platform.twitter.com',
                    'Accept': 'application/json'
                }
            });

            const duration = Date.now() - startTime;
            console.log(`✅ Response status: ${response.status} (${duration}ms)`);
            console.log(`📊 Response data keys:`, Object.keys(response.data));
            
            // Try different possible like count fields
            const possibleFields = [
                'favorite_count',
                'favoriteCount', 
                'like_count',
                'likeCount',
                'public_metrics'
            ];
            
            let likes = 0;
            let foundField = null;
            
            for (const field of possibleFields) {
                if (response.data[field] !== undefined) {
                    if (field === 'public_metrics' && response.data[field].like_count !== undefined) {
                        likes = parseInt(response.data[field].like_count);
                        foundField = `${field}.like_count`;
                    } else {
                        likes = parseInt(response.data[field]);
                        foundField = field;
                    }
                    
                    if (likes > 0) {
                        break;
                    }
                }
            }

            console.log(`📊 Likes found: ${likes} (from field: ${foundField})`);
            console.log(`💾 Raw response preview:`, JSON.stringify(response.data, null, 2).substring(0, 500) + '...');

            return {
                success: true,
                likes: likes,
                method: 'syndication',
                foundField: foundField,
                tweetId: tweetId,
                duration: duration,
                rawData: response.data
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            console.log(`❌ Method 1 failed: ${error.message} (${duration}ms)`);
            return {
                success: false,
                likes: 0,
                method: 'syndication',
                duration: duration,
                error: error.message
            };
        }
    }

    // Method 2: Alternative approach using different endpoint
    async checkLikesMethod2(twitterUrl) {
        const startTime = Date.now();
        try {
            console.log(`\n🔍 METHOD 2: Alternative API Endpoint`);
            
            const tweetId = this.extractTweetId(twitterUrl);
            if (!tweetId) {
                throw new Error('Could not extract tweet ID');
            }

            // Try different endpoint
            const url = `https://cdn.syndication.twimg.com/widgets/timelines/tweets/${tweetId}`;
            console.log(`📡 API URL: ${url}`);
            
            const response = await this.httpClient.get(url, {
                headers: {
                    'Referer': 'https://twitter.com/',
                    'Accept': 'application/json'
                }
            });

            const duration = Date.now() - startTime;
            console.log(`✅ Response status: ${response.status} (${duration}ms)`);
            console.log(`💾 Response preview:`, JSON.stringify(response.data, null, 2).substring(0, 300) + '...');

            // This endpoint might return different data structure
            let likes = 0;
            if (response.data && response.data.favorite_count) {
                likes = parseInt(response.data.favorite_count);
            }

            return {
                success: true,
                likes: likes,
                method: 'widgets',
                tweetId: tweetId,
                duration: duration,
                rawData: response.data
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            console.log(`❌ Method 2 failed: ${error.message} (${duration}ms)`);
            return {
                success: false,
                likes: 0,
                method: 'widgets',
                duration: duration,
                error: error.message
            };
        }
    }

    // Method 3: Try with different headers/approach
    async checkLikesMethod3(twitterUrl) {
        const startTime = Date.now();
        try {
            console.log(`\n🔍 METHOD 3: Enhanced Headers Approach`);
            
            const tweetId = this.extractTweetId(twitterUrl);
            if (!tweetId) {
                throw new Error('Could not extract tweet ID');
            }

            const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=a`;
            
            const response = await this.httpClient.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://platform.twitter.com/',
                    'Origin': 'https://platform.twitter.com',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'cross-site'
                }
            });

            const duration = Date.now() - startTime;
            console.log(`✅ Response status: ${response.status} (${duration}ms)`);
            
            // Check if this gives us better data
            const likes = parseInt(response.data.favorite_count || response.data.favoriteCount || response.data.like_count) || 0;

            return {
                success: true,
                likes: likes,
                method: 'enhanced_headers',
                tweetId: tweetId,
                duration: duration,
                rawData: response.data
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            console.log(`❌ Method 3 failed: ${error.message} (${duration}ms)`);
            return {
                success: false,
                likes: 0,
                method: 'enhanced_headers',
                duration: duration,
                error: error.message
            };
        }
    }

    // Method 4: Speed test with multiple rapid calls
    async speedTestMethod(twitterUrl) {
        const startTime = Date.now();
        try {
            console.log(`\n🔍 METHOD 4: Speed Test (5 rapid calls)`);
            
            const tweetId = this.extractTweetId(twitterUrl);
            if (!tweetId) {
                throw new Error('Could not extract tweet ID');
            }

            const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=a`;
            
            // Make 5 rapid calls to test caching/speed
            const calls = [];
            for (let i = 0; i < 5; i++) {
                calls.push(
                    this.httpClient.get(url, {
                        headers: {
                            'Referer': 'https://platform.twitter.com/',
                            'Origin': 'https://platform.twitter.com'
                        }
                    })
                );
            }
            
            const responses = await Promise.all(calls);
            const duration = Date.now() - startTime;
            const avgDuration = duration / 5;
            
            console.log(`⚡ 5 calls completed in ${duration}ms (avg: ${avgDuration.toFixed(1)}ms per call)`);
            
            // Use first response for data
            const likes = parseInt(responses[0].data.favorite_count || responses[0].data.favoriteCount || responses[0].data.like_count) || 0;
            
            return {
                success: true,
                likes: likes,
                method: 'speed_test',
                tweetId: tweetId,
                duration: avgDuration, // Use average for comparison
                totalDuration: duration,
                calls: 5,
                rawData: responses[0].data
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            console.log(`❌ Speed test failed: ${error.message} (${duration}ms)`);
            return {
                success: false,
                likes: 0,
                method: 'speed_test',
                duration: duration,
                error: error.message
            };
        }
    }

    // Test URL extraction from token metadata
    testUrlExtraction(tokenMetadata) {
        console.log(`\n🔍 TESTING URL EXTRACTION FROM TOKEN METADATA`);
        console.log(`📝 Token metadata:`, JSON.stringify(tokenMetadata, null, 2));
        
        const methods = [
            // Method 1: Direct twitter field
            () => {
                if (tokenMetadata.twitter) {
                    return this.findTwitterStatusUrl(tokenMetadata.twitter);
                }
                return null;
            },
            
            // Method 2: Check description field
            () => {
                if (tokenMetadata.description) {
                    return this.findTwitterStatusUrl(tokenMetadata.description);
                }
                return null;
            },
            
            // Method 3: Check name field
            () => {
                if (tokenMetadata.name) {
                    return this.findTwitterStatusUrl(tokenMetadata.name);
                }
                return null;
            },
            
            // Method 4: Check all string fields
            () => {
                for (const [key, value] of Object.entries(tokenMetadata)) {
                    if (typeof value === 'string') {
                        const url = this.findTwitterStatusUrl(value);
                        if (url) {
                            console.log(`✅ Found Twitter URL in field '${key}': ${url}`);
                            return url;
                        }
                    }
                }
                return null;
            }
        ];
        
        for (let i = 0; i < methods.length; i++) {
            console.log(`🔍 Extraction method ${i + 1}...`);
            const url = methods[i]();
            if (url) {
                console.log(`✅ Found URL: ${url}`);
                return url;
            }
        }
        
        console.log(`❌ No Twitter URL found in token metadata`);
        return null;
    }

    findTwitterStatusUrl(text) {
        if (!text || typeof text !== 'string') return null;
        
        const patterns = [
            /https?:\/\/(www\.)?(twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/\d+/g,
            /https?:\/\/(twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/\d+/g,
            /(twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/\d+/g
        ];
        
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                let url = match[0];
                if (!url.startsWith('http')) {
                    url = 'https://' + url;
                }
                return url;
            }
        }
        
        return null;
    }

    // Comprehensive test of your specific tweet
    async runComprehensiveTest(twitterUrl) {
        console.log(`🧪 COMPREHENSIVE TWITTER LIKE CHECK`);
        console.log(`=`.repeat(60));
        console.log(`🎯 Target URL: ${twitterUrl}`);
        console.log(`⏰ Time: ${new Date().toLocaleString()}`);
        console.log(`🔧 Min likes required: ${process.env.MIN_TWITTER_LIKES || 100}`);
        console.log('');

        const results = [];
        
        // Test all methods
        const methods = [
            () => this.checkLikesMethod1(twitterUrl),
            () => this.checkLikesMethod2(twitterUrl),
            () => this.checkLikesMethod3(twitterUrl),
            () => this.speedTestMethod(twitterUrl)
        ];
        
        for (let i = 0; i < methods.length; i++) {
            try {
                const result = await methods[i]();
                results.push(result);
                
                if (result.success && result.likes > 0) {
                    console.log(`✅ Method ${i + 1} SUCCESS: ${result.likes} likes (${result.duration}ms)`);
                } else {
                    console.log(`❌ Method ${i + 1} FAILED: ${result.error || 'No likes found'} (${result.duration || 'N/A'}ms)`);
                }
                
                // Wait between requests to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.log(`💥 Method ${i + 1} CRASHED: ${error.message}`);
                results.push({
                    success: false,
                    method: `method_${i + 1}`,
                    error: error.message,
                    duration: 0
                });
            }
        }

        // Summary
        console.log(`\n📊 FINAL RESULTS SUMMARY`);
        console.log(`=`.repeat(40));
        
        const successfulResults = results.filter(r => r.success && r.likes > 0);
        const minLikes = parseInt(process.env.MIN_TWITTER_LIKES) || 100;
        
        if (successfulResults.length > 0) {
            const bestResult = successfulResults.reduce((best, current) => 
                current.likes > best.likes ? current : best
            );
            
            // Find fastest successful method
            const fastestResult = successfulResults.reduce((fastest, current) => 
                current.duration < fastest.duration ? current : fastest
            );
            
            console.log(`✅ SUCCESS! Found ${bestResult.likes} likes`);
            console.log(`📈 Best method: ${bestResult.method} (${bestResult.duration}ms)`);
            console.log(`⚡ Fastest method: ${fastestResult.method} (${fastestResult.duration}ms, ${fastestResult.likes} likes)`);
            console.log(`🎯 Qualifies: ${bestResult.likes >= minLikes ? 'YES ✅' : 'NO ❌'} (need ${minLikes})`);
            
            if (bestResult.foundField) {
                console.log(`🔍 Data field: ${bestResult.foundField}`);
            }
            
            // Timing comparison
            console.log(`\n⏱️ TIMING COMPARISON:`);
            successfulResults.forEach(result => {
                if (result.method === 'speed_test') {
                    console.log(`   • ${result.method}: ${result.duration.toFixed(1)}ms avg (${result.totalDuration}ms total for ${result.calls} calls)`);
                } else {
                    console.log(`   • ${result.method}: ${result.duration}ms (${result.likes} likes)`);
                }
            });
            
            // Recommendation
            const realTimingResults = successfulResults.filter(r => r.method !== 'speed_test');
            if (realTimingResults.length > 0) {
                const fastestReal = realTimingResults.reduce((fastest, current) => 
                    current.duration < fastest.duration ? current : fastest
                );
                console.log(`\n💡 RECOMMENDATION: Use ${fastestReal.method} method (${fastestReal.duration}ms - fastest single call)`);
            }
            
            const speedTest = successfulResults.find(r => r.method === 'speed_test');
            if (speedTest) {
                console.log(`🚀 RAPID FIRE: Average ${speedTest.duration.toFixed(1)}ms when making multiple calls (connection reuse)`);
            }
            
            return bestResult;
            
        } else {
            console.log(`❌ ALL METHODS FAILED`);
            console.log(`🔍 Possible issues:`);
            console.log(`   • Tweet might be private or deleted`);
            console.log(`   • Rate limiting from Twitter`);
            console.log(`   • API endpoint changes`);
            console.log(`   • Network connectivity issues`);
            
            return null;
        }
    }

    // Production-optimized method for your trading bot
    async getOptimizedLikes(twitterUrl) {
        const startTime = Date.now();
        try {
            const tweetId = this.extractTweetId(twitterUrl);
            if (!tweetId) return 0;

            // Use the fastest, most reliable approach
            const response = await this.httpClient.get(
                `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=a`,
                {
                    timeout: 3000, // 3 second timeout
                    headers: {
                        'Referer': 'https://platform.twitter.com/',
                        'Origin': 'https://platform.twitter.com'
                    }
                }
            );

            const likes = parseInt(response.data.favorite_count) || 0;
            const duration = Date.now() - startTime;
            
            console.log(`⚡ Optimized check: ${likes} likes (${duration}ms)`);
            return likes;

        } catch (error) {
            const duration = Date.now() - startTime;
            console.log(`❌ Optimized check failed: ${error.message} (${duration}ms)`);
            return 0;
        }
    }
}

// CLI Usage
async function main() {
    const twitterUrl = process.argv[2];
    const mode = process.argv[3] || 'comprehensive';
    
    if (!twitterUrl) {
        console.log('Usage: node scripts/checkTwitterLikes.js <TWITTER_URL> [mode]');
        console.log('');
        console.log('Examples:');
        console.log('  # Comprehensive test (all methods)');
        console.log('  node scripts/checkTwitterLikes.js https://x.com/Bitcoin/status/1927884384670978065');
        console.log('');
        console.log('  # Quick test (same as your bot)');
        console.log('  node scripts/checkTwitterLikes.js https://x.com/Bitcoin/status/1927884384670978065 quick');
        console.log('');
        console.log('  # Test URL extraction');
        console.log('  node scripts/checkTwitterLikes.js test-extraction');
        console.log('');
        console.log('Modes:');
        console.log('  comprehensive (default) - Test all methods');
        console.log('  quick - Test optimized method for production');
        console.log('  optimized - Test optimized method 3 times');
        console.log('  extraction - Test URL extraction from metadata');
        process.exit(1);
    }
    
    const checker = new TwitterLikeChecker();
    
    try {
        if (twitterUrl === 'test-extraction') {
            // Test URL extraction with sample token data
            const sampleTokenData = {
                twitter: 'https://x.com/Bitcoin/status/1927884384670978065',
                description: 'Check out this cool token! https://x.com/Bitcoin/status/1927884384670978065',
                name: 'Bitcoin',
                symbol: 'BTC'
            };
            
            checker.testUrlExtraction(sampleTokenData);
            
        } else if (mode === 'quick') {
            await checker.getOptimizedLikes(twitterUrl);
            
        } else if (mode === 'optimized') {
            console.log('🚀 OPTIMIZED METHOD TEST');
            console.log('='.repeat(30));
            
            // Test the optimized method 3 times
            for (let i = 1; i <= 3; i++) {
                console.log(`\n🔄 Test ${i}/3:`);
                await checker.getOptimizedLikes(twitterUrl);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
        } else {
            await checker.runComprehensiveTest(twitterUrl);
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = TwitterLikeChecker;