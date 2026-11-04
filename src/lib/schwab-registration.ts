// Registration metadata only. Credentials belong in private environment variables.
export const schwabRegistration = {
  name: "Algo ICT Trader",
  environment: "Production",
  portalStatus: "Ready For Use",
  portalCreatedDate: "2026-10-29",
  portalKeyIssuedDate: "2026-10-29",
  portalLastModifiedDate: "2026-10-29",
  callbackUrl: "https://127.0.0.1",
  orderLimitPerMinute: 0,
  products: ["Accounts and Trading Production", "Market Data Production"],
} as const;

export function schwabSetupStatus(env: Record<string, string | undefined>) {
  const credentialsConfigured = Boolean(env.SCHWAB_CLIENT_ID?.trim() && env.SCHWAB_CLIENT_SECRET?.trim());
  return {
    registration: schwabRegistration,
    credentialsConfigured,
    callbackMatchesRegistration: env.SCHWAB_CALLBACK_URL === schwabRegistration.callbackUrl,
    // Registration and a saved key are not evidence of account consent or a
    // working token. Upgrade this only after implementing and verifying OAuth.
    connectionStatus: "OAUTH_NOT_CONNECTED" as const,
    tradingEnabled: false,
  };
}
