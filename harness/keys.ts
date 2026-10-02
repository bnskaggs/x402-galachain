import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Test wallets live outside the repo (same file the x402-probe harness uses).
const WALLET_ENV_PATH = process.env.X402_PROBE_ENV ?? join(homedir(), ".x402-probe", ".env");

export type Role = "BUYER" | "SELLER" | "ATTACKER";

let cache: Record<string, string> | undefined;

function env(): Record<string, string> {
  cache ??= Object.fromEntries(
    readFileSync(WALLET_ENV_PATH, "utf8")
      .split(/\r?\n/)
      .filter(line => line && !line.startsWith("#"))
      .map(line => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as [string, string];
      }),
  );
  return cache;
}

export function secret(name: string): string {
  const value = env()[name];
  if (!value) throw new Error(`${name} not set in ${WALLET_ENV_PATH}`);
  return value;
}

export function privateKey(role: Role): string {
  const value = env()[`${role}_PRIVATE_KEY`];
  if (!value) throw new Error(`${role}_PRIVATE_KEY not set in ${WALLET_ENV_PATH}`);
  return value;
}
