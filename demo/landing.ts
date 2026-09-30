import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";

const demoTx = "b53168abc07cbdc7422aa3af47672906ca82233104e57de3537f364fa1cd1422";

export interface DemoConfig {
  demoBuyerEnabled: boolean;
  facilitatorUrl: string;
  payTo: string;
}

export interface PaymentSummary {
  amountAtomic: string;
  asset: string;
  description: string;
  maxTimeoutSeconds: number | null;
  network: string;
  payTo: string;
  price: string;
  scheme: string;
}

export function summarizeRequirements(requirements: PaymentRequirements): PaymentSummary {
  return {
    amountAtomic: requirements.amount,
    asset: requirements.asset,
    description: "One quote, paid in GALA on GalaChain",
    maxTimeoutSeconds:
      typeof requirements.maxTimeoutSeconds === "number" ? requirements.maxTimeoutSeconds : null,
    network: requirements.network,
    payTo: requirements.payTo,
    price: "1 GALA",
    scheme: requirements.scheme,
  };
}

export function firstRequirement(paymentRequired: PaymentRequired): PaymentRequirements | undefined {
  return paymentRequired.accepts.find(
    requirement => requirement.network === "galachain:mainnet" && requirement.scheme === "exact",
  );
}

export function paymentRequiredBody(paymentRequired: PaymentRequired): Record<string, unknown> {
  const requirement = firstRequirement(paymentRequired);
  return {
    message:
      "Payment required. This endpoint charges 1 GALA on GalaChain; browsers cannot sign it yet.",
    x402Version: paymentRequired.x402Version,
    error: paymentRequired.error ?? null,
    accepts: requirement ? [summarizeRequirements(requirement)] : paymentRequired.accepts,
    howToPay:
      "Use an x402 client with x402-galachain installed, a funded GalaChain key, and GALA in allowedAssets.",
    demo: "/",
  };
}

