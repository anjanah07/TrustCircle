/**
 * Shared by the application and the read-only PayPal setup checker.
 * @param {Record<string, string | undefined>} env
 */
export function databaseConfig(env = process.env) {
  if (env.PGSSL_MODE === "render-internal") {
    let url;
    try {
      url = new URL(env.DATABASE_URL || "");
    } catch {
      throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
    }
    // Render's internal PostgreSQL certificates are self-signed. Allow this
    // explicit encrypted mode only on Render and only for its private hostname.
    if (
      env.RENDER !== "true" ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !/^dpg-[a-z0-9-]+$/.test(url.hostname) ||
      url.searchParams.has("host") ||
      url.searchParams.has("hostaddr")
    ) {
      throw new Error(
        "PGSSL_MODE=render-internal requires a Render service and its private dpg- database hostname. Use verified TLS for external database URLs.",
      );
    }
    // pg gives URL SSL options precedence over the ssl object. Remove them so
    // this explicit mode always requires TLS, even if the URL says disable.
    for (const key of [
      "ssl",
      "sslmode",
      "sslcert",
      "sslkey",
      "sslrootcert",
      "uselibpqcompat",
    ])
      url.searchParams.delete(key);
    return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } };
  }
  if (env.PGSSL_MODE)
    throw new Error("Unknown PGSSL_MODE; use render-internal or leave it unset");
  return {
    connectionString: env.DATABASE_URL,
    ...(env.PGSSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}
