export function validateProductionDatabase(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "production") return;
  if (!env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required in production.");
  }

  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    ["0.0.0.0", "[::1]", "[::]"].includes(host)
  ) {
    throw new Error("DATABASE_URL must not use a loopback host in production.");
  }
}
