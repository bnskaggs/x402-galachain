import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { secret } from "./keys.js";

const GALA_MINT = "eEUiUs4JWYZrp72djAGF1A8PhpR6rHphGeGN7GbVLp6";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await res.json()) as any).result;
}

async function report(label: string, owner: string) {
  const accounts = await rpc("getTokenAccountsByOwner", [owner, { mint: GALA_MINT }, { encoding: "jsonParsed" }]);
  const sol = await rpc("getBalance", [owner]);
  const gala = (accounts?.value ?? []).reduce(
    (sum: number, a: any) => sum + Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0),
    0,
  );
  console.log(`${label} ${owner} galaAccounts=${accounts?.value?.length ?? 0} GALA=${gala} SOL=${(sol?.value ?? 0) / 1e9}`);
}

const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(secret("SOLANA_BUYER_PRIVATE_KEY")));
await report("buyer", signer.address);
await report("payTo", secret("X402_SOLANA_PAY_TO"));
