// scripts/diagnoseNetwork.js - Comprehensive network diagnostics for Jupiter API
require('dotenv').config();
const axios = require('axios');
const dns = require('dns').promises;
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

class NetworkDiagnostics {
    constructor() {
        this.results = {
            basicConnectivity: false,
            dnsResolution: {},
            jupiterEndpoints: {},
            solanaRpc: false,
            recommendations: []
        };
    }

    async runDiagnostics() {
        console.log('🔧 COMPREHENSIVE NETWORK DIAGNOSTICS FOR JUPITER API');
        console.log('='.repeat(60));
        console.log('🕐 Started at:', new Date().toLocaleString());
        console.log('');

        try {
            await this.testBasicConnectivity();
            await this.testDnsResolution();
            await this.testJupiterEndpoints();
            await this.testSolanaRpc();
            await this.testSystemNetworking();
            
            this.generateReport();
            
        } catch (error) {
            console.error('❌ Diagnostics failed:', error.message);
        }
    }

    async testBasicConnectivity() {
        console.log('🌐 1. TESTING BASIC INTERNET CONNECTIVITY');
        console.log('-'.repeat(40));

        const testSites = [
            'https://www.google.com',
            'https://cloudflare.com',
            'https://httpbin.org/ip',
            'https://api.github.com'
        ];

        for (const site of testSites) {
            try {
                const startTime = Date.now();
                const response = await axios.get(site, { 
                    timeout: 5000,
                    validateStatus: () => true // Accept any status
                });
                const duration = Date.now() - startTime;
                
                console.log(`✅ ${site}: ${response.status} (${duration}ms)`);
                this.results.basicConnectivity = true;
                
            } catch (error) {
                console.log(`❌ ${site}: ${error.code || error.message}`);
                
                if (error.code === 'ENOTFOUND') {
                    this.results.recommendations.push('DNS resolution issues detected');
                } else if (error.code === 'ETIMEDOUT') {
                    this.results.recommendations.push('Network timeout issues detected');
                }
            }
        }
        
        console.log('');
    }

    async testDnsResolution() {
        console.log('🔍 2. TESTING DNS RESOLUTION');
        console.log('-'.repeat(30));

        const domains = [
            'price.jup.ag',
            'quote-api.jup.ag',
            'jup.ag',
            'api.mainnet-beta.solana.com',
            'google.com'
        ];

        for (const domain of domains) {
            try {
                const startTime = Date.now();
                const result = await dns.lookup(domain);
                const duration = Date.now() - startTime;
                
                console.log(`✅ ${domain}: ${result.address} (${duration}ms)`);
                this.results.dnsResolution[domain] = {
                    success: true,
                    address: result.address,
                    duration: duration
                };
                
            } catch (error) {
                console.log(`❌ ${domain}: ${error.code || error.message}`);
                this.results.dnsResolution[domain] = {
                    success: false,
                    error: error.message
                };
                
                if (domain.includes('jup.ag')) {
                    this.results.recommendations.push(`DNS resolution failed for ${domain} - try alternative DNS servers`);
                }
            }
        }
        
        console.log('');
    }

    async testJupiterEndpoints() {
        console.log('🪐 3. TESTING JUPITER API ENDPOINTS');
        console.log('-'.repeat(35));

        const endpoints = [
            {
                name: 'Price API (SOL)',
                url: 'https://price.jup.ag/v6/price?ids=So11111111111111111111111111111111111111112'
            },
            {
                name: 'Price API (USDC)',
                url: 'https://price.jup.ag/v6/price?ids=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
            },
            {
                name: 'Quote API',
                url: 'https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50'
            },
            {
                name: 'Main Website',
                url: 'https://jup.ag'
            }
        ];

        for (const endpoint of endpoints) {
            try {
                console.log(`🔍 Testing: ${endpoint.name}`);
                
                const startTime = Date.now();
                const response = await axios.get(endpoint.url, {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; NetworkDiagnostics/1.0)',
                        'Accept': 'application/json'
                    }
                });
                const duration = Date.now() - startTime;
                
                console.log(`✅ ${endpoint.name}: ${response.status} (${duration}ms)`);
                console.log(`   📊 Response size: ${JSON.stringify(response.data).length} bytes`);
                
                if (response.data && typeof response.data === 'object') {
                    const keys = Object.keys(response.data);
                    console.log(`   🔑 Response keys: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}`);
                }
                
                this.results.jupiterEndpoints[endpoint.name] = {
                    success: true,
                    status: response.status,
                    duration: duration,
                    dataSize: JSON.stringify(response.data).length
                };
                
            } catch (error) {
                console.log(`❌ ${endpoint.name}: ${error.message}`);
                console.log(`   🔗 URL: ${endpoint.url}`);
                
                if (error.response) {
                    console.log(`   📝 HTTP Status: ${error.response.status}`);
                    console.log(`   📝 Status Text: ${error.response.statusText}`);
                }
                
                if (error.code) {
                    console.log(`   📝 Error Code: ${error.code}`);
                }
                
                this.results.jupiterEndpoints[endpoint.name] = {
                    success: false,
                    error: error.message,
                    code: error.code,
                    status: error.response?.status
                };
                
                // Specific recommendations
                if (error.code === 'ENOTFOUND') {
                    this.results.recommendations.push('Jupiter API domains cannot be resolved - check DNS settings');
                } else if (error.code === 'ECONNREFUSED') {
                    this.results.recommendations.push('Jupiter API refusing connections - might be down or blocked');
                } else if (error.response?.status === 429) {
                    this.results.recommendations.push('Rate limited by Jupiter API - implement retry logic');
                } else if (error.response?.status >= 500) {
                    this.results.recommendations.push('Jupiter API server errors - try again later');
                }
            }
            
