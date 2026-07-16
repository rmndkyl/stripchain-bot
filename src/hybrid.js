/**
 * StripChain Testnet Bot — Hybrid Approach
 * 
 * Phase 1: Pure API (automated) — deposit testnet ETH to bridge
 * Phase 2: Browser (semi-auto) — connect wallet, mint synthetics, bridge, convert
 * 
 * The deposit is the key on-chain action that can be fully automated.
 * Minting requires wallet signing via RainbowKit UI (complex to inject).
 */

import { chromium } from 'playwright';
import { ethers } from 'ethers';
import { config } from 'dotenv';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const LOGS_DIR = join(ROOT, 'logs');
for (const d of [DATA_DIR, LOGS_DIR]) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

const SEQUENCER = process.env.SEQUENCER_URL || 'https://seq.stripchain.xyz';
const ARB_SEPOLIA_CHAIN_ID = 421614;
const ARB_SEPOLIA_RPC = process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  writeFileSync(join(LOGS_DIR, `stripchain-${new Date().toISOString().slice(0, 10)}.log`), line + '\n', { flag: 'a' });
}

function loadWallets() {
  const f = join(ROOT, 'wallets.txt');
  if (!existsSync(f)) { log('No wallets.txt', 'ERROR'); process.exit(1); }
  return readFileSync(f, 'utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map((key, i) => {
    const pk = key.startsWith('0x') ? key : `0x${key}`;
    return { index: i + 1, address: new ethers.Wallet(pk).address, privateKey: pk };
  });
}

// ===== SEQUENCER API =====
async function getBridgeAddress() {
  const r = await fetch(`${SEQUENCER}/getBridgeAddress`);
  if (!r.ok) throw new Error(`getBridgeAddress: ${r.status}`);
  return r.json();
}

async function getIntent(id) {
  const r = await fetch(`${SEQUENCER}/getIntent?${new URLSearchParams({ id })}`, {
    headers: { Accept: 'application/json' }
  });
  if (!r.ok) throw new Error(`getIntent: ${r.status}`);
  return r.json();
}

