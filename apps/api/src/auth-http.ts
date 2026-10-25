import { HttpException } from "@nestjs/common";
import type { ExceptionFilter, ArgumentsHost } from "@nestjs/common";
import type { Response } from "express";
import { rateLimit } from "express-rate-limit";
import { ZodError } from "zod";

export class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof ZodError)
      return res.status(400).json({
        message: "Invalid request.",
        details: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    if (error instanceof HttpException)
      return res.status(error.getStatus()).json({
        ...(typeof error.getResponse() === "object" &&
        "code" in (error.getResponse() as object)
          ? { code: (error.getResponse() as { code: string }).code }
          : {}),
        message:
          typeof error.getResponse() === "string"
            ? error.getResponse()
            : (error.getResponse() as { message: unknown }).message,
      });
    // Untrusted errors may contain SMTP credentials, message bodies, or tokens.
    console.error("Request failed with an unexpected server error.");
    return res
      .status(500)
      .json({ message: "The request could not be completed. Try again." });
  }
}
export function verificationRateLimit() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 15,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      message: "Too many verification requests. Try again in 15 minutes.",
    },
  });
}
