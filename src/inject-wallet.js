/**
 * StripChain Bot — Wallet Injection Approach
 * 
 * Injects an ethers.js wallet as window.ethereum provider
 * so the StripChain app can connect without MetaMask extension.
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
for (const d of [DATA_DIR, LOGS_DIR]) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

const SEQUENCER = process.env.SEQUENCER_URL || 'https://seq.stripchain.xyz';
const ARB_SEPOLIA_CHAIN_ID = 421614;
const ARB_SEPOLIA_RPC = 'https://sepolia-rollup.arbitrum.io/rpc';

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  writeFileSync(join(LOGS_DIR, `stripchain-inject-${new Date().toISOString().slice(0, 10)}.log`), line + '\n', { flag: 'a' });
}

function loadWallet() {
  const walletsFile = join(ROOT, 'wallets.txt');
  const keys = readFileSync(walletsFile, 'utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const pk = keys[0].startsWith('0x') ? keys[0] : `0x${keys[0]}`;
  return new ethers.Wallet(pk);
}

// EIP-1193 provider injection script
function getInjectScript(address, privateKey, chainId) {
  return `
    (() => {
      // Minimal EIP-1193 provider
      const addr = "${address.toLowerCase()}";
      const pk = "${privateKey}";
      const chainId = ${chainId};
      
      const ethereum = {
        isMetaMask: true,
        chainId: "0x" + chainId.toString(16),
        networkVersion: chainId.toString(),
        selectedAddress: addr,
        
        request: async ({ method, params }) => {
          console.log("[InjectedProvider]", method, params);
          
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [addr];
            
            case "eth_chainId":
              return "0x" + chainId.toString(16);
            
            case "net_version":
              return chainId.toString();
            
            case "wallet_switchEthereumChain":
              return null;
            
            case "wallet_addEthereumChain":
              return null;
            
            case "personal_sign":
            case "eth_sign": {
              // params: [message, address]
              const msg = params[0];
              // We need ethers.js to sign — inject via page context
              const sig = await window.__stripSignMessage(msg);
              return sig;
            }
            
            case "eth_sendTransaction": {
              const tx = params[0];
              const sig = await window.__stripSendTransaction(tx);
              return sig;
            }
            
            case "eth_getBalance":
              // Delegate to real RPC
              const res = await fetch("${ARB_SEPOLIA_RPC}", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [params[0], params[1] || "latest"], id: 1 })
              });
              return (await res.json()).result;
            
            case "eth_getTransactionCount":
              const res2 = await fetch("${ARB_SEPOLIA_RPC}", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [params[0], params[1] || "latest"], id: 2 })
              });
              return (await res2.json()).result;
            
            case "eth_estimateGas":
              const res3 = await fetch("${ARB_SEPOLIA_RPC}", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "eth_estimateGas", params: params, id: 3 })
              });
              return (await res3.json()).result;
            
            case "eth_gasPrice":
              const res4 = await fetch("${ARB_SEPOLIA_RPC}", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 4 })
              });
              return (await res4.json()).result;
            
            case "eth_blockNumber":
              const res5 = await fetch("${ARB_SEPOLIA_RPC}", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 5 })
              });
              return (await res5.json()).result;
            
            case "eth_getTransactionReceipt":
              const res6 = await fetch("${ARB_SEPOLIA_RPC}", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionReceipt", params: params, id: 6 })
              });
              return (await res6.json()).result;
            
            case "eth_getCode":
              const res7 = await fetch("${ARB_SEPOLIA_RPC}", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getCode", params: params, id: 7 })
              });
              return (await res7.json()).result;
            
            case "eth_call":
              const res8 = await fetch("${ARB_SEPOLIA_RPC}", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: params, id: 8 })
              });
              return (await res8.json()).result;
            
            case "eth_blockNumber":
              return "0x1";
            
            default:
              console.warn("[InjectedProvider] Unhandled method:", method);
              throw new Error("Method not supported: " + method);
          }
        },
        
        on: () => {},
        removeListener: () => {},
        emit: () => {},
      };
      
      window.ethereum = ethereum;
      window.web3 = { currentProvider: ethereum };
      window.__stripChainId = chainId;
      window.__stripRpcUrl = "";  // Will be set later
      
      // Dispatch events to signal wallet is available
      window.dispatchEvent(new Event("ethereum#initialized"));
      
      console.log("[InjectedProvider] Wallet injected:", addr);
    })();
  `;
}

async function main() {
  const wallet = loadWallet();
  log(`Wallet: ${wallet.address}`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Intercept RPC calls to Arbitrum Sepolia
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    // Let all requests through
    await route.continue();
  });

  // Inject wallet BEFORE page loads
  await page.addInitScript(getInjectScript(wallet.address, wallet.privateKey, ARB_SEPOLIA_CHAIN_ID));

  // Also inject ethers.js signMessage handler
  await page.addInitScript(`
    window.__stripSignMessage = async (msg) => {
      // This will be overridden by the page.evaluate below
      return "__PENDING__";
    };
    window.__stripSendTransaction = async (tx) => {
      return "__PENDING__";
    };
  `);

  log('Navigating to StripChain...');
  await page.goto('https://home.stripchain.xyz', { timeout: 60000 });
  await page.waitForTimeout(3000);

  // Now inject the real signing functions via script tag (ethers CDN)
  await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js' });
  await page.waitForTimeout(2000);
  
  await page.evaluate(({ pk, rpcUrl, chainId }) => {
    window.__stripRpcUrl = rpcUrl;
    window.__stripChainId = chainId;
    window.__stripSignMessage = async (msg) => {
      try {
        const wallet = new ethers.Wallet(pk);
        let message;
        if (typeof msg === 'string' && msg.startsWith('0x')) {
          message = ethers.getBytes(msg);
        } else {
          message = msg;
        }
        const sig = await wallet.signMessage(message);
        console.log("[SignMessage]", typeof msg === 'string' ? msg.slice(0, 50) : 'bytes', "→", sig.slice(0, 20));
        return sig;
      } catch (e) {
        console.error("[SignMessage Error]", e.message);
        throw e;
      }
    };
    
    window.__stripSendTransaction = async (tx) => {
      try {
        const provider = new ethers.JsonRpcProvider(window.__stripRpcUrl);
        const wallet = new ethers.Wallet(pk, provider);
        const txResponse = await wallet.sendTransaction({
          to: tx.to,
          value: tx.value ? BigInt(tx.value) : 0n,
          data: tx.data || "0x",
          gasLimit: tx.gas ? BigInt(tx.gas) : undefined,
          gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
          chainId: window.__stripChainId,
        });
        console.log("[SendTX]", txResponse.hash);
        return txResponse.hash;
      } catch (e) {
        console.error("[SendTX Error]", e.message);
        throw e;
      }
    };
    
    console.log("[Injected] Signing functions ready for", "${wallet.address}");
  }, { pk: wallet.privateKey, rpcUrl: ARB_SEPOLIA_RPC, chainId: ARB_SEPOLIA_CHAIN_ID });

  log('Wallet injected. Checking page state...');
  
  // Take screenshot
  const ss1 = join(LOGS_DIR, `inject-${Date.now()}.png`);
  await page.screenshot({ path: ss1, fullPage: true });
  log(`Screenshot: ${ss1}`);

  // Check if Connect Wallet button is gone (meaning wallet connected)
  const connectBtn = await page.locator('button:has-text("Connect Wallet")').isVisible();
  log(`Connect Wallet visible: ${connectBtn}`);

  // Try clicking Connect Wallet if still visible
  if (connectBtn) {
    log('Clicking Connect Wallet...');
    await page.locator('button:has-text("Connect Wallet")').click();
    await page.waitForTimeout(1000);

    // Select Ethereum
    const ethBtn = page.locator('button:has-text("Ethereum")');
    if (await ethBtn.isVisible()) {
      await ethBtn.click();
      log('Selected Ethereum wallet');
      await page.waitForTimeout(3000);
    }
  }

  // Screenshot after connection attempt
  const ss2 = join(LOGS_DIR, `inject-connected-${Date.now()}.png`);
  await page.screenshot({ path: ss2, fullPage: true });
  log(`Screenshot after connect: ${ss2}`);

  // Check page content
  const content = await page.textContent('body');
  log(`Page content (first 500): ${content?.slice(0, 500)}`);

  // Listen for console messages
  page.on('console', msg => {
    if (msg.text().includes('[InjectedProvider]') || msg.text().includes('[SignMessage]')) {
      log(`Console: ${msg.text()}`);
    }
  });

  // Navigate to mint page
  log('Navigating to /mint...');
  await page.goto('https://home.stripchain.xyz/mint', { timeout: 60000 });
  await page.waitForTimeout(3000);

  const ss3 = join(LOGS_DIR, `inject-mint-${Date.now()}.png`);
  await page.screenshot({ path: ss3, fullPage: true });
  log(`Mint page screenshot: ${ss3}`);

  // Get mint page elements
  const mintElements = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim());
    const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, placeholder: i.placeholder, value: i.value }));
    const selects = Array.from(document.querySelectorAll('select, [role="combobox"]')).map(s => s.textContent?.trim());
    return { buttons, inputs, selects };
  });
  log(`Mint elements: ${JSON.stringify(mintElements)}`);

  // Keep browser open
  log('Browser open. Waiting for manual interaction if needed...');
  
  // Wait 60s for observation
  await page.waitForTimeout(60000);
}

main().catch(e => {
  log(`Fatal: ${e.message}`, 'ERROR');
  process.exit(1);
});
