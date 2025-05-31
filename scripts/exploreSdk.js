// scripts/exploreSdk.js - Discover what's available in PumpSwap SDK
require('dotenv').config();

function explorePumpSwapSDK() {
    console.log('🔍 EXPLORING PUMPSWAP SDK EXPORTS');
    console.log('='.repeat(50));
    
    try {
        // Try to import the entire module
        const pumpSdk = require('@pump-fun/pump-swap-sdk');
        
        console.log('✅ PumpSwap SDK imported successfully!');
        console.log('\n📦 Available exports:');
        
        // List all exports
        const exports = Object.keys(pumpSdk);
        exports.forEach((key, index) => {
            const value = pumpSdk[key];
            const type = typeof value;
            console.log(`   ${index + 1}. ${key} (${type})`);
            
            // If it's a class or constructor, try to get more info
            if (type === 'function' && value.name) {
                console.log(`      └─ Constructor: ${value.name}`);
            }
            
            // If it's an object, show its keys
            if (type === 'object' && value !== null) {
                const objectKeys = Object.keys(value);
                if (objectKeys.length > 0 && objectKeys.length < 10) {
                    console.log(`      └─ Properties: ${objectKeys.join(', ')}`);
                } else if (objectKeys.length > 0) {
                    console.log(`      └─ Properties: ${objectKeys.length} items`);
                }
            }
        });
        
        console.log('\n🔍 Looking for Direction enum...');
        
        // Check for Direction specifically
        if (pumpSdk.Direction) {
            console.log('✅ Direction found!');
            console.log('Direction values:', pumpSdk.Direction);
            
            if (typeof pumpSdk.Direction === 'object') {
                const directionKeys = Object.keys(pumpSdk.Direction);
                console.log('Direction options:', directionKeys);
                directionKeys.forEach(key => {
                    console.log(`   • ${key}: ${pumpSdk.Direction[key]}`);
                });
            }
        } else {
            console.log('❌ Direction not found in main exports');
            
            // Check if it's nested somewhere
            exports.forEach(key => {
                const value = pumpSdk[key];
                if (typeof value === 'object' && value !== null) {
                    if (value.Direction) {
                        console.log(`✅ Found Direction in ${key}.Direction!`);
                        console.log(`${key}.Direction:`, value.Direction);
                    }
                }
            });
        }
        
        console.log('\n🎯 Checking SDK method signatures...');
        
        // Check if PumpAmmSdk exists and its methods
        if (pumpSdk.PumpAmmSdk) {
            console.log('✅ PumpAmmSdk found');
            
            try {
                const { Connection } = require('@solana/web3.js');
                const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
                const sdk = new pumpSdk.PumpAmmSdk(connection);
                
                console.log('✅ PumpAmmSdk instance created');
                console.log('Available methods:');
                
                const prototype = Object.getOwnPropertyNames(Object.getPrototypeOf(sdk));
                prototype.forEach((method, index) => {
                    if (method !== 'constructor' && !method.startsWith('_')) {
                        console.log(`   ${index + 1}. ${method}`);
                    }
                });
                
                // Check specific swap methods
                const swapMethods = [
                    'swapAutocompleteBaseFromQuote',
                    'swapAutocompleteQuoteFromBase',
                    'swapInstructions'
                ];
                
                console.log('\n🔄 Swap methods analysis:');
                swapMethods.forEach(method => {
                    if (typeof sdk[method] === 'function') {
                        console.log(`   ✅ ${method} - available`);
                        
                        // Try to get method signature (this might not work perfectly)
                        const methodStr = sdk[method].toString();
                        const paramMatch = methodStr.match(/\(([^)]*)\)/);
                        if (paramMatch) {
                            console.log(`      Parameters: ${paramMatch[1] || 'none'}`);
                        }
                    } else {
                        console.log(`   ❌ ${method} - not found`);
                    }
                });
                
            } catch (error) {
                console.log('❌ Failed to create PumpAmmSdk instance:', error.message);
            }
        } else {
            console.log('❌ PumpAmmSdk not found');
        }
        
        console.log('\n📋 IMPORT RECOMMENDATIONS:');
        console.log('Based on what we found, try these imports:');
        
        if (pumpSdk.PumpAmmSdk && pumpSdk.Direction) {
            console.log('const { PumpAmmSdk, Direction } = require(\'@pump-fun/pump-swap-sdk\');');
        } else if (pumpSdk.PumpAmmSdk) {
            console.log('const { PumpAmmSdk } = require(\'@pump-fun/pump-swap-sdk\');');
            console.log('// Direction enum not found - might need different approach');
        }
        
        // Check default export
        if (typeof pumpSdk.default === 'function') {
            console.log('// Or try default import:');
            console.log('const PumpAmmSdk = require(\'@pump-fun/pump-swap-sdk\').default;');
        }
        
    } catch (error) {
        console.log('❌ Failed to import PumpSwap SDK:', error.message);
        console.log('Make sure the package is installed: npm install @pump-fun/pump-swap-sdk');
    }
}

// Also check the actual package.json and node_modules
function checkInstallation() {
    console.log('\n🔍 CHECKING INSTALLATION');
    console.log('='.repeat(30));
    
    try {
        const fs = require('fs');
        const path = require('path');
        
        // Check if package is in node_modules
        const packagePath = path.join(process.cwd(), 'node_modules', '@pump-fun', 'pump-swap-sdk');
        
        if (fs.existsSync(packagePath)) {
            console.log('✅ Package found in node_modules');
            
            // Try to read package.json
            const packageJsonPath = path.join(packagePath, 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                console.log(`📦 Package version: ${packageJson.version}`);
                console.log(`📝 Description: ${packageJson.description || 'N/A'}`);
                
                if (packageJson.main) {
                    console.log(`📄 Main entry: ${packageJson.main}`);
                }
                
                if (packageJson.exports) {
                    console.log('📤 Exports:', packageJson.exports);
                }
            }
            
            // Check what files are available
            const files = fs.readdirSync(packagePath);
            console.log('📁 Package contents:', files.slice(0, 10).join(', '));
            
        } else {
            console.log('❌ Package not found in node_modules');
            console.log('Run: npm install @pump-fun/pump-swap-sdk');
        }
        
    } catch (error) {
        console.log('❌ Installation check failed:', error.message);
    }
}

// Main function
function main() {
    console.log('🚀 PUMPSWAP SDK INVESTIGATION');
    console.log('='.repeat(60));
    
    checkInstallation();
    explorePumpSwapSDK();
    
    console.log('\n' + '='.repeat(60));
    console.log('💡 This should help us understand how to properly use the SDK!');
}

if (require.main === module) {
    main();
}

module.exports = { explorePumpSwapSDK, checkInstallation };