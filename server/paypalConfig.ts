export const deploymentSetup = () => process.env.DEPLOYMENT_SETUP === "true";
export const appOrigin = () =>
  (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

export const paypalSecret = () =>
  process.env.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_SECRET;

export function paypalConfigurationIssues(): string[] {
  const issues: string[] = [];
  if (!process.env.PAYPAL_CLIENT_ID) issues.push("PAYPAL_CLIENT_ID is missing");
  if (!paypalSecret()) issues.push("PAYPAL_CLIENT_SECRET (or PAYPAL_SECRET) is missing");
  if (!process.env.PAYPAL_WEBHOOK_ID) issues.push("PAYPAL_WEBHOOK_ID is missing");
  try {
    const url = new URL(appOrigin());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      issues.push("APP_URL must be the public HTTPS origin, without a path or query");
    }
  } catch {
    issues.push("APP_URL must be the public HTTPS origin");
  }
  return issues;
}
