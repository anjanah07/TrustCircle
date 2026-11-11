import { deploymentSetup } from "./paypalConfig";
import { z } from "zod";
import { read, demo } from "./db";
import { sessionUser } from "./auth";
import { appOrigin } from "./paypalConfig";
import { tokenHash } from "./circles";
import { ensureRuntime } from "./runtime";

export interface ApiContext {
  params: Record<string, string>;
  body: any;
  headers: Record<string, string>;
  user: any;
}

type RouteContext = { params: Promise<Record<string, string>> };
type Endpoint = (context: ApiContext) => Promise<Response>;

export function handle(
  endpoint: Endpoint,
  options: { public: boolean; setupAllowed?: boolean },
) {
  return async (request: Request, route: RouteContext): Promise<Response> => {
    const started = performance.now();
    try {
      if (deploymentSetup() && !options.setupAllowed) {
        return Response.json(
          {
            error:
              "TrustCircle setup is in progress. Payments and registration are disabled until configuration is complete.",
          },
          { status: 503 },
        );
      }
      await ensureRuntime();
      const headers = Object.fromEntries(request.headers.entries());
      const url = new URL(request.url);
      if (request.method === "POST" && !url.pathname.startsWith("/api/webhooks/")) {
        const origin = request.headers.get("origin");
        const expected = appOrigin() || url.origin;
        if (
          (!demo && !origin) ||
          (origin && origin !== expected && origin !== url.origin)
        ) {
          return Response.json({ error: "Request origin denied" }, { status: 403 });
        }
      }
      let user = deploymentSetup() ? null : await sessionUser(headers);
      if (!options.public) {
        const token = demo ? headers.authorization?.replace(/^Bearer /, "") : null;
        if (token)
          user = await read(
            async (c) =>
              (
                await c.query("SELECT * FROM users WHERE token_hash=$1", [
                  tokenHash(token),
                ])
              ).rows[0],
          );
        if (!user)
          return Response.json({ error: "Please log in to continue" }, { status: 401 });
      }
      let body = {};
      if (request.method === "POST") {
        // Bound the actual stream, including requests without Content-Length.
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) {
              await reader.cancel();
              return Response.json(
                { error: "Request body exceeds 64 KB" },
                { status: 413 },
              );
            }
            chunks.push(value);
          }
        }
        if (size) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
          }
        }
      }
      const response = await endpoint({
        params: await route.params,
        body,
        headers,
        user,
      });
      response.headers.set("Cache-Control", "no-store");
      response.headers.set(
        "Server-Timing",
        `app;dur=${(performance.now() - started).toFixed(1)}`,
      );
      return response;
    } catch (error) {
      const validation = error instanceof z.ZodError;
      const message = validation
        ? error.issues.map((issue) => issue.message).join("; ")
        : error instanceof Error
          ? error.message
          : "Request failed";
      console.error(message);
      return Response.json({ error: message }, { status: validation ? 400 : 422 });
    }
  };
}
