export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  message: string;
  timestamp: string;
  context: Record<string, unknown>;
}

export class Logger {
  constructor(private readonly service: string) {}

  debug(message: string, context: Record<string, unknown> = {}): void {
    this.write("debug", message, context);
  }

  info(message: string, context: Record<string, unknown> = {}): void {
    this.write("info", message, context);
  }

  warn(message: string, context: Record<string, unknown> = {}): void {
    this.write("warn", message, context);
  }

  error(message: string, context: Record<string, unknown> = {}): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context: Record<string, unknown>): void {
    const record: LogRecord = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context: {
        service: this.service,
        ...redactSecrets(context)
      }
    };
    console.log(JSON.stringify(record));
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  setGauge(name: string, labels: Record<string, string> = {}, value: number): void {
    this.gauges.set(metricKey(name, labels), value);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries(), ...this.gauges.entries()]);
  }
}

export interface AlertCondition {
  code: string;
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  triggered: boolean;
}

export function evaluateCoreAlerts(input: {
  duplicateApplicationAttempted: boolean;
  irreversibleActionWithoutProof: boolean;
  providerFailureRate: number;
  dlqCount: number;
  llmSchemaValidationFailures: number;
}): AlertCondition[] {
  return [
    {
      code: "duplicate_application_attempted",
      severity: "critical",
      message: "Duplicate application was attempted",
      triggered: input.duplicateApplicationAttempted
    },
    {
      code: "irreversible_action_without_proof",
      severity: "critical",
      message: "Irreversible action lacks proof pack",
      triggered: input.irreversibleActionWithoutProof
    },
    {
      code: "provider_failure_rate_high",
      severity: "high",
      message: "Provider failure rate exceeded threshold",
      triggered: input.providerFailureRate > 0.15
    },
    {
      code: "dlq_backlog",
      severity: "high",
      message: "Dead-letter queue contains tasks",
      triggered: input.dlqCount > 0
    },
    {
      code: "llm_schema_validation_spike",
      severity: "high",
      message: "LLM schema validation failures detected",
      triggered: input.llmSchemaValidationFailures > 0
    }
  ];
}

export function createLogger(service: string): Logger {
  return new Logger(service);
}

function metricKey(name: string, labels: Record<string, string>): string {
  const suffix = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return suffix.length > 0 ? `${name}{${suffix}}` : name;
}

export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 8) {
    return "[redacted:max-depth]" as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => {
        if (isSecretKey(key)) {
          return [key, "[redacted]"];
        }
        if (isSecretValue(nestedValue)) {
          return [key, "[redacted]"];
        }
        return [key, redactSecrets(nestedValue, depth + 1)];
      })
    ) as T;
  }
  if (isSecretValue(value)) {
    return "[redacted]" as T;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  return /token|secret|password|cookie|credential|authorization|set-cookie|auth_state|session|idempotency/i.test(key);
}

function isSecretValue(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return (
    /bearer\s+[a-z0-9._~+/=-]+/i.test(value) ||
    /(?:api[_-]?key|token|secret|password|session)=([^&\s]+)/i.test(value) ||
    /(?:sk|ghp|glpat|xox[baprs])[-_a-z0-9]{16,}/i.test(value)
  );
}
