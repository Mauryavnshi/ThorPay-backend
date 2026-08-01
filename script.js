/* ==========================================================================
   ThorPay — app logic
   Works on both index.html (landing, wallet connect only) and app.html
   (full dashboard: balances, swap, bridge, send, history).
   Fill in / verify addresses below before relying on this for anything
   beyond testnet experimentation.
   ========================================================================== */

const CONFIG = {
  chainIdHex: "0x4CEF52",        // 5042002 decimal — Arc Testnet
  chainName: "Arc Testnet",
  rpcUrls: ["https://rpc.testnet.arc.network"],
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, // native gas display, 18 decimals
  blockExplorerUrls: ["https://testnet.arcscan.app"],

  // Verified from https://docs.arc.io/arc/references/contract-addresses (Arc Testnet only)
  USDC_ERC20: "0x3600000000000000000000000000000000000000", // 6 decimals — use this for balances/transfers
  EURC_ERC20: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",  // 6 decimals

  // cirBTC — Arc Testnet address (8 decimals, same convention as BTC).
  CIRBTC_ERC20: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",

  // Circle CCTP V2 — testnet TokenMessengerV2 / MessageTransmitterV2 are deployed at
  // the SAME address on every supported testnet (deterministic CREATE2 deployment),
  // verified against Circle's own CCTP Go SDK docs — so these two addresses work
  // unchanged no matter which of the 4 chains below is the source or destination.
  CCTP_DOMAIN_ARC: 26,
  TOKEN_MESSENGER_V2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  MESSAGE_TRANSMITTER_V2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",

  // Circle StableFX escrow (legacy path — Swap now runs through Circle App Kit instead)
  STABLEFX_ESCROW: "0x867650F5eAe8df91445971f14d89fd84F0C9a9f8",

  // Circle Iris attestation API (testnet)
  IRIS_API: "https://iris-api-sandbox.circle.com",

  // Every chain Bridge can move USDC between — any entry can be FROM, any other
  // entry can be TO (domain = Circle's CCTP domain ID for that chain). "arc" doubles
  // as the app's home/default network (balances, Swap, Send all assume Arc), so
  // Bridge always switches MetaMask back to Arc once a burn/mint finishes.
  chains: {
    arc: {
      name: "Arc Testnet", domain: 26,
      chainIdHex: "0x4CEF52",
      rpcUrls: ["https://rpc.testnet.arc.network"],
      blockExplorerUrls: ["https://testnet.arcscan.app"],
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      usdc: "0x3600000000000000000000000000000000000000"
    },
    ethSepolia: {
      name: "Ethereum Sepolia", domain: 0,
      chainIdHex: "0xaa36a7",
      rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
      blockExplorerUrls: ["https://sepolia.etherscan.io"],
      nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      // cirBTC on Sepolia — not wired into the Bridge flow yet (Bridge only moves
      // USDC through CCTP right now); kept here so it's easy to plug in later.
      cirbtc: "0x3a3fe695F684Bf9b9e43CF43C2b895Ea5e392bB3"
    },
    baseSepolia: {
      name: "Base Sepolia", domain: 6,
      chainIdHex: "0x14a34",
      rpcUrls: ["https://sepolia.base.org"],
      blockExplorerUrls: ["https://sepolia.basescan.org"],
      nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    },
    // Verified via Alchemy's docs + Arbiscan (Circle's official Arbitrum Sepolia
    // USDC deployment); CCTP domain 3 per Circle's domain registry.
    arbSepolia: {
      name: "Arbitrum Sepolia", domain: 3,
      chainIdHex: "0x66eee",
      rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
      blockExplorerUrls: ["https://sepolia.arbiscan.io"],
      nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
      usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"
    }
  }
};
// Back-compat alias — bridgeDestinations used to be Arc-only destinations;
// now it's the same 4-chain registry Bridge picks both FROM and TO from.
CONFIG.bridgeDestinations = CONFIG.chains;

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const TOKEN_MESSENGER_V2_ABI = [
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external returns (uint64 nonce)"
];

const MESSAGE_TRANSMITTER_V2_ABI = [
  "function receiveMessage(bytes message, bytes attestation) external returns (bool)"
];

let provider, signer, userAddress;
let history = [];
let latestBalances = { USDC: null, EURC: null, CIRBTC: null };
let pendingMint = null;
let pendingBurn = null; // { txHash, dest, amt } — set when attestation isn't ready yet, so "Check attestation again" can retry without re-burning

/* -------------------------------------------------------------------------
   Formatting — never show a negative balance. Values under 1 keep enough
   decimal places to still be visible instead of rounding away to "0.00".
   ------------------------------------------------------------------------- */
function formatBal(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  if (n <= 0) return "0.00";
  if (n < 1) {
    let s = n.toFixed(8).replace(/0+$/, "");
    if (s.endsWith(".")) s += "00";
    return s;
  }
  return n.toFixed(2);
}

/* -------------------------------------------------------------------------
   Amount inputs — block negative values as the person types, not just on
   submit (the min="0" HTML attribute alone doesn't stop manual typing of "-").
   ------------------------------------------------------------------------- */