async function pollIntent(id, maxMs = 120000, intervalMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const intent = await getIntent(id);
      log(`Intent ${id}: ${JSON.stringify(intent).slice(0, 200)}`);
      if (intent.status === 'COMPLETED' || intent.status === 'SUCCESS') return intent;
      if (intent.status === 'FAILED' || intent.status === 'ERROR') throw new Error(`Intent failed: ${JSON.stringify(intent)}`);
    } catch (e) {
      if (e.message.includes('Intent failed')) throw e;
      log(`Poll retry: ${e.message}`, 'WARN');
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Intent ${id} timeout`);
}

// ===== PHASE 1: DEPOSIT (Pure API) =====
async function depositToBridge(walletInfo, amountEth = '0.001') {
  const { index, address, privateKey } = walletInfo;
  log(`[${index}/${address}] Deposit ${amountEth} ETH to bridge...`);

  const bridge = await getBridgeAddress();
  const bridgeAddr = bridge.ethereumPublicKey;
  log(`[${index}] Bridge: ${bridgeAddr}`);

  const provider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);
  const balance = await provider.getBalance(address);
  log(`[${index}] Balance: ${ethers.formatEther(balance)} ETH`);

  const amount = ethers.parseEther(amountEth);
  if (balance < amount) {
    log(`[${index}] Insufficient balance`, 'WARN');
    return null;
  }

  const tx = await wallet.sendTransaction({ to: bridgeAddr, value: amount, chainId: ARB_SEPOLIA_CHAIN_ID });
  log(`[${index}] TX: ${tx.hash}`);
  const receipt = await tx.wait();
  log(`[${index}] Confirmed block ${receipt.blockNumber}`);
  return { txHash: tx.hash, block: receipt.blockNumber, bridgeAddr, amount: amountEth };
}

// ===== PHASE 2: BROWSER (Semi-auto) =====
async function openBrowserForMint(walletAddress) {
  log(`Opening browser for wallet ${walletAddress}...`);
  log(`INSTRUCTIONS:`);
  log(`1. Browser akan terbuka ke home.stripchain.xyz`);
  log(`2. Klik "Connect Wallet" → pilih MetaMask`);
  log(`3. Approve connection di MetaMask popup`);
  log(`4. Navigate ke /mint`);
  log(`5. Pilih synthetic pair (misal sETH dari ETH)`);
  log(`6. Masukkan amount, klik mint`);
  log(`7. Sign transaction di MetaMask`);
  log(`8. Tunggu konfirmasi`);

  const browser = await chromium.launch({
    headless: false,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--start-maximized'],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  page.on('console', msg => {
    const t = msg.text();
    if (t.includes('strip') || t.includes('intent') || t.includes('bridge') || t.includes('error')) {
      log(`[Browser] ${t}`);
    }
  });

  await page.goto('https://home.stripchain.xyz', { timeout: 60000 });
  log('Page loaded. Waiting for user interaction...');

  // Take periodic screenshots
  const ssDir = LOGS_DIR;
  let ssCount = 0;
  const ssInterval = setInterval(async () => {
    try {
      ssCount++;
      const path = join(ssDir, `browser-${ssCount}-${Date.now()}.png`);
      await page.screenshot({ path });
      log(`Screenshot ${ssCount}: ${path}`);
    } catch {}
  }, 30000);

  // Wait 5 minutes for user to complete flow
  await page.waitForTimeout(300000);
  clearInterval(ssInterval);
  await browser.close();
}

// ===== MAIN =====
async function main() {
  const cmd = process.argv[2] || 'help';
  log(`Command: ${cmd}`);

  switch (cmd) {
    case 'info': {
      const b = await getBridgeAddress();
      console.log(`\n=== StripChain Bridge ===`);
      console.log(`ETH: ${b.ethereumPublicKey}`);
      console.log(`BTC: ${b.bitcoinPublicKey?.slice(0, 40)}...`);
      console.log(`SOL: ${b.solanaPublicKey}`);
      console.log(`SUI: ${b.suiPublicKey}`);
      console.log(`Signers: ${b.signers?.length}`);
      console.log(`\nSequencer: ${SEQUENCER}`);
      console.log(`Chain: Arbitrum Sepolia (${ARB_SEPOLIA_CHAIN_ID})`);
      break;
    }

    case 'deposit': {
      const wallets = loadWallets();
      for (const w of wallets) {
        const result = await depositToBridge(w);
        if (result) {
          const dataFile = join(DATA_DIR, `deposit-${w.index}.json`);
          writeFileSync(dataFile, JSON.stringify({ ...w, ...result, timestamp: new Date().toISOString() }, null, 2));
          log(`Deposit data: ${dataFile}`);
        }
      }
      break;
    }

    case 'mint': {
      // Open browser for manual minting
      const wallets = loadWallets();
      await openBrowserForMint(wallets[0].address);
      break;
    }

    case 'full-cycle': {
      const wallets = loadWallets();
      for (const w of wallets) {
        log(`\n=== Wallet ${w.index}: ${w.address} ===`);
        
        // Phase 1: Deposit
        const result = await depositToBridge(w);
        if (!result) { log(`Skip — no balance`, 'WARN'); continue; }
        
        // Wait for bridge processing
        log(`Waiting 30s for bridge to process...`);
        await new Promise(r => setTimeout(r, 30000));
        
        // Phase 2: Open browser for mint
        log(`Opening browser for mint/bridge/convert...`);
        await openBrowserForMint(w.address);
      }
      break;
    }

    default:
      console.log(`Usage: node src/hybrid.js [info|deposit|mint|full-cycle]`);
      console.log(`  info        — Bridge info & endpoints`);
      console.log(`  deposit     — Send testnet ETH to bridge (automated)`);
      console.log(`  mint        — Open browser for minting (semi-auto)`);
      console.log(`  full-cycle  — Deposit + open browser for mint`);
  }
}

main().catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });
