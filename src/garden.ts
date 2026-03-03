const API_BASE = "https://api.garden.finance/v2";
const API_KEY = import.meta.env.VITE_GARDEN_API_KEY || "";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["garden-app-id"] = API_KEY;
  return h;
}

export interface QuoteResult {
  sendAmount: string;
  receiveAmount: string;
  strategyId: string;
}

export async function getQuote(
  btcSats: string
): Promise<QuoteResult> {
  const url = `${API_BASE}/quote?from=bitcoin:btc&to=starknet:wbtc&from_amount=${btcSats}`;
  const res = await fetch(url, { headers: headers() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Quote failed: ${res.status} ${text}`);
  }

  const data = await res.json();

  const quotes = data.result || data;
  const list = Array.isArray(quotes) ? quotes : [quotes];
  if (list.length === 0) throw new Error("No quotes available");

  const best = list[0];
  return {
    sendAmount: btcSats,
    receiveAmount: best.destination.amount,
    strategyId: best.solver_id || "",
  };
}

export interface OrderResult {
  orderId: string;
  depositAddress: string;
  depositAmount: string;
}

export async function createOrder(
  btcSats: string,
  receiveAmount: string,
  starknetAddress: string,
  btcRefundAddress: string,
  strategyId: string
): Promise<OrderResult> {
  const body = {
    source: {
      asset: "bitcoin:btc",
      owner: btcRefundAddress,
      amount: btcSats,
    },
    destination: {
      asset: "starknet:wbtc",
      owner: starknetAddress,
      amount: receiveAmount,
    },
    ...(strategyId ? { solver_id: strategyId } : {}),
  };

  const res = await fetch(`${API_BASE}/orders`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok || data.status === "Error") {
    throw new Error(data.error || `Order failed: ${res.status}`);
  }

  const order = data.result || data;
  return {
    orderId: order.order_id,
    depositAddress: order.to,
    depositAmount: order.amount || btcSats,
  };
}

export type SwapStatus =
  | "waiting"
  | "detected"
  | "processing"
  | "complete"
  | "expired"
  | "refunded";

export interface OrderStatus {
  status: SwapStatus;
  redeemTxHash?: string;
}

export async function getOrderStatus(orderId: string): Promise<OrderStatus> {
  const res = await fetch(`${API_BASE}/orders/${orderId}`, {
    headers: headers(),
  });

  if (!res.ok) {
    throw new Error(`Status check failed: ${res.status}`);
  }

  const raw = await res.json();
  const data = raw.result || raw;

  const src = data.source_swap;
  const dst = data.destination_swap;

  // Complete: destination redeemed
  if (dst?.redeem_tx_hash && dst.redeem_tx_hash !== "") {
    return { status: "complete", redeemTxHash: dst.redeem_tx_hash };
  }

  // Refunded
  if (src?.refund_tx_hash && src.refund_tx_hash !== "") {
    return { status: "refunded" };
  }

  // Processing: BTC confirmed, waiting for destination
  if (dst?.initiate_tx_hash && dst.initiate_tx_hash !== "") {
    return { status: "processing" };
  }

  // Detected: BTC tx seen, confirming
  if (src?.initiate_tx_hash && src.initiate_tx_hash !== "") {
    const confs = src.current_confirmations || 0;
    const required = src.required_confirmations || 1;
    return {
      status: confs >= required ? "processing" : "detected",
    };
  }

  return { status: "waiting" };
}

export function satsToBtc(sats: string): string {
  return (Number(sats) / 1e8).toFixed(8);
}
