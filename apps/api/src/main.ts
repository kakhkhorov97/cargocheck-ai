import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { AppModule, store, jobs } from "./app";
import { Errors, authenticationRateLimit } from "./auth-http";

const app = await NestFactory.create(AppModule, {
  logger: ["error", "warn", "log"],
});
app.use(
  helmet({
    contentSecurityPolicy: false,
    frameguard: { action: "sameorigin" },
  }),
);
app.use(cookieParser());
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  if (
    ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) &&
    req.headers.origin &&
    ![
      process.env.APP_ORIGIN ?? "http://localhost:4173",
      "http://127.0.0.1:4173",
      ...(process.env.NODE_ENV !== "production"
        ? ["http://terminal.local:4173"]
        : []),
    ].includes(req.headers.origin)
  )
    return res.status(403).json({ message: "Origin not allowed." });
  next();
});
app.use("/api/auth", authenticationRateLimit());
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.useGlobalFilters(new Errors());
const webRoot = path.resolve(import.meta.dirname, "../../web/dist");
if (existsSync(path.join(webRoot, "index.html"))) {
  app.use(express.static(webRoot));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" && !req.path.startsWith("/api"))
      return res.sendFile(path.join(webRoot, "index.html"));
    next();
  });
}
await store.init();
await jobs.init();
await app.listen(Number(process.env.PORT ?? 3001), "0.0.0.0");
console.log(`CargoCheck API: http://localhost:${process.env.PORT ?? 3001}`);
async function shutdown() {
  await jobs.close();
  await app.close();
  await store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