["swapFromAmt", "bridgeFromAmt", "sendAmt"].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => {
    if (el.value !== "" && Number(el.value) < 0) el.value = "0";
  });
});

/* -------------------------------------------------------------------------
   Tab switching (app.html only — no-ops harmlessly if elements don't exist)
   ------------------------------------------------------------------------- */
document.querySelectorAll("[data-tab]").forEach(el => {
  el.addEventListener("click", () => {
    const tab = el.dataset.tab;
    document.querySelectorAll("nav a[data-tab]").forEach(a => a.classList.toggle("active", a.dataset.tab === tab));
    document.querySelectorAll(".tab-btn").forEach(a => a.classList.toggle("active", a.dataset.tab === tab));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    const panel = document.getElementById("panel-" + tab);
    if (panel) panel.classList.add("active");
  });
});

/* -------------------------------------------------------------------------
   Wallet connect / disconnect
   ------------------------------------------------------------------------- */
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
if (connectBtn) connectBtn.addEventListener("click", connectWallet);
if (disconnectBtn) disconnectBtn.addEventListener("click", disconnectWallet);

async function connectWallet() {
  if (!window.ethereum) {
    alert("MetaMask not found. Please install the MetaMask browser extension first.");
    return;
  }
  try {
    localStorage.removeItem("thorpay_disconnected"); // user explicitly (re)connected

    await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureArcNetwork();

    provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    signer = provider.getSigner();
    userAddress = await signer.getAddress();

    if (connectBtn) { connectBtn.innerText = userAddress.slice(0, 6) + "..." + userAddress.slice(-4); connectBtn.style.display = "inline-flex"; }
    if (disconnectBtn) disconnectBtn.style.display = "inline-flex";

    const welcome = document.getElementById("welcomeMsg");
    if (welcome) { welcome.innerText = "Welcome back"; welcome.style.color = ""; }

    ["swapBtn", "bridgeBtn", "sendBtn"].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = false;
    });
    setBtnLabel("swapBtn", "Exchange");
    setBtnLabel("bridgeBtn", "Bridge");
    setBtnLabel("sendBtn", "Send");

    await checkNetwork();
    loadHistory();
    await refreshBalances();
    await refreshDestinationBalance();
    await refreshSourceBalance();
  } catch (err) {
    console.error(err);
    alert("Wallet connection failed: " + (err.message || err));
  }
}

function disconnectWallet() {
  provider = null; signer = null; userAddress = null;
  latestBalances = { USDC: null, EURC: null, CIRBTC: null };
  pendingMint = null;
  try { localStorage.setItem("thorpay_disconnected", "1"); } catch (e) {}

  if (connectBtn) connectBtn.innerText = "Connect Wallet";
  if (disconnectBtn) disconnectBtn.style.display = "none";

  updateNetworkPill(false, false);
  const banner = document.getElementById("networkBanner");
  if (banner) banner.style.display = "none";

  // Left clickable on purpose — each button's own click handler now
  // triggers wallet connect first when nothing's connected yet, instead of
  // sitting disabled and eating the click silently.
  setBtnLabel("swapBtn", "Connect wallet to swap");
  setBtnLabel("bridgeBtn", "Connect wallet to bridge");
  setBtnLabel("sendBtn", "Connect wallet to send");
  const mintBtn = document.getElementById("bridgeMintBtn");
  if (mintBtn) mintBtn.style.display = "none";

  setText("usdcBal", "0.00"); setText("eurcBal", "0.00"); setText("totalBalance", "$0.00");
  setText("swapFromBal", "Balance: 0.00"); setText("bridgeFromBal", "Balance: 0.00"); setText("sendBal", "Balance: 0.00");
  setText("bridgeToBal", "Connect your wallet to see this balance");

  const welcome = document.getElementById("welcomeMsg");
  if (welcome) { welcome.innerText = "Welcome to ThorPay"; welcome.style.color = ""; }

  history = [];
  renderHistory();

  // Best-effort permission revoke (EIP-2255) — not every wallet supports this, ignore failures.
  if (window.ethereum && window.ethereum.request) {
    window.ethereum.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
  }
}

function setBtnLabel(id, label) {
  const btn = document.getElementById(id);
  if (btn) btn.innerText = label;
}

async function ensureArcNetwork() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CONFIG.chainIdHex }]
    });
  } catch (switchErr) {
    // Different wallets signal "chain not added yet" differently — MetaMask
    // uses error code 4902, but Rabby and others don't always match that
    // exactly. Rather than guess at every wallet's error shape, just always
    // try wallet_addEthereumChain on any switch failure: if the chain is
    // already present, wallets handle that gracefully (switch or no-op)
    // instead of erroring.
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CONFIG.chainIdHex,
        chainName: CONFIG.chainName,
        rpcUrls: CONFIG.rpcUrls,
        nativeCurrency: CONFIG.nativeCurrency,
        blockExplorerUrls: CONFIG.blockExplorerUrls
      }]
    });
  }
}

