// scripts/checkIPFSMetadata.js - Check the IPFS metadata file
const axios = require('axios');

async function checkIPFSMetadata() {
    // The CORRECT IPFS URI from your token metadata
    const ipfsUri = 'https://ipfs.io/ipfs/QmV65dRqrHq8NsgeZvGxiZLFoCxHQwMY3EYt1LTJGjXoqd';
    
    console.log('🔍 CHECKING IPFS METADATA FILE');
    console.log('='.repeat(50));
    console.log(`📁 IPFS URI: ${ipfsUri}`);
    
    // Try multiple IPFS gateways in case one is down
    const gateways = [
        'https://ipfs.io/ipfs/QmV65dRqrHq8NsgeZvGxiZLFoCxHQwMY3EYt1LTJGjXoqd',
        'https://gateway.pinata.cloud/ipfs/QmV65dRqrHq8NsgeZvGxiZLFoCxHQwMY3EYt1LTJGjXoqd',
        'https://cloudflare-ipfs.com/ipfs/QmV65dRqrHq8NsgeZvGxiZLFoCxHQwMY3EYt1LTJGjXoqd',
        'https://dweb.link/ipfs/QmV65dRqrHq8NsgeZvGxiZLFoCxHQwMY3EYt1LTJGjXoqd'
    ];
    
    for (const gateway of gateways) {
        try {
            console.log(`\n🔄 Trying gateway: ${gateway}`);
            
            const response = await axios.get(gateway, { 
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; TokenBot/1.0)',
                    'Accept': 'application/json, text/plain, */*'
                }
            });
            
            console.log('✅ IPFS file loaded successfully!');
            console.log('\n📊 COMPLETE METADATA:');
            console.log(JSON.stringify(response.data, null, 2));
            
            // Look for Twitter URLs in ALL fields recursively
            const dataString = JSON.stringify(response.data);
            console.log('\n🔍 SEARCHING FOR TWITTER URLs...');
            console.log(`📝 Full JSON string: ${dataString}`);
            
            const twitterPatterns = [
                /https?:\/\/(www\.)?(twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/\d+/gi,
                /(twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/\d+/gi,
                /twitter/gi,
                /x\.com/gi
            ];
            
            let foundTwitter = false;
            twitterPatterns.forEach((pattern, index) => {
                const matches = dataString.match(pattern);
                if (matches) {
                    console.log(`\n🐦 PATTERN ${index + 1} MATCHES:`, matches);
                    foundTwitter = true;
                }
            });
            
            if (!foundTwitter) {
                console.log('\n❌ NO TWITTER URLs FOUND IN IPFS METADATA');
            }
            
            // Check ALL fields recursively
            console.log('\n🔍 DETAILED FIELD ANALYSIS:');
            function analyzeObject(obj, path = '') {
                for (const [key, value] of Object.entries(obj)) {
                    const fullPath = path ? `${path}.${key}` : key;
                    
                    if (typeof value === 'string') {
                        console.log(`   📝 ${fullPath}: "${value}"`);
                        
                        // Check for any mention of twitter/x.com
                        if (value.toLowerCase().includes('twitter') || 
                            value.toLowerCase().includes('x.com') ||
                            value.includes('status/')) {
                            console.log(`   🚨 POTENTIAL TWITTER REFERENCE: ${fullPath} = "${value}"`);
                        }
                    } else if (typeof value === 'object' && value !== null) {
                        console.log(`   📁 ${fullPath}: [object]`);
                        analyzeObject(value, fullPath);
                    } else {
                        console.log(`   📊 ${fullPath}: ${value} (${typeof value})`);
                    }
                }
            }
            
            analyzeObject(response.data);
            
            return response.data; // Success - return data
            
        } catch (error) {
            console.log(`❌ Gateway failed: ${error.message}`);
            
            if (error.response) {
                console.log(`   Status: ${error.response.status}`);
                console.log(`   Headers:`, error.response.headers);
            }
        }
    }
    
    console.log('\n💥 ALL IPFS GATEWAYS FAILED');
    console.log('🔍 This might mean:');
    console.log('   • IPFS file doesn\'t exist');
    console.log('   • IPFS network issues'); 
    console.log('   • Wrong IPFS hash');
    console.log('   • File is private/restricted');
}

checkIPFSMetadata();