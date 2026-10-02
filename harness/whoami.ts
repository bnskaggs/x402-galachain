import { GalaChainGateway, galaChainAddressFromPrivateKey } from "../src/index.js";
import { privateKey } from "./keys.js";

const address = galaChainAddressFromPrivateKey(privateKey("BUYER"));
const res = await new GalaChainGateway().fetchBalances(address);
const gala = (res.body.Data ?? []).find(b => b.collection === "GALA");
console.log(`ADDR ${address}`);
console.log(`GALA ${gala ? gala.quantity : 0}`);