async function switchOrAddChain(dest) {
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: dest.chainIdHex }] });
  } catch (switchErr) {
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: dest.chainIdHex,
        chainName: dest.name,
        rpcUrls: dest.rpcUrls,
        nativeCurrency: dest.nativeCurrency,
        blockExplorerUrls: dest.blockExplorerUrls
      }]
    });
  }
}

/* -------------------------------------------------------------------------
   Network pill + wrong-network banner
   ------------------------------------------------------------------------- */
function updateNetworkPill(connected, correctChain) {
  const pill = document.getElementById("networkPill");
  if (pill) pill.classList.toggle("disconnected", !(connected && correctChain));
}

async function checkNetwork() {
  const banner = document.getElementById("networkBanner");
  if (!window.ethereum || !userAddress) {
    updateNetworkPill(false, false);
    if (banner) banner.style.display = "none";
    return false;
  }
  try {
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    const correct = chainId.toLowerCase() === CONFIG.chainIdHex.toLowerCase();
    updateNetworkPill(true, correct);
    if (banner) banner.style.display = correct ? "none" : "flex";
    return correct;
  } catch (e) {
    console.warn("network check failed", e);
    updateNetworkPill(true, false);
    return false;
  }
}

const switchNetworkBtn = document.getElementById("switchNetworkBtn");
if (switchNetworkBtn) {
  switchNetworkBtn.addEventListener("click", async () => {
    try {
      await ensureArcNetwork();
      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      signer = provider.getSigner();
      await checkNetwork();
      await refreshBalances();
    } catch (e) {
      console.error("switch to Arc failed", e);
    }
  });
}

/* -------------------------------------------------------------------------
   Balances — always read through the ERC-20 interface (6 decimals) per
   Arc's own guidance, rather than the native 18-decimal gas balance.

   Reads go through window.ethereum.request({method:"eth_call"}) directly —
   NOT through ethers' Web3Provider (network detection hangs on Arc's
   unlisted chain ID on some MetaMask builds) and NOT through a raw
   JsonRpcProvider fetch() (blocked by CORS on Arc's public RPC).

   The actual failure seen in testing was neither of those — it was Arc's
   public testnet RPC returning "request limit reached" (error -32011)
   when hit with several eth_call requests in a burst. Two fixes for that:
     1. Decimals are fixed for a known ERC-20 (never change), so they're
        hardcoded below instead of fetched — that alone halves the call
        count for every balance check.
     2. Calls run one at a time with a short gap, and retry with backoff
        specifically on a rate-limit response, instead of firing every
        token's balance check simultaneously.
   ------------------------------------------------------------------------- */
const ERC20_IFACE = new ethers.utils.Interface(ERC20_ABI);
const TOKEN_DECIMALS = {
  [CONFIG.USDC_ERC20.toLowerCase()]: 6,
  [CONFIG.EURC_ERC20.toLowerCase()]: 6
};
if (CONFIG.CIRBTC_ERC20) TOKEN_DECIMALS[CONFIG.CIRBTC_ERC20.toLowerCase()] = 8;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isRateLimitError(err) {
  const msg = ((err && err.message) || String(err)).toLowerCase();
  return err?.code === -32011 || msg.includes("request limit") || msg.includes("rate limit") || msg.includes("too many requests");
}

async function ethCallViaWallet(tokenAddress, fnName, args = [], attempt = 0) {
  const data = ERC20_IFACE.encodeFunctionData(fnName, args);
  try {
    const result = await window.ethereum.request({
      method: "eth_call",
      params: [{ to: tokenAddress, data }, "latest"]
    });
    return ERC20_IFACE.decodeFunctionResult(fnName, result)[0];
  } catch (err) {
    if (isRateLimitError(err) && attempt < 3) {
      await sleep(600 * (attempt + 1)); // 600ms, 1200ms, 1800ms backoff
      return ethCallViaWallet(tokenAddress, fnName, args, attempt + 1);
    }
    throw err;
  }
}

async function tokenBalance(tokenAddress) {
  const decimals = TOKEN_DECIMALS[tokenAddress.toLowerCase()] ?? 6;
  const raw = await ethCallViaWallet(tokenAddress, "balanceOf", [userAddress]);
  return Number(ethers.utils.formatUnits(raw, decimals));
}

async function readOnlyBalance(rpcUrl, tokenAddress, address) {
  const ro = new ethers.providers.JsonRpcProvider(rpcUrl);
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, ro);
  const [raw, decimals] = await Promise.all([c.balanceOf(address), c.decimals()]);
  return Number(ethers.utils.formatUnits(raw, decimals));
}

