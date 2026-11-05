/**
 * Shared by the application and the read-only PayPal setup checker.
 * @param {Record<string, string | undefined>} env
 */
function connectionConfig(env = process.env) {
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

/** @param {Record<string, string | undefined>} env */
export function databaseSchema(env = process.env) {
  const schema = env.DATABASE_SCHEMA;
  if (!schema) return undefined;
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(schema) ||
    schema.startsWith("pg_") ||
    ["public", "information_schema"].includes(schema)
  ) {
    throw new Error(
      "DATABASE_SCHEMA must be a dedicated lowercase schema name, such as trustcircle_paypal",
    );
  }
  return schema;
}

/** @param {Record<string, string | undefined>} env */
export function databaseConfig(env = process.env) {
  const config = connectionConfig(env);
  const schema = databaseSchema(env);
  if (!schema) return config;
  let url;
  try {
    url = new URL(config.connectionString || "");
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  // URL options take precedence in pg. Do not allow an old search_path in the
  // URL to override isolation or fall back to the public simulation tables.
  url.searchParams.delete("options");
  return {
    ...config,
    connectionString: url.toString(),
    options: `-c search_path=${schema}`,
  };
}
