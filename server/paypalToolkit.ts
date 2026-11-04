import { paypalSecret } from "./paypalConfig";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import { requireThat } from "./policy";
export const paypalToolNames = ["create_order", "get_order", "pay_order"];
export function makeToolkit(requestId?: string) {
  return new PayPalAgentToolkit({
    clientId: process.env.PAYPAL_CLIENT_ID || "unconfigured",
    clientSecret: paypalSecret() || "unconfigured",
    configuration: {
      actions: { orders: { create: true, get: true, capture: true } },
      context: {
        sandbox: true,
        debug: false,
        ...(requestId ? { request_id: requestId } : {}),
      },
    },
  });
}
// Preserve toolkit tool identities, but narrow their arguments to application intents.
// Never expose arbitrary prices, receivers or external order IDs to the model.
export function paypalAgentTools() {
  return makeToolkit()
    .getTools()
    .map((t) => {
      const name = t.function.name;
      const properties =
        name === "create_order"
          ? { kind: { type: "string", enum: ["collateral", "contribution", "topup"] } }
          : {
              id: {
                type: "string",
                description:
                  "TrustCircle internal order UUID returned by create_order, not a provider order ID",
              },
            };
      return {
        type: "function" as const,
        name,
        description:
          name === "create_order"
            ? "Create a PayPal approval link for your own circle payment. Policy determines price and currency. Creating an order does not pay it."
            : name === "get_order"
              ? "Read your own saved order status via PayPal toolkit."
              : "Capture your own order only after PayPal reports buyer approval. Never claim payment before verified capture.",
        parameters: {
          type: "object",
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        },
        strict: true,
      };
    });
}
export async function executePayPalTool(name: string, args: any, requestId?: string) {
  requireThat(paypalToolNames.includes(name), "PayPal tool is not allowed");
  requireThat(
    process.env.PAYPAL_CLIENT_ID && paypalSecret(),
    "Configure PayPal sandbox credentials",
  );
  const result = await makeToolkit(requestId).handleToolCall({
    id: requestId || crypto.randomUUID(),
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });
  const value = JSON.parse(String(result.content));
  requireThat(
    !value.error && value.status !== "error",
    "PayPal toolkit request failed; inspect sandbox order before retrying",
  );
  const data = name === "pay_order" ? value.response : value;
  requireThat(
    data && typeof data.id === "string" && typeof data.status === "string",
    "PayPal toolkit returned an invalid order response",
  );
  return data;
}