async function refreshBalances() {
  if (!provider || !userAddress) return;

  // One at a time, with a small gap — avoids bursting Arc's public RPC
  // rate limit the way Promise.all's simultaneous requests did.
  let usdc = null, eurc = null, usdcErr = null, eurcErr = null;
  try { usdc = await tokenBalance(CONFIG.USDC_ERC20); } catch (e) { usdcErr = e; console.error("USDC balance fetch failed", e); }
  await sleep(150);
  try { eurc = await tokenBalance(CONFIG.EURC_ERC20); } catch (e) { eurcErr = e; console.error("EURC balance fetch failed", e); }

  latestBalances.USDC = usdc;
  latestBalances.EURC = eurc;

  setText("usdcBal", formatBal(usdc));
  setText("eurcBal", formatBal(eurc));
  setText("totalBalance", "$" + formatBal(Math.max(0, (usdc || 0) + (eurc || 0))));
  setText("bridgeFromBal", "Balance: " + formatBal(usdc));
  setText("sendBal", "Balance: " + formatBal(document.getElementById("sendToken")?.value === "EURC" ? eurc : usdc));

  const welcome = document.getElementById("welcomeMsg");
  if (usdc === null || eurc === null) {
    const reason = usdcErr || eurcErr;
    const reasonMsg = reason ? (reason.message || String(reason)).slice(0, 140) : "unknown error";
    if (welcome) {
      welcome.innerText = "Couldn't load balance — " + reasonMsg;
      welcome.style.color = "var(--red)";
    }
  } else if (welcome) {
    welcome.innerText = "Welcome back";
    welcome.style.color = "";
  }

  // cirBTC — only wired up once Arc publishes a public contract address.
  if (CONFIG.CIRBTC_ERC20) {
    await sleep(150);
    try {
      const cirbtc = await tokenBalance(CONFIG.CIRBTC_ERC20);
      latestBalances.CIRBTC = cirbtc;
      setText("cirbtcBal", formatBal(cirbtc));
      document.getElementById("cirbtcBal")?.classList.remove("disabled");
      setText("cirbtcSub", "Arc Testnet");
    } catch (e) {
      console.error("cirBTC balance fetch failed", e);
    }
  }

  // Swap panel's "Balance: ..." lines (both From and To sides) — depend on
  // whichever token is currently selected in each dropdown (USDC / EURC /
  // cirBTC), so they have to be refreshed here once every balance has been
  // fetched, same as they're refreshed below whenever either dropdown changes.
  updateSwapFromBal();
  updateSwapToBal();

  document.dispatchEvent(new CustomEvent("thorpay:balances"));
}

function updateSwapFromBal() {
  const sel = document.getElementById("swapFromToken");
  const sym = sel ? sel.value : "USDC";
  setText("swapFromBal", "Balance: " + formatBal(latestBalances[sym]));
}
function updateSwapToBal() {
  const sel = document.getElementById("swapToToken");
  const sym = sel ? sel.value : "EURC";
  setText("swapToBal", "Balance: " + formatBal(latestBalances[sym]));
}
const swapFromTokenSel = document.getElementById("swapFromToken");
if (swapFromTokenSel) swapFromTokenSel.addEventListener("change", updateSwapFromBal);
const swapToTokenSel = document.getElementById("swapToToken");
if (swapToTokenSel) swapToTokenSel.addEventListener("change", updateSwapToBal);

async function refreshSourceBalance() {
  const chainSel = document.getElementById("bridgeFromChain");
  const el = document.getElementById("bridgeFromBal");
  if (!chainSel || !el) return;
  const src = CONFIG.chains[chainSel.value];
  if (!src) return;
  if (!userAddress) { el.innerText = "Connect your wallet to see this balance"; return; }
  // Read-only RPC lookup, same approach as the destination balance — no
  // need to actually switch MetaMask's network just to preview a balance;
  // that only happens once you click Bridge.
  try {
    el.innerText = "Checking " + src.name + " balance…";
    const bal = await readOnlyBalance(src.rpcUrls[0], src.usdc, userAddress);
    el.innerText = "Balance: " + formatBal(bal) + " USDC on " + src.name;
  } catch (e) {
    console.error("source balance fetch failed", e);
    el.innerText = "Couldn't load " + src.name + " balance right now";
  }
}

function populateToOptions() {
  const fromSel = document.getElementById("bridgeFromChain");
  const toSel = document.getElementById("bridgeToChain");
  if (!fromSel || !toSel) return;
  const fromKey = fromSel.value;
  const previousTo = toSel.value;
  toSel.innerHTML = "";
  Object.keys(CONFIG.chains).forEach(key => {
    if (key === fromKey) return;
    const opt = document.createElement("option");
    opt.value = key;
    opt.innerText = CONFIG.chains[key].name;
    toSel.appendChild(opt);
  });
  // Keep the previous TO selection if it's still a valid (non-FROM) option,
  // otherwise fall back to the first one left in the list.
  const stillValid = Array.from(toSel.options).some(o => o.value === previousTo);
  toSel.value = stillValid ? previousTo : toSel.options[0].value;
}

const bridgeFromChainSel = document.getElementById("bridgeFromChain");
if (bridgeFromChainSel) {
  bridgeFromChainSel.addEventListener("change", () => {
    populateToOptions();
    refreshSourceBalance();
    refreshDestinationBalance();
  });
}
populateToOptions();

async function refreshDestinationBalance() {
  const chainSel = document.getElementById("bridgeToChain");
  const el = document.getElementById("bridgeToBal");
  if (!chainSel || !el) return;
  const dest = CONFIG.chains[chainSel.value];
  if (!dest) return;
  if (!userAddress) { el.innerText = "Connect your wallet to see this balance"; return; }
  try {
    el.innerText = "Checking " + dest.name + " balance…";
    const bal = await readOnlyBalance(dest.rpcUrls[0], dest.usdc, userAddress);
    el.innerText = "Balance on " + dest.name + ": " + formatBal(bal) + " USDC";
  } catch (e) {
    console.error("destination balance fetch failed", e);
    el.innerText = "Couldn't load " + dest.name + " balance right now";
  }
}
const bridgeToChainSel = document.getElementById("bridgeToChain");
if (bridgeToChainSel) bridgeToChainSel.addEventListener("change", refreshDestinationBalance);

/* -------------------------------------------------------------------------
   Bridge TO-amount preview — CCTP V2 here always runs with maxFee=0
   (standard transfer), so the minted amount on the destination chain is
   exactly equal to what's burned on Arc. Mirror it live as the person types
   instead of leaving the disabled TO field stuck at its placeholder.
   ------------------------------------------------------------------------- */
const bridgeFromAmtEl = document.getElementById("bridgeFromAmt");
const bridgeToAmtEl = document.getElementById("bridgeToAmt");
if (bridgeFromAmtEl && bridgeToAmtEl) {
  bridgeFromAmtEl.addEventListener("input", () => {
    const v = bridgeFromAmtEl.value;
    bridgeToAmtEl.value = (v && Number(v) > 0) ? v : "";
  });
}

function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.innerText = txt;
}

/* -------------------------------------------------------------------------
   Percentage quick-fill buttons — uses the balance of whatever token is
   actually selected in that panel (was always USDC before, even on Send
   with EURC selected).
   ------------------------------------------------------------------------- */
document.querySelectorAll(".pct span").forEach(el => {
  el.addEventListener("click", () => {
    if (!userAddress) return;
    const panel = el.closest(".panel").id;
    let sym = "USDC";
    if (panel === "panel-send") sym = document.getElementById("sendToken")?.value || "USDC";
    const full = latestBalances[sym];
    if (full === null || full === undefined) return;
    const pct = Number(el.dataset.pct) / 100;
    const val = (full * pct).toFixed(6);
    if (panel === "panel-swap") {
      setValue("swapFromAmt", val);
      document.getElementById("swapFromAmt")?.dispatchEvent(new Event("input"));
    }
    if (panel === "panel-send") setValue("sendAmt", val);
  });
});

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

/* -------------------------------------------------------------------------
   Swap flip
   ------------------------------------------------------------------------- */
const swapFlip = document.getElementById("swapFlip");
if (swapFlip) {
  swapFlip.addEventListener("click", () => {
    const a = document.getElementById("swapFromToken");
    const b = document.getElementById("swapToToken");
    const tmp = a.value; a.value = b.value; b.value = tmp;
    a.dispatchEvent(new Event("change"));
    b.dispatchEvent(new Event("change"));
  });
}

/* -------------------------------------------------------------------------
   Swap — real execution lives in the ES module script at the bottom of
   app.html (Circle App Kit SDK via esm.sh, needs `type="module"`). This
   file stays a classic script for browser compatibility with the rest
   of the app, and exposes the bits that module script needs below via
   window.ThorPay.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   Bridge (CCTP V2) — real burn on Arc Testnet, real attestation check, and
   a one-click mint on the destination chain (testnet TokenMessengerV2 /
   MessageTransmitterV2 share the same address across chains, verified
   against Circle's CCTP Go SDK docs, so this is safe to automate).
   ------------------------------------------------------------------------- */
