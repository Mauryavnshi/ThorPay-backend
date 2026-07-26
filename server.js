/* ==========================================================================
   ThorPay Swap Relayer
   ==========================================================================
   Why this exists: Circle's App Kit requires a server-side signer (private
   key / Circle Wallets / Turnkey) to run Swap — a browser wallet adapter
   isn't supported yet (confirmed by Circle's own App Kit FAQ, July 2026,
   and by the "Failed to fetch" error ThorPay's static frontend hit trying
   to call Swap directly from the browser).

   How it works (custodial relayer pattern — this wallet's own liquidity
   does the swapping, not the user's wallet directly):
     1. User sends `amountIn` of tokenIn to this server's relayer address
        (a normal on-chain transfer, signed by the user's own MetaMask —
        this is exactly ThorPay's existing "Send" feature, just aimed at
        the relayer's address instead of a friend's).
     2. Frontend POSTs the resulting txHash to POST /api/swap.
     3. This server verifies that deposit really happened on-chain, then
        uses its OWN private key (server-side adapter, satisfying Circle's
        requirement) to swap tokenIn -> tokenOut via Circle App Kit.
     4. This server sends the swapped-out tokenOut back to the user.

   Trust model — be upfront about this with anyone using it: while funds
   are between step 1 and step 4, they're custodied by this server's
   wallet. That's normal for a relayer/facilitator pattern, but it means
   this wallet's private key and this server's integrity matter. Testnet
   only — never point this at real funds.
   ========================================================================== */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { AppKit } = require("@circle-fin/app-kit");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ARC_RPC_URL = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const MAX_SWAP_AMOUNT = Number(process.env.MAX_SWAP_AMOUNT || 50); // in tokenIn units, sane testnet default

if (!process.env.RELAYER_PRIVATE_KEY) {
  console.error("Missing RELAYER_PRIVATE_KEY in environment. See .env.example. Exiting.");
  process.exit(1);
}

app.use(cors({
  origin: (origin, cb) => {
    // allow no-origin requests (curl, server-to-server health checks) and anything in the allow-list
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error("Origin not allowed: " + origin));
  }
}));

/* -------------------------------------------------------------------------
   Token config — same verified Arc Testnet addresses as the frontend.
   ------------------------------------------------------------------------- */
