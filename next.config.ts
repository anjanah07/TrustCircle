import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "@paypal/agent-toolkit", "pg"],
  outputFileTracingIncludes: { "/*": ["./server/*.sql"] },
};

export default config;