const bridgeBtn = document.getElementById("bridgeBtn");
if (bridgeBtn) {
  bridgeBtn.addEventListener("click", async () => {
    const statusEl = document.getElementById("bridgeStatus");
    const progressEl = document.getElementById("bridgeProgress");
    if (!signer) {
      try {
        statusEl.className = "status"; statusEl.innerText = "Connecting wallet\u2026";
        await connectWallet();
      } catch (err) {
        statusEl.className = "status err"; statusEl.innerText = "Wallet connection failed: " + (err.message || err);
        return;
      }
      if (!signer) { statusEl.className = "status err"; statusEl.innerText = "Connect your wallet first."; return; }
    }

    const amt = document.getElementById("bridgeFromAmt").value;
    if (!amt || Number(amt) <= 0) { statusEl.className = "status err"; statusEl.innerText = "Enter an amount."; return; }

    const fromKey = document.getElementById("bridgeFromChain").value;
    const fromChain = CONFIG.chains[fromKey];
    const destKey = document.getElementById("bridgeToChain").value;
    const dest = CONFIG.chains[destKey];
    if (fromKey === destKey) { statusEl.className = "status err"; statusEl.innerText = "Pick two different chains."; return; }

    try {
      bridgeBtn.disabled = true;
      progressEl.style.display = "block";
      document.getElementById("bridgeMintBtn").style.display = "none";
      document.getElementById("bridgeRetryBtn").style.display = "none";
      pendingMint = null;
      pendingBurn = null;

      statusEl.className = "status"; statusEl.innerText = "Switching MetaMask to " + fromChain.name + "\u2026";
      progressEl.innerText = "Switching networks\u2026";
      await switchOrAddChain(fromChain);
      // Wallet is now on fromChain — rebuild provider/signer against it,
      // same pattern the mint step already uses when it switches to TO.
      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      signer = provider.getSigner();

      const usdc = new ethers.Contract(fromChain.usdc, ERC20_ABI, signer);
      const decimals = await usdc.decimals();
      const amountUnits = ethers.utils.parseUnits(amt, decimals);

      const liveBalance = await usdc.balanceOf(userAddress);
      if (liveBalance.lt(amountUnits)) {
        throw new Error("Insufficient balance. You have " + formatBal(Number(ethers.utils.formatUnits(liveBalance, decimals))) + " USDC on " + fromChain.name + ".");
      }

      statusEl.innerText = "Step 1/3 \u2014 approving USDC\u2026";
      progressEl.innerText = "Approving TokenMessengerV2 to spend USDC on " + fromChain.name + "...";
      const approveTx = await usdc.approve(CONFIG.TOKEN_MESSENGER_V2, amountUnits);
      await approveTx.wait();

      statusEl.innerText = "Step 2/3 \u2014 burning USDC on " + fromChain.name + "\u2026";
      progressEl.innerText = "Approved. Submitting depositForBurn...";
      const messenger = new ethers.Contract(CONFIG.TOKEN_MESSENGER_V2, TOKEN_MESSENGER_V2_ABI, signer);
      const mintRecipient = ethers.utils.hexZeroPad(userAddress, 32); // sending to yourself on destination by default
      const destinationCaller = ethers.utils.hexZeroPad("0x0000000000000000000000000000000000000000", 32); // anyone can mint
      const maxFee = 0; // standard transfer, no fast-transfer fee
      const minFinalityThreshold = 2000; // standard finality

      const burnTx = await messenger.depositForBurn(
        amountUnits, dest.domain, mintRecipient, fromChain.usdc,
        destinationCaller, maxFee, minFinalityThreshold
      );
      const burnReceipt = await burnTx.wait();

      statusEl.innerText = "Step 3/3 \u2014 waiting for Circle's attestation\u2026";
      progressEl.innerText = "Burned. Tx: " + burnReceipt.transactionHash + "\nPolling Iris API for attestation...";

      const attestation = await pollAttestation(burnReceipt.transactionHash, fromChain.domain);

      if (attestation && attestation.message && attestation.attestation) {
        pendingMint = { message: attestation.message, attestation: attestation.attestation, dest };
        statusEl.className = "status ok";
        statusEl.innerText = "Burn confirmed and attested! Click below to finish minting on " + dest.name + ".";
        progressEl.innerText =
          "Burn tx: " + burnReceipt.transactionHash + "\n" +
          "Attestation ready. Your USDC hasn't arrived on " + dest.name + " yet — click " +
          "\"Complete mint on destination chain\" below to finish (this will briefly switch MetaMask to " + dest.name + ").";
        document.getElementById("bridgeMintBtn").style.display = "block";
        pendingBurn = null;
        document.getElementById("bridgeRetryBtn").style.display = "none";
      } else {
        pendingBurn = { txHash: burnReceipt.transactionHash, dest, sourceDomain: fromChain.domain };
        statusEl.className = "status err";
        statusEl.innerText = "Burned on " + fromChain.name + " — attestation isn't ready yet. Your USDC hasn't left " + fromChain.name + ", nothing is lost. Click \"Check attestation again\" below in a minute.";
        progressEl.innerText =
          "Burn tx: " + burnReceipt.transactionHash + "\n" +
          "Circle's attestation can take a few minutes on testnet — use the button below to check again, " +
          "no need to redo the burn.";
        document.getElementById("bridgeRetryBtn").style.display = "block";
      }

      addHistory("BRIDGE", amt + " USDC: " + fromChain.name + " \u2192 " + dest.name, burnReceipt.transactionHash);

      // Back to Arc so the rest of the app (Swap/Send/balances) keeps
      // working normally while the person waits on attestation/mint.
      if (fromKey !== "arc") {
        await ensureArcNetwork();
        provider = new ethers.providers.Web3Provider(window.ethereum, "any");
        signer = provider.getSigner();
        await checkNetwork();
      }
      await refreshBalances();
      await refreshSourceBalance();
    } catch (err) {
      console.error(err);
      statusEl.className = "status err";
      statusEl.innerText = "Error: " + (err.message || err);
      // Best-effort: still try to land back on Arc even after a failure,
      // so the person isn't stuck mid-switch on an unfamiliar network.
      if (fromKey !== "arc") {
        try {
          await ensureArcNetwork();
          provider = new ethers.providers.Web3Provider(window.ethereum, "any");
          signer = provider.getSigner();
          await checkNetwork();
        } catch (e2) { console.warn("couldn't switch back to Arc after error", e2); }
      }
    } finally {
      bridgeBtn.disabled = false;
    }
  });
}