            console.log('');
        }
    }

    async testSolanaRpc() {
        console.log('⛓️  4. TESTING SOLANA RPC CONNECTIVITY');
        console.log('-'.repeat(35));

        const rpcEndpoints = [
            process.env.HELIUS_RPC_URL,
            process.env.SOLANA_RPC_URL,
            'https://api.mainnet-beta.solana.com',
            'https://solana-api.projectserum.com'
        ].filter(Boolean);

        for (const rpc of rpcEndpoints) {
            try {
                console.log(`🔍 Testing: ${rpc.replace(/\?.*/, '?[API_KEY]')}`);
                
                const startTime = Date.now();
                const response = await axios.post(rpc, {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getBlockHeight'
                }, {
                    timeout: 10000,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                const duration = Date.now() - startTime;
                
                if (response.data?.result) {
                    console.log(`✅ RPC Working: Block ${response.data.result} (${duration}ms)`);
                    this.results.solanaRpc = true;
                } else {
                    console.log(`⚠️  Unexpected response:`, response.data);
                }
                
            } catch (error) {
                console.log(`❌ RPC Failed: ${error.message}`);
                
                if (error.code === 'ENOTFOUND') {
                    this.results.recommendations.push('Solana RPC DNS resolution failed');
                }
            }
        }
        
        console.log('');
    }

    async testSystemNetworking() {
        console.log('💻 5. TESTING SYSTEM NETWORKING');
        console.log('-'.repeat(30));

        try {
            // Test ping to Jupiter domains
            const domains = ['jup.ag', 'google.com'];
            
            for (const domain of domains) {
                try {
                    console.log(`🏓 Pinging ${domain}...`);
                    
                    // Different ping command for different OS
                    const isWindows = process.platform === 'win32';
                    const pingCmd = isWindows ? `ping -n 4 ${domain}` : `ping -c 4 ${domain}`;
                    
                    const { stdout, stderr } = await execAsync(pingCmd);
                    
                    if (stdout.includes('time=') || stdout.includes('Average')) {
                        console.log(`✅ ${domain}: Ping successful`);
                        
                        // Extract ping time if possible
                        const timeMatch = stdout.match(/time[=<](\d+\.?\d*)ms/);
                        if (timeMatch) {
                            console.log(`   ⏱️  Average ping: ${timeMatch[1]}ms`);
                        }
                    } else {
                        console.log(`⚠️  ${domain}: Ping completed but no time data`);
                    }
                    
                } catch (pingError) {
                    console.log(`❌ ${domain}: Ping failed - ${pingError.message}`);
                }
            }
            
        } catch (error) {
            console.log(`⚠️  System networking test failed: ${error.message}`);
        }
        
        // Test network configuration
        try {
            console.log('\n🔧 Network Configuration:');
            
            // Get network interfaces (if available)
            const os = require('os');
            const interfaces = os.networkInterfaces();
            
            let activeInterfaces = 0;
            for (const [name, addrs] of Object.entries(interfaces)) {
                const ipv4 = addrs.find(addr => addr.family === 'IPv4' && !addr.internal);
                if (ipv4) {
                    console.log(`   📡 ${name}: ${ipv4.address}`);
                    activeInterfaces++;
                }
            }
            
            if (activeInterfaces === 0) {
                console.log(`⚠️  No active network interfaces found`);
                this.results.recommendations.push('No active network interfaces detected');
            }
            
        } catch (error) {
            console.log(`⚠️  Could not check network configuration: ${error.message}`);
        }
        
        console.log('');
    }

    generateReport() {
        console.log('📋 DIAGNOSTIC REPORT');
        console.log('='.repeat(20));
        
        console.log('\n📊 Results Summary:');
        console.log(`   🌐 Basic Connectivity: ${this.results.basicConnectivity ? '✅ Working' : '❌ Failed'}`);
        console.log(`   🔍 DNS Resolution: ${Object.values(this.results.dnsResolution).some(r => r.success) ? '✅ Partial/Working' : '❌ Failed'}`);
        console.log(`   🪐 Jupiter APIs: ${Object.values(this.results.jupiterEndpoints).some(r => r.success) ? '✅ Partial/Working' : '❌ Failed'}`);
        console.log(`   ⛓️  Solana RPC: ${this.results.solanaRpc ? '✅ Working' : '❌ Failed'}`);
        
        // Detailed DNS results
        console.log('\n🔍 DNS Resolution Details:');
        for (const [domain, result] of Object.entries(this.results.dnsResolution)) {
            if (result.success) {
                console.log(`   ✅ ${domain}: ${result.address} (${result.duration}ms)`);
            } else {
                console.log(`   ❌ ${domain}: ${result.error}`);
            }
        }
        
        // Detailed Jupiter results
        console.log('\n🪐 Jupiter API Details:');
        for (const [endpoint, result] of Object.entries(this.results.jupiterEndpoints)) {
            if (result.success) {
                console.log(`   ✅ ${endpoint}: ${result.status} (${result.duration}ms, ${result.dataSize} bytes)`);
            } else {
                console.log(`   ❌ ${endpoint}: ${result.error} ${result.code ? `(${result.code})` : ''}`);
            }
        }
        
        // Recommendations
        if (this.results.recommendations.length > 0) {
            console.log('\n💡 RECOMMENDATIONS:');
            this.results.recommendations.forEach((rec, index) => {
                console.log(`   ${index + 1}. ${rec}`);
            });
        }
        
        // Specific solutions
        console.log('\n🔧 TROUBLESHOOTING STEPS:');
        
        const jupiterWorking = Object.values(this.results.jupiterEndpoints).some(r => r.success);
        const dnsWorking = Object.values(this.results.dnsResolution).some(r => r.success);
        
        if (!this.results.basicConnectivity) {
            console.log('   1. ❌ No internet connection detected');
            console.log('      • Check your network cable/Wi-Fi');
            console.log('      • Restart your router/modem');
            console.log('      • Contact your ISP');
        } else if (!dnsWorking) {
            console.log('   1. ❌ DNS resolution problems');
            console.log('      • Change DNS servers to 8.8.8.8 and 1.1.1.1');
            console.log('      • Flush DNS cache (ipconfig /flushdns on Windows)');
            console.log('      • Check router DNS settings');
        } else if (!jupiterWorking) {
            console.log('   1. ❌ Jupiter API access blocked');
            console.log('      • Disable VPN/proxy temporarily');
            console.log('      • Check firewall/antivirus settings');
            console.log('      • Try different network (mobile hotspot)');
            console.log('      • Jupiter API might be temporarily down');
        } else {
            console.log('   1. ✅ Network looks good!');
            console.log('      • All major services are accessible');
            console.log('      • Jupiter API is responding');
            console.log('      • Your trading bot should work');
        }
        
        console.log('\n🕐 Completed at:', new Date().toLocaleString());
        console.log('');
        
        if (jupiterWorking) {
            console.log('🎉 GOOD NEWS: Jupiter API is accessible!');
            console.log('    Your trading bot should work with real Jupiter prices.');
            console.log('    Try running: node scripts/testFixedPositionsReal.js');
        } else {
            console.log('⚠️  ISSUE: Jupiter API is not accessible');
            console.log('    Follow the troubleshooting steps above.');
            console.log('    You can still test the logic with mock prices.');
        }
    }
}

// CLI usage
async function main() {
    console.log('🚀 Starting comprehensive network diagnostics...\n');
    
    const diagnostics = new NetworkDiagnostics();
    await diagnostics.runDiagnostics();
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = NetworkDiagnostics;