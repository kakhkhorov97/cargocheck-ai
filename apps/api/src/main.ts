import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { HttpException } from "@nestjs/common";
import type { ExceptionFilter, ArgumentsHost } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { ZodError } from "zod";
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { AppModule, store, jobs } from "./app";

class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof ZodError)
      return res
        .status(400)
        .json({
          message: "Invalid request.",
          details: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
    if (error instanceof HttpException)
      return res
        .status(error.getStatus())
        .json({
          message:
            typeof error.getResponse() === "string"
              ? error.getResponse()
              : (error.getResponse() as { message: unknown }).message,
        });
    console.error(
      "Request failed:",
      error instanceof Error ? error.message : "unknown",
    );
    return res
      .status(500)
      .json({ message: "The request could not be completed. Try again." });
  }
}
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
app.use(
  "/api/auth",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
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