const bridgeRetryBtn = document.getElementById("bridgeRetryBtn");
if (bridgeRetryBtn) {
  bridgeRetryBtn.addEventListener("click", async () => {
    if (!pendingBurn) return;
    const statusEl = document.getElementById("bridgeStatus");
    const progressEl = document.getElementById("bridgeProgress");
    bridgeRetryBtn.disabled = true;
    statusEl.className = "status"; statusEl.innerText = "Checking attestation again...";
    try {
      const attestation = await pollAttestation(pendingBurn.txHash, pendingBurn.sourceDomain, 3, 4000);
      if (attestation && attestation.message && attestation.attestation) {
        pendingMint = { message: attestation.message, attestation: attestation.attestation, dest: pendingBurn.dest };
        statusEl.className = "status ok";
        statusEl.innerText = "Attestation ready! Click below to finish minting on " + pendingBurn.dest.name + ".";
        document.getElementById("bridgeMintBtn").style.display = "block";
        bridgeRetryBtn.style.display = "none";
        pendingBurn = null;
      } else {
        statusEl.className = "status err";
        statusEl.innerText = "Still not ready — Circle's testnet attestation can take a few minutes. Try again shortly.";
      }
    } catch (err) {
      console.error(err);
      statusEl.className = "status err";
      statusEl.innerText = "Check failed: " + (err.message || err);
    } finally {
      bridgeRetryBtn.disabled = false;
    }
  });
}

const bridgeMintBtn = document.getElementById("bridgeMintBtn");
if (bridgeMintBtn) {
  bridgeMintBtn.addEventListener("click", async () => {
    if (!pendingMint) return;
    const statusEl = document.getElementById("bridgeStatus");
    const progressEl = document.getElementById("bridgeProgress");
    bridgeMintBtn.disabled = true;

    try {
      statusEl.className = "status"; statusEl.innerText = "Switching MetaMask to " + pendingMint.dest.name + "...";
      await switchOrAddChain(pendingMint.dest);

      const destProvider = new ethers.providers.Web3Provider(window.ethereum, "any");
      const destSigner = destProvider.getSigner();
      const transmitter = new ethers.Contract(CONFIG.MESSAGE_TRANSMITTER_V2, MESSAGE_TRANSMITTER_V2_ABI, destSigner);

      statusEl.innerText = "Minting on " + pendingMint.dest.name + "...";
      const tx = await transmitter.receiveMessage(pendingMint.message, pendingMint.attestation);
      const receipt = await tx.wait();

      statusEl.className = "status ok";
      statusEl.innerText = "Minted on " + pendingMint.dest.name + "! Tx: " + receipt.transactionHash;
      progressEl.innerText = "Mint confirmed: " + receipt.transactionHash;
      addHistory("BRIDGE-MINT", "Minted on " + pendingMint.dest.name, receipt.transactionHash);

      await refreshDestinationBalance();

      // Switch back to Arc so the rest of the app keeps working normally.
      await ensureArcNetwork();
      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      signer = provider.getSigner();
      await checkNetwork();
      await refreshBalances();

      pendingMint = null;
      bridgeMintBtn.style.display = "none";
    } catch (err) {
      console.error(err);
      statusEl.className = "status err";
      statusEl.innerText = "Mint failed: " + (err.message || err);
    } finally {
      bridgeMintBtn.disabled = false;
    }
  });
}

