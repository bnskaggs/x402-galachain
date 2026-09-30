import { createApp, parseAllowlist } from "./app.js";

const port = Number(process.env.PORT ?? 4021);
const openRelay = process.env.ALLOW_OPEN_RELAY === "1";
const allowlistCount = parseAllowlist(process.env.ALLOWED_PAY_TO).length;

const app = createApp();
app.listen(port, () => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      route: "listen",
      port,
      openRelay,
      allowlistCount,
    }),
  );
});
