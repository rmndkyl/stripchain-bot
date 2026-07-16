/**
 * StripChain Testnet Bot
 * 
 * Flow: Connect wallet → Generate addresses → Deposit → Mint synthetics → Bridge → Convert
 * 
 * API Endpoints (from JS bundle reverse-engineering):
 * - GET  /getBridgeAddress       → bridge deposit addresses per chain
 * - POST /createIntent           → submit signed intent (mint/burn/swap/bridge)
 * - GET  /getIntent?id=xxx       → poll intent status
 * - POST /oauth/sign             → Google OAuth sign
 * - POST /oauth/verifySignature  → verify signature
 * 
 * Supported chains: ETHEREUM, SOLANA, BITCOIN, SUI, ARBITRUM, APTOS, ALGORAND, etc.
 * Operation types: SEND_TO_BRIDGE, BRIDGE_DEPOSIT, SWAP, BURN, BURN_SYNTHETIC, WITHDRAW, TRANSACTION
 * 
 * Chain ID: 421614 (Arbitrum Sepolia) - coordination chain
 */

import { chromium } from 'playwright';
import { ethers } from 'ethers';
import { config } from 'dotenv';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const LOGS_DIR = join(ROOT, 'logs');

// Ensure dirs exist
for (const d of [DATA_DIR, LOGS_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

const SEQUENCER = process.env.SEQUENCER_URL || 'https://seq.stripchain.xyz';
const ARB_SEPOLIA_CHAIN_ID = 421614;
const ARB_SEPOLIA_RPC = process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';

// Synthetic token addresses on Arbitrum Sepolia (from JS bundle)
const SYNTHETIC_TOKENS = {
  sBTC:  { address: '0x2916Bb6396914999397b9875bfe2A947e9923f10', decimals: 8 },
  sDOGE: { address: '0x9B5D0E7B1dED96B026a08Deb0337411F0837230c', decimals: 8 },
  sDOT:  { address: '0x6e309b16E1988a05dc207625F7a083561984D361', decimals: 10 },
  sETH:  { address: '0x219FDf442...', decimals: 18 }, // need full address
  sSOL:  { address: '0x...', decimals: 9 },
  sSUI:  { address: '0x...', decimals: 9 },
  sAPT:  { address: '0x...', decimals: 8 },
  sBERA: { address: '0xAB4de60eB0235979B2892312Eb0415bCd9D9f435', decimals: 18 },
};

// ========== LOGGING ==========
function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  const logFile = join(LOGS_DIR, `stripchain-${new Date().toISOString().slice(0, 10)}.log`);
  writeFileSync(logFile, line + '\n', { flag: 'a' });
}

// ========== SEQUENCER API ==========
async function getBridgeAddress() {
  const res = await fetch(`${SEQUENCER}/getBridgeAddress`);
  if (!res.ok) throw new Error(`getBridgeAddress failed: ${res.status}`);
  return res.json();
}

async function createIntent(signedIntent) {
  const res = await fetch(`${SEQUENCER}/createIntent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signedIntent),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`createIntent failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.id;
}

async function getIntent(intentId) {
  const res = await fetch(`${SEQUENCER}/getIntent?${new URLSearchParams({ id: intentId })}`, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`getIntent failed: ${res.status}`);
  return res.json();
}

async function pollIntent(intentId, maxWaitMs = 120000, intervalMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const intent = await getIntent(intentId);
      log(`Intent ${intentId} status: ${JSON.stringify(intent).slice(0, 200)}`);
      if (intent.status === 'COMPLETED' || intent.status === 'SUCCESS') return intent;
      if (intent.status === 'FAILED' || intent.status === 'ERROR') throw new Error(`Intent failed: ${JSON.stringify(intent)}`);
    } catch (e) {
      if (e.message.includes('Intent failed')) throw e;
      log(`Poll error (retrying): ${e.message}`, 'WARN');
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Intent ${intentId} timed out after ${maxWaitMs}ms`);
}

// ========== WALLET LOADER ==========
function loadWallets() {
  const walletsFile = join(ROOT, 'wallets.txt');
  if (!existsSync(walletsFile)) {
    log('No wallets.txt found. Create wallets.txt with one private key per line.', 'ERROR');
    process.exit(1);
  }
  const keys = readFileSync(walletsFile, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
  
  return keys.map((key, i) => {
    const pk = key.startsWith('0x') ? key : `0x${key}`;
    const wallet = new ethers.Wallet(pk);
    return { index: i + 1, address: wallet.address, privateKey: pk, wallet };
  });
}

// ========== PLAYWRIGHT AUTOMATION ==========
async function launchBrowser(headless = false) {
  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });
  return browser;
}

async function connectWalletAndOperate(walletInfo, operation = 'full-cycle') {
  const { index, address, wallet } = walletInfo;
  log(`[${index}/${address}] Starting ${operation}...`);

  const browser = await launchBrowser(false); // HEADED for wallet signing
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    // Step 1: Navigate to StripChain
    log(`[${index}] Navigating to StripChain...`);
    await page.goto('https://home.stripchain.xyz', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Step 2: Connect EVM wallet
    log(`[${index}] Connecting EVM wallet...`);
    const connectBtn = page.locator('button:has-text("Connect Wallet")');
    await connectBtn.click();
    await page.waitForTimeout(1000);

    // Select Ethereum
    const ethBtn = page.locator('button:has-text("Ethereum")');
    if (await ethBtn.isVisible()) {
      await ethBtn.click();
      await page.waitForTimeout(2000);
    }

    // Note: MetaMask popup handling would go here
    // For now, user must manually approve in MetaMask
    log(`[${index}] Waiting for wallet connection... (approve in MetaMask if popup appears)`);
    await page.waitForTimeout(5000);

    // Step 3: Check if connected - look for address display or navigation change
    const pageContent = await page.textContent('body');
    
    // Step 4: Navigate to mint page
    log(`[${index}] Navigating to mint page...`);
    // The mint route is at /mint (from lazy chunk)
    await page.goto('https://home.stripchain.xyz/mint', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Take screenshot
    const ssPath = join(LOGS_DIR, `stripchain-${index}-${Date.now()}.png`);
    await page.screenshot({ path: ssPath, fullPage: true });
    log(`[${index}] Screenshot saved: ${ssPath}`);

    // Step 5: Look for mint form elements
    const mintElements = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim());
      const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, placeholder: i.placeholder }));
      const selects = Array.from(document.querySelectorAll('select, [role="combobox"]')).map(s => s.textContent?.trim());
      return { buttons, inputs, selects, title: document.title };
    });
    log(`[${index}] Page elements: ${JSON.stringify(mintElements).slice(0, 500)}`);

    // Step 6: Get bridge info for direct API automation
    const bridgeInfo = await getBridgeAddress();
    log(`[${index}] Bridge address: ${bridgeInfo.ethereumPublicKey}`);
    log(`[${index}] BTC address derived from bridge pubkey`);

    // Save account data
    const accountData = {
      address,
      bridgeAddress: bridgeInfo.ethereumPublicKey,
      bridgeInfo,
      timestamp: new Date().toISOString(),
    };
    const accountFile = join(DATA_DIR, `account-${index}.json`);
    writeFileSync(accountFile, JSON.stringify(accountData, null, 2));
    log(`[${index}] Account data saved: ${accountFile}`);

    return accountData;
  } catch (e) {
    log(`[${index}] Error: ${e.message}`, 'ERROR');
    const ssPath = join(LOGS_DIR, `stripchain-error-${index}-${Date.now()}.png`);
    await page.screenshot({ path: ssPath }).catch(() => {});
    throw e;
  } finally {
    // Keep browser open for manual interaction
    log(`[${index}] Browser kept open. Close manually when done.`);
    // await browser.close();
  }
}

// ========== PURE API APPROACH (no browser) ==========
async function pureApiDeposit(walletInfo) {
  const { index, address, wallet } = walletInfo;
  log(`[${index}/${address}] Pure API deposit...`);

  // Get bridge info
  const bridgeInfo = await getBridgeAddress();
  const bridgeAddress = bridgeInfo.ethereumPublicKey;
  log(`[${index}] Bridge deposit address: ${bridgeAddress}`);

  // Connect to Arbitrum Sepolia
  const provider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC);
  const connectedWallet = wallet.connect(provider);

  // Check balance
  const balance = await provider.getBalance(address);
  log(`[${index}] Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    log(`[${index}] Zero balance — need testnet ETH first. Use Arbitrum Sepolia faucet.`, 'WARN');
    return null;
  }

  // Send small amount to bridge address
  const amount = ethers.parseEther('0.001'); // 0.001 ETH testnet
  log(`[${index}] Sending ${ethers.formatEther(amount)} ETH to bridge ${bridgeAddress}...`);

  const tx = await connectedWallet.sendTransaction({
    to: bridgeAddress,
    value: amount,
    chainId: ARB_SEPOLIA_CHAIN_ID,
  });
  log(`[${index}] TX sent: ${tx.hash}`);
  
  const receipt = await tx.wait();
  log(`[${index}] TX confirmed in block ${receipt.blockNumber}`);

  return { txHash: tx.hash, blockNumber: receipt.blockNumber, bridgeAddress, amount: ethers.formatEther(amount) };
}

// ========== MAIN ==========
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'info';
  
  log(`StripChain Bot started. Command: ${command}`);

  switch (command) {
    case 'info': {
      const bridgeInfo = await getBridgeAddress();
      console.log('\n=== StripChain Bridge Info ===');
      console.log(`Bridge ETH Address: ${bridgeInfo.ethereumPublicKey}`);
      console.log(`Bridge BTC Address: ${bridgeInfo.bitcoinPublicKey}`);
      console.log(`Bridge SOL Address: ${bridgeInfo.solanaPublicKey}`);
      console.log(`Bridge SUI Address: ${bridgeInfo.suiPublicKey}`);
      console.log(`Bridge Identity:    ${bridgeInfo.identity}`);
      console.log(`Signers: ${bridgeInfo.signers?.length || 0} validators`);
      
      console.log('\n=== Sequencer Endpoints ===');
      console.log(`GET  ${SEQUENCER}/getBridgeAddress`);
      console.log(`POST ${SEQUENCER}/createIntent`);
      console.log(`GET  ${SEQUENCER}/getIntent?id=xxx`);
      console.log(`POST ${SEQUENCER}/oauth/sign`);
      console.log(`POST ${SEQUENCER}/oauth/verifySignature`);
      
      console.log('\n=== Supported Chains ===');
      const chains = ['ETHEREUM', 'SOLANA', 'BITCOIN', 'SUI', 'ARBITRUM', 'APTOS', 'ALGORAND', 'DOGECOIN', 'STELLAR', 'CARDANO', 'RIPPLE', 'POLKADOT', 'SONIC', 'BERACHAIN', 'ICP'];
      chains.forEach(c => console.log(`  - ${c}`));
      
      console.log('\n=== Operation Types ===');
      ['TRANSACTION', 'SEND_TO_BRIDGE', 'BRIDGE_DEPOSIT', 'SWAP', 'BURN', 'BURN_SYNTHETIC', 'WITHDRAW'].forEach(o => console.log(`  - ${o}`));
      break;
    }

    case 'connect': {
      const wallets = loadWallets();
      log(`Loaded ${wallets.length} wallets`);
      for (const w of wallets) {
        await connectWalletAndOperate(w, 'connect');
      }
      break;
    }

    case 'deposit': {
      const wallets = loadWallets();
      log(`Loaded ${wallets.length} wallets for deposit`);
      for (const w of wallets) {
        await pureApiDeposit(w);
      }
      break;
    }

    case 'full-cycle': {
      const wallets = loadWallets();
      log(`Loaded ${wallets.length} wallets for full cycle`);
      for (const w of wallets) {
        log(`\n=== Wallet ${w.index}: ${w.address} ===`);
        
        // 1. Deposit to bridge
        const depositResult = await pureApiDeposit(w);
        if (!depositResult) {
          log(`[${w.index}] Skipping — no balance`, 'WARN');
          continue;
        }
        
        // 2. Wait for bridge to process
        log(`[${w.index}] Waiting 30s for bridge to process deposit...`);
        await new Promise(r => setTimeout(r, 30000));
        
        // 3. Browser-based mint/swap (requires wallet signing)
        await connectWalletAndOperate(w, 'mint-swap');
      }
      break;
    }

    default:
      console.log('Usage: node src/bot.js [info|connect|deposit|full-cycle]');
      console.log('  info        - Show bridge info & endpoints');
      console.log('  connect     - Connect wallets & generate addresses');
      console.log('  deposit     - Send testnet ETH to bridge (pure API)');
      console.log('  full-cycle  - Deposit + mint + bridge + convert');
  }
}

main().catch(e => {
  log(`Fatal: ${e.message}`, 'ERROR');
  process.exit(1);
});