const TOKENS = {
  USDC: { address: "0x3600000000000000000000000000000000000000", decimals: 6 },
  EURC: { address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", decimals: 6 },
  // Confirmed via https://docs.arc.io/app-kit/references/supported-blockchains —
  // Arc Testnet Swap officially supports exactly USDC, EURC, and cirBTC.
  CIRBTC: { address: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF", decimals: 8 }
};

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const provider = new ethers.providers.JsonRpcProvider(ARC_RPC_URL);
const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

console.log("ThorPay Swap Relayer starting.");
console.log("Relayer address (fund this with testnet USDC + EURC from https://faucet.circle.com):");
console.log("  " + relayerWallet.address);

/* -------------------------------------------------------------------------
   Circle App Kit — server-side adapter built straight from the relayer's
   private key. This is the part a browser genuinely cannot do itself.
   ------------------------------------------------------------------------- */
const kit = new AppKit();
let relayerAdapter = null;

const { createPublicClient, http } = require("viem");
let ArcTestnetChain = null;
try {
  ({ ArcTestnet: ArcTestnetChain } = require("@circle-fin/app-kit/chains"));
} catch (e) {
  console.warn("Could not load ArcTestnet chain definition from @circle-fin/app-kit/chains — falling back to App Kit's default chain resolution.", e.message);
}

async function getRelayerAdapter() {
  if (relayerAdapter) return relayerAdapter;
  const adapterModule = require("@circle-fin/adapter-viem-v2");
  // Confirmed via https://docs.arc.io/app-kit/quickstarts/swap-tokens-same-chain —
  // createViemAdapterFromPrivateKey is the official name. Falling back to
  // createAdapterFromPrivateKey just in case an older/newer package version
  // renamed it.
  const factory = adapterModule.createViemAdapterFromPrivateKey || adapterModule.createAdapterFromPrivateKey;
  if (!factory) {
    throw new Error("Could not find a private-key adapter factory in @circle-fin/adapter-viem-v2 — check the installed version's exports.");
  }
  // App Kit's own default RPC connection for Arc Testnet was throwing
  // "Network connection failed for Arc Testnet" on every swap/quote call.
  // Per https://docs.arc.io/app-kit/tutorials/adapter-setups, overriding
  // getPublicClient with our own RPC (same ARC_RPC_URL used elsewhere in
  // this file) fixes that.
  //
  // On top of that, Arc's shared public RPC (the default ARC_RPC_URL) rate
  // limits fast (JSON-RPC code -32011 "request limit reached") the moment
  // more than a couple requests land close together — every quote AND every
  // swap execution hits it. retryDelay below backs off exponentially instead
  // of hammering it again immediately. This buys headroom, but the real fix
  // for a relayer with real traffic is a dedicated RPC (free tier is enough):
  // Alchemy (https://www.alchemy.com/rpc/arc-testnet) or dRPC
  // (https://drpc.org/chainlist/arc-testnet-rpc) — then set ARC_RPC_URL to
  // that endpoint in Render's environment variables instead of the shared one.
  relayerAdapter = factory({
    privateKey: process.env.RELAYER_PRIVATE_KEY,
    getPublicClient: ({ chain }) => createPublicClient({
      chain: ArcTestnetChain || chain,
      transport: http(ARC_RPC_URL, {
        retryCount: 5,
        timeout: 20000,
        retryDelay: ({ count, error }) => {
          const isRateLimited = error && (error.code === -32011 || /request limit/i.test(String(error.message || "")));
          const base = isRateLimited ? 1500 : 300;
          return Math.min(base * 2 ** count, 15000) + Math.floor(Math.random() * 300); // exponential backoff + jitter
        }
      })
    })
  });
  return relayerAdapter;
}

/* -------------------------------------------------------------------------
   Extra retry wrapper around the two Circle App Kit calls that actually hit
   Arc's RPC end-to-end (viem's own transport retry above only covers a
   single JSON-RPC call — kit.estimateSwap/kit.swap make several in
   sequence, and Circle's own request-limit errors don't always surface
   through viem's retry path). Retries the whole call a few times with
   backoff before giving up.
   ------------------------------------------------------------------------- */
async function withRpcRetry(fn, { retries = 4, baseDelayMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isRateLimited =
        err?.code === -32011 ||
        err?.cause?.code === -32011 ||
        /request limit/i.test(String(err?.message || "")) ||
        /NETWORK_CONNECTION_FAILED/i.test(String(err?.message || ""));
      if (!isRateLimited || attempt === retries) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 400);
      console.warn(`RPC rate-limited, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/* -------------------------------------------------------------------------
   Very small in-memory + on-disk replay guard. Good enough for a testnet
   demo relayer — swap it for a real database before this ever touches
   anything with value.
   ------------------------------------------------------------------------- */
const PROCESSED_FILE = path.join(__dirname, "processed-deposits.json");
let processed = new Set();
try {
  if (fs.existsSync(PROCESSED_FILE)) {
    processed = new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8")));
  }
} catch (e) {
  console.warn("Could not read processed-deposits.json, starting fresh.", e.message);
}
function markProcessed(txHash) {
  processed.add(txHash.toLowerCase());
  try { fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processed])); } catch (e) { /* best-effort */ }
}

/* -------------------------------------------------------------------------
   Extremely light rate limiting — caps abuse of testnet liquidity, not a
   substitute for real infra-level protection.
   ------------------------------------------------------------------------- */
const requestLog = new Map(); // ip -> [timestamps]
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = 10;
  const hits = (requestLog.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now);
  requestLog.set(ip, hits);
  if (hits.length > max) return res.status(429).json({ error: "Too many requests — slow down." });
  next();
}

/* -------------------------------------------------------------------------
   GET /api/config — tells the frontend where to send deposits.
   ------------------------------------------------------------------------- */
app.get("/api/config", (req, res) => {
  res.json({
    relayerAddress: relayerWallet.address,
    tokens: TOKENS,
    maxSwapAmount: MAX_SWAP_AMOUNT
  });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

/* -------------------------------------------------------------------------
   POST /api/quote — { tokenIn, tokenOut, amountIn } -> live quote.
   Read-only, no funds move, so this alone would also fix the "Failed to
   fetch" CORS/browser issue even before anyone deposits anything.
   ------------------------------------------------------------------------- */
app.post("/api/quote", rateLimit, async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountIn } = req.body || {};
    if (!TOKENS[tokenIn] || !TOKENS[tokenOut] || tokenIn === tokenOut) {
      return res.status(400).json({ error: "Invalid tokenIn/tokenOut." });
    }
    if (!amountIn || Number(amountIn) <= 0) {
      return res.status(400).json({ error: "Invalid amountIn." });
    }

    const adapter = await getRelayerAdapter();
    const config = process.env.KIT_KEY ? { kitKey: process.env.KIT_KEY } : {};
    const estimate = await withRpcRetry(() => kit.estimateSwap({
      from: { adapter, chain: "Arc_Testnet" },
      tokenIn, tokenOut, amountIn: String(amountIn),
      config
    }));
    res.json(estimate);
  } catch (err) {
    console.error("quote failed", err);
    res.status(502).json({ error: "Quote failed: " + (err.message || String(err)) });
  }
});

/* -------------------------------------------------------------------------
   GET /api/rates — cached USD prices for USDC/EURC/cirBTC on Arc Testnet.
   Much cheaper than a full quote (no adapter/signing involved) — good for
   showing a live "≈ $X" hint under the amount fields as the user types,
   per https://docs.arc.io/app-kit/tutorials/swap/get-token-rates
   ------------------------------------------------------------------------- */
let ratesCache = { data: null, fetchedAt: 0 };
const RATES_CACHE_MS = 30 * 1000; // Circle's own cache already refreshes periodically; avoid hammering it further

app.get("/api/rates", rateLimit, async (req, res) => {
  try {
    if (ratesCache.data && Date.now() - ratesCache.fetchedAt < RATES_CACHE_MS) {
      return res.json(ratesCache.data);
    }
    const result = await kit.getTokenRates({
      chain: "Arc_Testnet",
      tokens: ["USDC", "EURC", "CIRBTC"],
      kitKey: process.env.KIT_KEY || undefined
    });
    ratesCache = { data: result, fetchedAt: Date.now() };
    res.json(result);
  } catch (err) {
    console.error("rates failed", err);
    res.status(502).json({ error: "Rates failed: " + (err.message || String(err)) });
  }
});

/* -------------------------------------------------------------------------
   POST /api/swap — { depositTxHash, tokenIn, tokenOut, amountIn, recipient }
   Verifies the deposit, runs the real swap, pays the user back.
   ------------------------------------------------------------------------- */
app.post("/api/swap", rateLimit, async (req, res) => {
  try {
    const { depositTxHash, tokenIn, tokenOut, amountIn, recipient } = req.body || {};

    if (!TOKENS[tokenIn] || !TOKENS[tokenOut] || tokenIn === tokenOut) {
      return res.status(400).json({ error: "Invalid tokenIn/tokenOut." });
    }
    if (!amountIn || Number(amountIn) <= 0 || Number(amountIn) > MAX_SWAP_AMOUNT) {
      return res.status(400).json({ error: `Amount must be between 0 and ${MAX_SWAP_AMOUNT} ${tokenIn}.` });
    }
    if (!ethers.utils.isAddress(recipient)) {
      return res.status(400).json({ error: "Invalid recipient address." });
    }
    if (!depositTxHash || !/^0x[0-9a-fA-F]{64}$/.test(depositTxHash)) {
      return res.status(400).json({ error: "Invalid depositTxHash." });
    }
    if (processed.has(depositTxHash.toLowerCase())) {
      return res.status(409).json({ error: "This deposit has already been used for a swap." });
    }

    // --- Verify the deposit actually happened on-chain ---
    const receipt = await provider.getTransactionReceipt(depositTxHash);
    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ error: "Deposit transaction not found or not confirmed yet." });
    }

    const tokenInInfo = TOKENS[tokenIn];
    const erc20Iface = new ethers.utils.Interface(ERC20_ABI);
    const expectedAmount = ethers.utils.parseUnits(String(amountIn), tokenInInfo.decimals);

    const matchingLog = receipt.logs.find(log => {
      if (log.address.toLowerCase() !== tokenInInfo.address.toLowerCase()) return false;
      try {
        const parsed = erc20Iface.parseLog(log);
        if (parsed.name !== "Transfer") return false;
        const toMatches = parsed.args.to.toLowerCase() === relayerWallet.address.toLowerCase();
        const fromMatches = parsed.args.from.toLowerCase() === recipient.toLowerCase();
        const amountMatches = parsed.args.value.gte(expectedAmount);
        return toMatches && fromMatches && amountMatches;
      } catch (e) { return false; }
    });

    if (!matchingLog) {
      return res.status(400).json({
        error: `Couldn't verify a matching ${tokenIn} deposit of at least ${amountIn} from ${recipient} to the relayer (${relayerWallet.address}) in that transaction.`
      });
    }

    // --- Run the real swap using the server-side adapter ---
    const adapter = await getRelayerAdapter();
    const config = process.env.KIT_KEY ? { kitKey: process.env.KIT_KEY } : {};
    const swapResult = await withRpcRetry(() => kit.swap({
      from: { adapter, chain: "Arc_Testnet" },
      tokenIn, tokenOut, amountIn: String(amountIn),
      config
    }));

    // --- Pay the user back in tokenOut ---
    const tokenOutInfo = TOKENS[tokenOut];
    const outAmount = swapResult.amountOut || swapResult.estimatedOutput?.amount;
    if (!outAmount) throw new Error("Swap succeeded but no output amount was returned — check relayer logs.");

    const tokenOutContract = new ethers.Contract(tokenOutInfo.address, ERC20_ABI, relayerWallet);
    const payoutTx = await tokenOutContract.transfer(recipient, ethers.utils.parseUnits(String(outAmount), tokenOutInfo.decimals));
    const payoutReceipt = await payoutTx.wait();

    markProcessed(depositTxHash);

    res.json({
      swapTxHash: swapResult.txHash,
      payoutTxHash: payoutReceipt.transactionHash,
      amountOut: outAmount
    });
  } catch (err) {
    console.error("swap failed", err);
    res.status(502).json({ error: "Swap failed: " + (err.message || String(err)) });
  }
});

app.listen(PORT, () => {
  console.log(`ThorPay Swap Relayer listening on port ${PORT}`);
});