async function pollAttestation(txHash, sourceDomain, attempts = 15, delayMs = 8000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const url = `${CONFIG.IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const msg = data && data.messages && data.messages[0];
        if (msg && msg.attestation && msg.attestation !== "PENDING") {
          return msg;
        }
      }
    } catch (e) {
      console.warn("attestation poll failed", e);
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

/* -------------------------------------------------------------------------
   Send — real ERC-20 transfer (USDC or EURC) through the ERC-20 interface.
   ------------------------------------------------------------------------- */
const sendBtn = document.getElementById("sendBtn");
const sendTokenSel = document.getElementById("sendToken");
if (sendTokenSel) sendTokenSel.addEventListener("change", () => {
  setText("sendBal", "Balance: " + formatBal(latestBalances[sendTokenSel.value]));
});

if (sendBtn) {
  sendBtn.addEventListener("click", async () => {
    const statusEl = document.getElementById("sendStatus");
    if (!signer) {
      try {
        statusEl.className = "status"; statusEl.innerText = "Connecting wallet\u2026";
        await connectWallet();
      } catch (err) {
        statusEl.className = "status err"; statusEl.innerText = "Wallet connection failed: " + (err.message || err);
        return;
      }
      if (!signer) { statusEl.className = "status err"; statusEl.innerText = "Connect your wallet first."; return; }
    }

    const to = document.getElementById("sendTo").value.trim();
    const amt = document.getElementById("sendAmt").value;
    const tokenSymbol = document.getElementById("sendToken").value;

    if (!ethers.utils.isAddress(to)) { statusEl.className = "status err"; statusEl.innerText = "Enter a valid address."; return; }
    if (!amt || Number(amt) <= 0) { statusEl.className = "status err"; statusEl.innerText = "Enter an amount."; return; }

    const available = latestBalances[tokenSymbol];
    if (available !== null && Number(amt) > available) {
      statusEl.className = "status err";
      statusEl.innerText = "Insufficient balance. You have " + formatBal(available) + " " + tokenSymbol + " available.";
      return;
    }

    const tokenAddress = tokenSymbol === "USDC" ? CONFIG.USDC_ERC20 : CONFIG.EURC_ERC20;

    try {
      statusEl.className = "status"; statusEl.innerText = "Waiting for MetaMask confirmation...";
      const c = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
      const decimals = await c.decimals();
      const tx = await c.transfer(to, ethers.utils.parseUnits(amt, decimals));
      await tx.wait();

      statusEl.className = "status ok"; statusEl.innerText = "Sent! Tx: " + tx.hash;
      addHistory("SEND", amt + " " + tokenSymbol + " → " + to.slice(0, 6) + "..." + to.slice(-4), tx.hash);
      await refreshBalances();
    } catch (err) {
      console.error(err);
      statusEl.className = "status err"; statusEl.innerText = "Error: " + (err.message || err);
    }
  });
}

/* -------------------------------------------------------------------------
   History — persisted per-wallet-address in localStorage, so it survives
   disconnect → reconnect (and page reloads), not just the current session.
   ------------------------------------------------------------------------- */
function historyKey(addr) { return "thorpay_history_" + addr.toLowerCase(); }

function loadHistory() {
  if (!userAddress) { history = []; renderHistory(); return; }
  try {
    const raw = localStorage.getItem(historyKey(userAddress));
    history = raw ? JSON.parse(raw) : [];
  } catch (e) {
    history = [];
  }
  renderHistory();
}

function addHistory(type, desc, txHash) {
  history.unshift({ type, desc, txHash, time: new Date().toLocaleString() });
  history = history.slice(0, 50);
  if (userAddress) {
    try { localStorage.setItem(historyKey(userAddress), JSON.stringify(history)); } catch (e) { console.warn("history save failed", e); }
  }
  renderHistory();
}

function renderHistory() {
  const el = document.getElementById("historyList");
  if (!el) return;
  if (!userAddress) {
    el.innerHTML = '<div class="status">Connect your wallet to see your history.</div>';
    return;
  }
  if (history.length === 0) {
    el.innerHTML = '<div class="status">No transactions yet for this wallet.</div>';
    return;
  }
  el.innerHTML = history.map(h => `
    <div class="hist-item">
      <div class="htype ${h.type}">${h.type}</div>
      <div class="hamt">${h.desc}</div>
      <div style="color:var(--muted);font-size:11px;margin-top:4px;">${h.time}</div>
      <a href="${CONFIG.blockExplorerUrls[0]}/tx/${h.txHash}" target="_blank">View on explorer</a>
    </div>
  `).join("");
}

/* -------------------------------------------------------------------------
   React to account/network changes — updates state in place instead of
   reloading the page, so an in-flight balance fetch never gets cut off.
   ------------------------------------------------------------------------- */
if (window.ethereum) {
  window.ethereum.on("accountsChanged", async (accounts) => {
    if (!accounts || accounts.length === 0) {
      disconnectWallet();
      return;
    }
    provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    signer = provider.getSigner();
    userAddress = accounts[0];
    if (connectBtn) connectBtn.innerText = userAddress.slice(0, 6) + "..." + userAddress.slice(-4);
    loadHistory();
    await checkNetwork();
    await refreshBalances();
    await refreshDestinationBalance();
    await refreshSourceBalance();
  });

  window.ethereum.on("chainChanged", async () => {
    if (!userAddress) return; // not connected yet — nothing to update
    provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    signer = provider.getSigner();
    const correct = await checkNetwork();
    if (correct) await refreshBalances();
  });
}

/* -------------------------------------------------------------------------
   Auto-reconnect on load — if MetaMask is already authorized for this site
   and the user hasn't explicitly disconnected, silently restore the
   connection and load balances without a second click. eth_accounts
   (unlike eth_requestAccounts) never prompts, so this is safe to call on
   every page load.
   ------------------------------------------------------------------------- */
(async function autoReconnect() {
  if (!window.ethereum || !connectBtn) return;
  if (localStorage.getItem("thorpay_disconnected") === "1") return;
  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (accounts && accounts.length > 0) {
      await connectWallet();
    }
  } catch (e) {
    console.warn("auto-reconnect skipped", e);
  }
})();

/* -------------------------------------------------------------------------
   Expose wallet state + shared helpers for the App Kit swap module script
   in app.html (that script is type="module" and can't reliably see this
   classic script's top-level let/const bindings, so it reads window.ThorPay
   instead).
   ------------------------------------------------------------------------- */
window.ThorPay = {
  getUserAddress: () => userAddress,
  getSigner: () => signer,
  connectWallet,
  getBalance: (symbol) => latestBalances[symbol] ?? null,
  formatBal,
  refreshBalances,
  addHistory,
  getGasPrice: async () => {
    const hex = await window.ethereum.request({ method: "eth_gasPrice" });
    return ethers.BigNumber.from(hex);
  },
  nativeDecimals: CONFIG.nativeCurrency.decimals,
  explorerTxUrl: (txHash) => CONFIG.blockExplorerUrls[0] + "/tx/" + txHash
};
