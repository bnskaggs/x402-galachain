import { randomBytes } from "node:crypto";
import { galaChainAddressFromPrivateKey } from "../src/index.js";

const privateKey = randomBytes(32).toString("hex");
const address = galaChainAddressFromPrivateKey(privateKey);

console.log(
  JSON.stringify(
    {
      address,
      env: `DEMO_BUYER_KEY=${privateKey}`,
      note: "Fund this address with a small amount of GALA, then add only the env line to the demo Vercel project.",
    },
    null,
    2,
  ),
);