export function landingPage(config: DemoConfig): string {
  const disabled = config.demoBuyerEnabled ? "" : "disabled";
  const buttonText = config.demoBuyerEnabled ? "Run a live 1 GALA payment" : "Live demo disabled";
  const disabledNote = config.demoBuyerEnabled
    ? "This spends 2 GALA from a throwaway demo key: 1 GALA to the seller and 1 GALA burned as the transfer fee."
    : "The explanatory demo is live. The paid button turns on after DEMO_BUYER_KEY is funded and added to Vercel.";

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>x402 on GalaChain demo</title>
        <style>
          :root {
            color-scheme: light dark;
            font-family:
              Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            line-height: 1.5;
          }
          body {
            margin: 0;
            background: #0d1117;
            color: #e6edf3;
          }
          main {
            max-width: 960px;
            margin: 0 auto;
            padding: 48px 20px 72px;
          }
          a {
            color: #7cc4ff;
          }
          h1 {
            font-size: clamp(2rem, 7vw, 4.5rem);
            line-height: 0.95;
            letter-spacing: -0.06em;
            margin: 0 0 20px;
          }
          h2 {
            margin-top: 40px;
          }
          .lede {
            color: #b7c2cf;
            font-size: 1.2rem;
            max-width: 760px;
          }
          .panel {
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 18px;
            padding: 22px;
            margin: 22px 0;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
            gap: 14px;
          }
          .step {
            background: #0d1117;
            border: 1px solid #30363d;
            border-radius: 14px;
            padding: 16px;
          }
          .step strong {
            display: block;
            margin-bottom: 8px;
          }
          code,
          pre {
            font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          }
          pre {
            overflow-x: auto;
            background: #06090f;
            border: 1px solid #30363d;
            border-radius: 12px;
            padding: 16px;
          }
          button {
            border: 0;
            border-radius: 999px;
            padding: 13px 18px;
            background: #2f81f7;
            color: white;
            font-weight: 700;
            cursor: pointer;
          }
          button:disabled {
            background: #30363d;
            color: #8b949e;
            cursor: not-allowed;
          }
          .muted {
            color: #8b949e;
          }
          .log {
            display: grid;
            gap: 12px;
            margin-top: 18px;
          }
          .log-entry {
            border: 1px solid #30363d;
            border-radius: 12px;
            padding: 14px;
            background: #0d1117;
          }
          .ok {
            color: #7ee787;
          }
          .bad {
            color: #ff7b72;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>GALA payments for HTTP requests.</h1>
          <p class="lede">
            This is x402 on GalaChain mainnet. A script or agent requests a URL, receives a 402
            with the price, signs a GALA transfer, retries the same request, and gets a normal
            HTTP 200 after settlement.
          </p>

          <section class="panel">
            <h2>What happens</h2>
            <div class="grid">
              <div class="step"><strong>1. Request</strong><code>GET /quote</code> returns 402.</div>
              <div class="step">
                <strong>2. Terms</strong>The 402 says: 1 GALA, GalaChain mainnet, pay the seller.
              </div>
              <div class="step">
                <strong>3. Signature</strong>The payer signs a GalaChain <code>TransferToken</code>.
              </div>
              <div class="step">
                <strong>4. Settlement</strong>The seller retries, gets 200, and the tx id proves it.
              </div>
            </div>
          </section>

          <section class="panel">
            <h2>Try the free 402</h2>
            <p>Open <a href="/quote">/quote</a> in a browser, or run:</p>
            <pre><code>curl -i https://x402-galachain-demo.vercel.app/quote</code></pre>
            <p class="muted">
              A browser can see the price, but it cannot sign a GalaChain transfer yet. The payer
              today is a script or agent with a funded key.
            </p>
          </section>

          <section class="panel">
            <h2>Run the live demo</h2>
            <p>${escapeHtml(disabledNote)}</p>
            <button id="run" ${disabled}>${buttonText}</button>
            <div id="status" class="muted"></div>
            <div id="log" class="log"></div>
          </section>

          <section class="panel">
            <h2>Receipts and links</h2>
            <ul>
              <li>Hosted facilitator: <a href="${config.facilitatorUrl}/supported">${config.facilitatorUrl}</a></li>
              <li>Demo seller address: <code>${escapeHtml(config.payTo)}</code></li>
              <li>Prior settled tx: <code>${demoTx}</code> (search it on <a href="https://explorer.galachain.com">GalaChain Explorer</a>)</li>
              <li><a href="https://github.com/bnskaggs/x402-galachain">Repository</a></li>
              <li><a href="https://www.npmjs.com/package/x402-galachain">npm package</a></li>
              <li><a href="https://github.com/x402-foundation/x402/pull/3635">x402 spec PR</a></li>
              <li><a href="https://github.com/ChainAgnostic/namespaces/pull/232">CAIP-2 namespace PR</a></li>
            </ul>
          </section>
        </main>
        <script>
          const button = document.getElementById("run");
          const status = document.getElementById("status");
          const log = document.getElementById("log");

          function escape(value) {
            return String(value)
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;")
              .replaceAll("'", "&#039;");
          }

          function renderStep(step) {
            const details = step.details ? "<pre><code>" + escape(JSON.stringify(step.details, null, 2)) + "</code></pre>" : "";
            return '<div class="log-entry"><strong>' + escape(step.title) + '</strong><p class="muted">' +
              escape(step.summary) + "</p>" + details + "</div>";
          }

          button?.addEventListener("click", async () => {
            button.disabled = true;
            log.innerHTML = "";
            status.textContent = "Running one paid request...";
            try {
              const response = await fetch("/pay-demo", { method: "POST" });
              const data = await response.json();
              if (!response.ok) {
                throw new Error(data.error || "Demo payment failed");
              }
              for (const step of data.steps) {
                log.insertAdjacentHTML("beforeend", renderStep(step));
              }
              status.innerHTML = '<span class="ok">Settled.</span> Transaction: <code>' + escape(data.tx || "") + "</code>";
            } catch (error) {
              status.innerHTML = '<span class="bad">' + escape(error.message || String(error)) + "</span>";
            } finally {
              button.disabled = false;
            }
          });
        </script>
      </body>
    </html>`;
}

export function paywallPage(paymentRequired: PaymentRequired): string {
  const requirement = firstRequirement(paymentRequired);
  const summary = requirement ? summarizeRequirements(requirement) : null;
  const price = summary?.price ?? "unknown";
  const payTo = summary?.payTo ?? "unknown";

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>402 Payment Required</title>
        <style>
          body {
            margin: 0;
            padding: 40px 20px;
            background: #0d1117;
            color: #e6edf3;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            line-height: 1.5;
          }
          main {
            max-width: 760px;
            margin: 0 auto;
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 18px;
            padding: 28px;
          }
          a {
            color: #7cc4ff;
          }
          code {
            font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>402 Payment Required</h1>
          <p>This endpoint costs <strong>${escapeHtml(price)}</strong> on GalaChain mainnet.</p>
          <p>Recipient: <code>${escapeHtml(payTo)}</code></p>
          <p>
            A browser can read the payment terms, but it cannot sign this GalaChain transfer yet.
            Use an x402 client with <code>x402-galachain</code>, or open the
            <a href="/">interactive demo</a>.
          </p>
        </main>
      </body>
    </html>`;
}

function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
