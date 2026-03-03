/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GARDEN_API_KEY: string;
  readonly VITE_ETHEREUM_RPC: string;
  readonly VITE_STARKNET_RPC: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
