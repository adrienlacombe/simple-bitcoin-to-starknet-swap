import { TBTC } from "@keep-network/tbtc-v2.ts";
import { providers, Contract, BigNumber } from "ethers";
import { Account, RpcProvider, Contract as StarknetContract } from "starknet";

const ETHEREUM_RPC = import.meta.env.VITE_ETHEREUM_RPC || "";
const STARKNET_RPC = import.meta.env.VITE_STARKNET_RPC || "";

const BRIDGE_ADDRESS = "0x5e4861a80B55f035D899f66772117F00FA0E8e7B";
const TBTC_VAULT_ADDRESS = "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD";
const TBTC_STARKNET_TOKEN =
  "0x04daa17763b286d1e59b97c283c0b8c949994c361e426a28f743c67bdfe9a32f";

// Dummy private key — only used so the SDK can extract the Starknet address.
// No Starknet transactions are signed by the user; the relayer handles minting.
const DUMMY_PK = "0x1";

let sdk: TBTC | null = null;
let ethProvider: providers.JsonRpcProvider | null = null;
let starknetRpc: RpcProvider | null = null;
let userStarknetAddress: string = "";

export async function initTbtc(starknetAddress: string): Promise<void> {
  ethProvider = new providers.JsonRpcProvider(ETHEREUM_RPC);
  sdk = await TBTC.initializeMainnet(ethProvider, true);

  starknetRpc = new RpcProvider({ nodeUrl: STARKNET_RPC });
  userStarknetAddress = starknetAddress;
  const starknetAccount = new Account(
    starknetRpc,
    starknetAddress,
    DUMMY_PK
  );

  await sdk.initializeCrossChain("StarkNet", starknetAccount);
}

export interface TbtcDeposit {
  bitcoinAddress: string;
  deposit: any;
}

export async function createDeposit(
  btcRecoveryAddress: string
): Promise<TbtcDeposit> {
  if (!sdk) throw new Error("tBTC SDK not initialized");

  const deposit = await sdk.deposits.initiateCrossChainDeposit(
    btcRecoveryAddress,
    "StarkNet"
  );

  const bitcoinAddress = await deposit.getBitcoinAddress();

  return { bitcoinAddress, deposit };
}

export async function detectFunding(deposit: any): Promise<boolean> {
  const utxos = await deposit.detectFunding();
  return utxos.length > 0;
}

export async function initiateMinting(deposit: any): Promise<string> {
  const receipt = await deposit.initiateMinting();
  return typeof receipt === "string"
    ? receipt
    : receipt?.transactionHash || "submitted";
}

// --- Deposit status tracking ---

export type TbtcDepositStatus =
  | "not_revealed"
  | "revealed"
  | "minting_requested"
  | "minting_finalized"
  | "swept"
  | "on_starknet";

export interface TbtcStatusResult {
  status: TbtcDepositStatus;
  revealedAt?: Date;
  mintingRequestedAt?: Date;
  mintingFinalizedAt?: Date;
  sweptAt?: Date;
  amountSats?: string;
}

const BRIDGE_ABI = [
  "function deposits(uint256 depositKey) external view returns (address depositor, uint64 amount, uint32 revealedAt, address vault, uint64 treasuryFee, uint32 sweptAt, bytes32 extraData)",
];

const VAULT_ABI = [
  "function optimisticMintingRequests(uint256 depositKey) external view returns (uint64 requestedAt, uint64 finalizedAt)",
];

const STARKNET_ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "felt" }],
    outputs: [{ name: "balance", type: "Uint256" }],
    stateMutability: "view",
  },
];

export async function getDepositStatus(
  depositId: string
): Promise<TbtcStatusResult> {
  if (!ethProvider || !starknetRpc) {
    throw new Error("tBTC SDK not initialized");
  }

  const bridge = new Contract(BRIDGE_ADDRESS, BRIDGE_ABI, ethProvider);
  const vault = new Contract(TBTC_VAULT_ADDRESS, VAULT_ABI, ethProvider);

  // Query Bridge for deposit info
  const dep = await bridge.deposits(depositId);
  const revealedAt = Number(dep.revealedAt);
  const sweptAt = Number(dep.sweptAt);
  const amountSats = BigNumber.from(dep.amount).toString();

  if (revealedAt === 0) {
    return { status: "not_revealed" };
  }

  // Query TBTCVault for optimistic minting
  const mint = await vault.optimisticMintingRequests(depositId);
  const mintRequestedAt = Number(mint.requestedAt);
  const mintFinalizedAt = Number(mint.finalizedAt);

  // Check Starknet balance if minting finalized
  if (mintFinalizedAt > 0) {
    try {
      const tbtcContract = new StarknetContract(
        STARKNET_ERC20_ABI,
        TBTC_STARKNET_TOKEN,
        starknetRpc
      );
      const balance = await tbtcContract.balanceOf(userStarknetAddress);
      const bal = BigInt(balance.toString());
      if (bal > 0n) {
        return {
          status: "on_starknet",
          revealedAt: new Date(revealedAt * 1000),
          mintingRequestedAt: new Date(mintRequestedAt * 1000),
          mintingFinalizedAt: new Date(mintFinalizedAt * 1000),
          sweptAt: sweptAt > 0 ? new Date(sweptAt * 1000) : undefined,
          amountSats,
        };
      }
    } catch {
      // Balance check failed, fall through
    }
  }

  if (mintFinalizedAt > 0) {
    return {
      status: sweptAt > 0 ? "swept" : "minting_finalized",
      revealedAt: new Date(revealedAt * 1000),
      mintingRequestedAt: new Date(mintRequestedAt * 1000),
      mintingFinalizedAt: new Date(mintFinalizedAt * 1000),
      sweptAt: sweptAt > 0 ? new Date(sweptAt * 1000) : undefined,
      amountSats,
    };
  }

  if (mintRequestedAt > 0) {
    return {
      status: "minting_requested",
      revealedAt: new Date(revealedAt * 1000),
      mintingRequestedAt: new Date(mintRequestedAt * 1000),
      amountSats,
    };
  }

  return {
    status: "revealed",
    revealedAt: new Date(revealedAt * 1000),
    amountSats,
  };
}
