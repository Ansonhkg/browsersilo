import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "../core/ports.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidGenerator implements IdGenerator {
  next(prefix: "profile" | "lease" | "worker" | "audit"): string {
    return `${prefix}_${randomUUID()}`;
  }
}
