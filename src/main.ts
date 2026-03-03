import "./style.css";
import {
  getQuote,
  createOrder,
  getOrderStatus,
  satsToBtc,
  type QuoteResult,
} from "./garden";
import {
  initTbtc,
  createDeposit,
  detectFunding,
  initiateMinting,
  getDepositStatus,
  type TbtcDeposit,
} from "./tbtc";
import QRCode from "qrcode";

// --- Saved orders (localStorage) ---

interface SavedOrder {
  id: string;
  provider: "garden" | "tbtc";
  createdAt: string;
  depositAddress: string;
  amount?: string;
  starknetAddress: string;
  // tBTC-specific
  tbtcDepositId?: string;
  // Garden-specific
  gardenOrderId?: string;
  status: string;
}

const STORAGE_KEY = "btc-starknet-orders";

function loadOrders(): SavedOrder[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveOrder(order: SavedOrder) {
  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.id === order.id);
  if (idx >= 0) {
    orders[idx] = order;
  } else {
    orders.unshift(order);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
}

function updateOrderStatus(id: string, status: string) {
  const orders = loadOrders();
  const order = orders.find((o) => o.id === id);
  if (order) {
    order.status = status;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
  }
}

// --- Provider state ---
type Provider = "garden" | "tbtc";
let activeProvider: Provider = "garden";

// DOM elements
const errorBanner = document.getElementById("error-banner")!;

const pendingOrdersSection = document.getElementById("pending-orders")!;
const ordersList = document.getElementById("orders-list")!;

const stepForm = document.getElementById("step-form")!;
const stepQuote = document.getElementById("step-quote")!;
const stepDeposit = document.getElementById("step-deposit")!;
const stepStatus = document.getElementById("step-status")!;

const btnGarden = document.getElementById("btn-garden")!;
const btnTbtc = document.getElementById("btn-tbtc")!;
const gardenFields = document.getElementById("garden-fields")!;

const starknetAddrInput = document.getElementById("starknet-address") as HTMLInputElement;
const btcRefundInput = document.getElementById("btc-refund-address") as HTMLInputElement;
const btcAmountInput = document.getElementById("btc-amount") as HTMLInputElement;

const btnNext = document.getElementById("btn-next") as HTMLButtonElement;
const btnBackForm = document.getElementById("btn-back-form") as HTMLButtonElement;
const btnConfirm = document.getElementById("btn-confirm") as HTMLButtonElement;
const btnCopy = document.getElementById("btn-copy") as HTMLButtonElement;

const quoteInput = document.getElementById("quote-input")!;
const quoteOutput = document.getElementById("quote-output")!;

const depositAmountRow = document.getElementById("deposit-amount-row")!;
const depositAmountEl = document.getElementById("deposit-amount")!;
const depositAddrEl = document.getElementById("deposit-addr")!;
const depositStatusEl = document.getElementById("deposit-status")!;
const hintExact = document.getElementById("hint-exact")!;
const hintAny = document.getElementById("hint-any")!;
const qrCanvas = document.getElementById("qr-canvas") as HTMLCanvasElement;

const swapStatusText = document.getElementById("swap-status-text")!;
const swapSpinner = document.getElementById("swap-spinner")!;
const swapComplete = document.getElementById("swap-complete")!;
const redeemTxEl = document.getElementById("redeem-tx")!;

// State
let currentQuote: QuoteResult | null = null;
let currentTbtcDeposit: TbtcDeposit | null = null;
let currentOrderId: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// --- Step management ---

function showStep(step: HTMLElement) {
  [stepForm, stepQuote, stepDeposit, stepStatus].forEach((s) =>
    s.classList.add("hidden")
  );
  step.classList.remove("hidden");
}

// --- Error handling ---

let errorTimeout: ReturnType<typeof setTimeout> | null = null;

function showError(message: string) {
  errorBanner.textContent = message;
  errorBanner.classList.remove("hidden");
  if (errorTimeout) clearTimeout(errorTimeout);
  errorTimeout = setTimeout(() => {
    errorBanner.classList.add("hidden");
  }, 8000);
}

// --- Pending orders UI ---

function renderPendingOrders() {
  const orders = loadOrders().filter(
    (o) => o.status !== "complete" && o.status !== "refunded"
  );

  if (orders.length === 0) {
    pendingOrdersSection.classList.add("hidden");
    return;
  }

  pendingOrdersSection.classList.remove("hidden");
  ordersList.innerHTML = "";

  for (const order of orders) {
    const card = document.createElement("div");
    card.className = "order-card";
    card.innerHTML = `
      <div class="order-header">
        <span class="order-type ${order.provider === "tbtc" ? "tbtc" : ""}">${order.provider === "garden" ? "Garden WBTC" : "tBTC"}</span>
        <span class="order-id">${order.id.slice(0, 12)}…</span>
      </div>
      <div class="order-detail">${order.amount ? satsToBtc(order.amount) + " BTC → " : ""}${order.starknetAddress.slice(0, 10)}…</div>
      <div class="order-status">${order.status} · ${new Date(order.createdAt).toLocaleString()}</div>
    `;
    card.addEventListener("click", () => resumeOrder(order));
    ordersList.appendChild(card);
  }
}

async function resumeOrder(order: SavedOrder) {
  currentOrderId = order.id;

  if (order.provider === "garden" && order.gardenOrderId) {
    // Resume Garden order — go straight to status polling
    showStep(stepStatus);
    swapStatusText.textContent = "Checking order status…";
    swapSpinner.classList.remove("hidden");
    swapComplete.classList.add("hidden");
    swapStatusText.classList.remove("hidden");
    startGardenPolling(order.gardenOrderId);
  } else if (order.provider === "tbtc" && order.tbtcDepositId) {
    // Resume tBTC status tracking
    showStep(stepStatus);
    swapStatusText.textContent = "Checking deposit status…";
    swapSpinner.classList.remove("hidden");
    swapComplete.classList.add("hidden");
    swapStatusText.classList.remove("hidden");
    redeemTxEl.textContent = "Deposit ID: " + order.tbtcDepositId;
    redeemTxEl.classList.remove("hidden");
    startTbtcStatusPolling(order.tbtcDepositId);
  } else if (order.provider === "garden") {
    // Garden order still waiting for BTC deposit — show deposit screen
    showStep(stepDeposit);
    hintExact.classList.remove("hidden");
    hintAny.classList.add("hidden");
    depositAmountRow.classList.remove("hidden");
    depositAmountEl.textContent = order.amount ? satsToBtc(order.amount) + " BTC" : "—";
    depositAddrEl.textContent = order.depositAddress;
    depositStatusEl.textContent = "Waiting for your transaction…";

    const btcUri = order.amount
      ? `bitcoin:${order.depositAddress}?amount=${satsToBtc(order.amount)}`
      : `bitcoin:${order.depositAddress}`;
    await QRCode.toCanvas(qrCanvas, btcUri, {
      width: 280,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    if (order.gardenOrderId) {
      startGardenPolling(order.gardenOrderId);
    }
  }
}

// --- Provider toggle ---

function setProvider(provider: Provider) {
  activeProvider = provider;
  btnGarden.classList.toggle("active", provider === "garden");
  btnTbtc.classList.toggle("active", provider === "tbtc");

  if (provider === "garden") {
    gardenFields.classList.remove("hidden");
    btnNext.textContent = "Get Quote";
  } else {
    gardenFields.classList.add("hidden");
    btnNext.textContent = "Generate Deposit Address";
  }
}

btnGarden.addEventListener("click", () => setProvider("garden"));
btnTbtc.addEventListener("click", () => setProvider("tbtc"));

// --- Main action button ---

btnNext.addEventListener("click", async () => {
  if (activeProvider === "garden") {
    await handleGardenQuote();
  } else {
    await handleTbtcDeposit();
  }
});

// --- Garden flow ---

async function handleGardenQuote() {
  const btcAmount = parseFloat(btcAmountInput.value);
  const starknetAddr = starknetAddrInput.value.trim();
  const btcRefund = btcRefundInput.value.trim();

  if (!btcAmount || btcAmount <= 0) {
    showError("Enter a valid BTC amount");
    return;
  }
  if (!starknetAddr) {
    showError("Enter a Starknet address");
    return;
  }
  if (!btcRefund) {
    showError("Enter a Bitcoin refund address");
    return;
  }

  btnNext.disabled = true;
  btnNext.textContent = "Getting quote…";

  try {
    const sats = Math.round(btcAmount * 1e8).toString();
    const quote = await getQuote(sats);
    currentQuote = quote;

    quoteInput.textContent = satsToBtc(quote.sendAmount) + " BTC";
    quoteOutput.textContent = satsToBtc(quote.receiveAmount) + " WBTC";

    showStep(stepQuote);
  } catch (err: any) {
    showError(err.message || "Failed to get quote");
  } finally {
    btnNext.disabled = false;
    btnNext.textContent = "Get Quote";
  }
}

btnBackForm.addEventListener("click", () => {
  currentQuote = null;
  showStep(stepForm);
});

btnConfirm.addEventListener("click", async () => {
  if (!currentQuote) return;

  const starknetAddr = starknetAddrInput.value.trim();
  const btcRefund = btcRefundInput.value.trim();

  btnConfirm.disabled = true;
  btnConfirm.textContent = "Creating order…";

  try {
    const order = await createOrder(
      currentQuote.sendAmount,
      currentQuote.receiveAmount,
      starknetAddr,
      btcRefund,
      currentQuote.strategyId
    );

    // Save to localStorage
    const savedOrder: SavedOrder = {
      id: order.orderId,
      provider: "garden",
      createdAt: new Date().toISOString(),
      depositAddress: order.depositAddress,
      amount: order.depositAmount,
      starknetAddress: starknetAddr,
      gardenOrderId: order.orderId,
      status: "waiting",
    };
    saveOrder(savedOrder);
    currentOrderId = order.orderId;

    // Show deposit with exact amount
    hintExact.classList.remove("hidden");
    hintAny.classList.add("hidden");
    depositAmountRow.classList.remove("hidden");
    depositAmountEl.textContent = satsToBtc(order.depositAmount) + " BTC";
    depositAddrEl.textContent = order.depositAddress;
    depositStatusEl.textContent = "Waiting for your transaction…";

    const btcUri = `bitcoin:${order.depositAddress}?amount=${satsToBtc(order.depositAmount)}`;
    await QRCode.toCanvas(qrCanvas, btcUri, {
      width: 280,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    showStep(stepDeposit);
    startGardenPolling(order.orderId);
  } catch (err: any) {
    showError(err.message || "Failed to create order");
  } finally {
    btnConfirm.disabled = false;
    btnConfirm.textContent = "Confirm Swap";
  }
});

// --- tBTC flow ---

async function handleTbtcDeposit() {
  const starknetAddr = starknetAddrInput.value.trim();
  const btcRefund = btcRefundInput.value.trim();

  if (!starknetAddr) {
    showError("Enter a Starknet address");
    return;
  }
  if (!btcRefund) {
    showError("Enter a Bitcoin refund address");
    return;
  }

  btnNext.disabled = true;
  btnNext.textContent = "Initializing tBTC SDK…";

  try {
    await initTbtc(starknetAddr);

    btnNext.textContent = "Generating deposit address…";
    const deposit = await createDeposit(btcRefund);
    currentTbtcDeposit = deposit;

    // Save to localStorage (ID will be updated after minting initiated)
    const savedOrder: SavedOrder = {
      id: "tbtc-" + Date.now(),
      provider: "tbtc",
      createdAt: new Date().toISOString(),
      depositAddress: deposit.bitcoinAddress,
      starknetAddress: starknetAddr,
      status: "waiting",
    };
    saveOrder(savedOrder);
    currentOrderId = savedOrder.id;

    // Show deposit without exact amount (tBTC accepts any amount)
    hintExact.classList.add("hidden");
    hintAny.classList.remove("hidden");
    depositAmountRow.classList.add("hidden");
    depositAddrEl.textContent = deposit.bitcoinAddress;
    depositStatusEl.textContent = "Waiting for your transaction…";

    await QRCode.toCanvas(qrCanvas, `bitcoin:${deposit.bitcoinAddress}`, {
      width: 280,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    showStep(stepDeposit);
    startTbtcPolling(deposit);
  } catch (err: any) {
    showError(err.message || "Failed to initialize tBTC");
  } finally {
    btnNext.disabled = false;
    btnNext.textContent = "Generate Deposit Address";
  }
}

// --- Polling: Garden ---

function startGardenPolling(orderId: string) {
  stopPolling();

  pollTimer = setInterval(async () => {
    try {
      const status = await getOrderStatus(orderId);

      updateOrderStatus(orderId, status.status);

      switch (status.status) {
        case "detected":
          depositStatusEl.textContent = "Bitcoin transaction detected!";
          showStep(stepStatus);
          swapSpinner.classList.remove("hidden");
          swapStatusText.classList.remove("hidden");
          swapComplete.classList.add("hidden");
          swapStatusText.textContent = "Bitcoin received. Waiting for confirmations…";
          break;

        case "processing":
          showStep(stepStatus);
          swapSpinner.classList.remove("hidden");
          swapStatusText.classList.remove("hidden");
          swapComplete.classList.add("hidden");
          swapStatusText.textContent = "Swap in progress. Waiting for completion…";
          break;

        case "complete":
          stopPolling();
          updateOrderStatus(orderId, "complete");
          showStep(stepStatus);
          swapSpinner.classList.add("hidden");
          swapStatusText.classList.add("hidden");
          swapComplete.classList.remove("hidden");
          if (status.redeemTxHash) {
            redeemTxEl.textContent = "Tx: " + status.redeemTxHash;
          }
          renderPendingOrders();
          break;

        case "expired":
          stopPolling();
          updateOrderStatus(orderId, "expired");
          showStep(stepStatus);
          swapSpinner.classList.add("hidden");
          swapStatusText.textContent =
            "Swap expired. Funds will be refunded to your Bitcoin address.";
          renderPendingOrders();
          break;

        case "refunded":
          stopPolling();
          updateOrderStatus(orderId, "refunded");
          showStep(stepStatus);
          swapSpinner.classList.add("hidden");
          swapStatusText.textContent = "Swap refunded. Check your Bitcoin wallet.";
          renderPendingOrders();
          break;
      }
    } catch {
      // Silently retry on poll failure
    }
  }, 10000);
}

// --- Polling: tBTC ---

function startTbtcPolling(tbtcDeposit: TbtcDeposit) {
  stopPolling();

  pollTimer = setInterval(async () => {
    try {
      const funded = await detectFunding(tbtcDeposit.deposit);

      if (funded) {
        stopPolling();
        depositStatusEl.textContent = "Bitcoin received! Initiating minting…";
        showStep(stepStatus);
        swapStatusText.textContent =
          "Minting tBTC on Starknet. This takes ~1-2 hours…";

        try {
          const receipt = await initiateMinting(tbtcDeposit.deposit);

          // Update saved order with deposit ID
          if (currentOrderId) {
            const orders = loadOrders();
            const order = orders.find((o) => o.id === currentOrderId);
            if (order) {
              order.tbtcDepositId = receipt;
              order.status = "minting";
              localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
            }
          }

          swapStatusText.textContent = "Minting initiated. Tracking status…";
          redeemTxEl.textContent = "Deposit ID: " + receipt;
          redeemTxEl.classList.remove("hidden");
          startTbtcStatusPolling(receipt);
        } catch (err: any) {
          swapStatusText.textContent =
            "Minting request sent. tBTC will arrive on Starknet in ~1-2 hours.";
        }
      }
    } catch {
      // Silently retry on poll failure
    }
  }, 30000);
}

const STATUS_LABELS: Record<string, string> = {
  not_revealed: "Deposit not yet revealed to Bridge…",
  revealed: "Deposit revealed. Waiting for minter to pick it up (~1h)…",
  minting_requested: "Minting requested. In 3-hour guardian challenge window…",
  minting_finalized: "tBTC minted on Ethereum. Bridging to Starknet…",
  swept: "tBTC minted on Ethereum. Bridging to Starknet…",
  on_starknet: "tBTC arrived on Starknet!",
};

function startTbtcStatusPolling(depositId: string) {
  stopPolling();

  const poll = async () => {
    try {
      const result = await getDepositStatus(depositId);
      swapStatusText.textContent = STATUS_LABELS[result.status] || "Processing…";

      if (currentOrderId) {
        updateOrderStatus(currentOrderId, result.status);
      }

      if (result.status === "on_starknet") {
        stopPolling();
        if (currentOrderId) updateOrderStatus(currentOrderId, "complete");
        swapSpinner.classList.add("hidden");
        swapStatusText.classList.add("hidden");
        swapComplete.classList.remove("hidden");
        redeemTxEl.textContent = "Deposit ID: " + depositId;
        renderPendingOrders();
      }
    } catch {
      // Silently retry
    }
  };

  // Check immediately, then every 60s
  poll();
  pollTimer = setInterval(poll, 60000);
}

// --- Common ---

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

btnCopy.addEventListener("click", () => {
  const addr = depositAddrEl.textContent;
  if (addr && addr !== "—") {
    navigator.clipboard.writeText(addr);
    btnCopy.textContent = "Copied!";
    setTimeout(() => {
      btnCopy.textContent = "Copy";
    }, 2000);
  }
});

// --- Init ---
renderPendingOrders();
