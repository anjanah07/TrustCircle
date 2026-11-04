import { deploymentSetup } from "./paypalConfig";
import { z } from "zod";
import { tx } from "./db";
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
      let user;
      if (!options.public) {
        const token = headers.authorization?.replace(/^Bearer /, "");
        if (!token)
          return Response.json(
            { error: "Sign in with your member token" },
            { status: 401 },
          );
        user = await tx(
          async (connection) =>
            (
              await connection.query("SELECT * FROM users WHERE token_hash=$1", [
                tokenHash(token),
              ])
            ).rows[0],
        );
        if (!user)
          return Response.json({ error: "Invalid member token" }, { status: 401 });
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
      return await endpoint({ params: await route.params, body, headers, user });
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
