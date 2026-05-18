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

  prometheusText(): string {
    return [...this.counters.entries(), ...this.gauges.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${prometheusMetricKey(key)} ${value}`)
      .join("\n")
      .concat("\n");
  }
}

export interface AlertCondition {
  code: string;
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  triggered: boolean;
  owner: string;
  runbook: string;
  labels: Record<string, string>;
}

export function evaluateCoreAlerts(input: {
  duplicateApplicationAttempted: boolean;
  irreversibleActionWithoutProof: boolean;
  providerFailureRate: number;
  dlqCount: number;
  llmSchemaValidationFailures: number;
  providerStuckMinutes?: number;
  captchaDetected?: boolean;
  authExpired?: boolean;
  policyUnavailable?: boolean;
  queueBacklog?: { queueName: string; depth: number; oldestAgeSeconds: number } | null;
  dbFailure?: boolean;
  objectStoreFailure?: boolean;
  parseFailureRate?: number;
  dedupPossibleDuplicateRate?: number;
  unsupportedFactAttempted?: boolean;
  replyValidationFailures?: number;
  threadContradictionDetected?: boolean;
  outboundDeliveryFailureCount?: number;
}): AlertCondition[] {
  return [
    {
      code: "duplicate_application_attempted",
      severity: "critical",
      message: "Duplicate application was attempted",
      triggered: input.duplicateApplicationAttempted,
      owner: "ops",
      runbook: "docs/runbooks/duplicate-application.md",
      labels: {}
    },
    {
      code: "irreversible_action_without_proof",
      severity: "critical",
      message: "Irreversible action lacks proof pack",
      triggered: input.irreversibleActionWithoutProof,
      owner: "ops",
      runbook: "docs/runbooks/proof-missing.md",
      labels: {}
    },
    {
      code: "provider_failure_rate_high",
      severity: "high",
      message: "Provider failure rate exceeded threshold",
      triggered: input.providerFailureRate > 0.15,
      owner: "provider-automation",
      runbook: "docs/runbooks/provider-selector-update.md",
      labels: { failureRate: String(input.providerFailureRate) }
    },
    {
      code: "dlq_backlog",
      severity: "high",
      message: "Dead-letter queue contains tasks",
      triggered: input.dlqCount > 0,
      owner: "ops",
      runbook: "docs/runbooks/dlq-triage.md",
      labels: { depth: String(input.dlqCount) }
    },
    {
      code: "llm_schema_validation_spike",
      severity: "high",
      message: "LLM schema validation failures detected",
      triggered: input.llmSchemaValidationFailures > 0,
      owner: "llm",
      runbook: "docs/runbooks/llm-schema-validation-spike.md",
      labels: { failures: String(input.llmSchemaValidationFailures) }
    },
    {
      code: "provider_stuck",
      severity: "critical",
      message: "Provider flow is stuck beyond threshold",
      triggered: (input.providerStuckMinutes ?? 0) >= 10,
      owner: "provider-automation",
      runbook: "docs/runbooks/provider-selector-update.md",
      labels: { stuckMinutes: String(input.providerStuckMinutes ?? 0) }
    },
    {
      code: "captcha_detected",
      severity: "critical",
      message: "CAPTCHA or anti-automation challenge detected",
      triggered: input.captchaDetected ?? false,
      owner: "provider-automation",
      runbook: "docs/runbooks/captcha-detected.md",
      labels: {}
    },
    {
      code: "provider_auth_expired",
      severity: "high",
      message: "Provider authentication expired",
      triggered: input.authExpired ?? false,
      owner: "ops",
      runbook: "docs/runbooks/provider-auth-expired.md",
      labels: {}
    },
    {
      code: "policy_unavailable",
      severity: "critical",
      message: "Policy engine is unavailable",
      triggered: input.policyUnavailable ?? false,
      owner: "backend",
      runbook: "docs/runbooks/stuck-queue.md",
      labels: {}
    },
    {
      code: "queue_backlog_age",
      severity: "high",
      message: "Queue backlog age exceeded threshold",
      triggered: Boolean(input.queueBacklog && input.queueBacklog.depth > 0 && input.queueBacklog.oldestAgeSeconds >= 300),
      owner: "ops",
      runbook: "docs/runbooks/stuck-queue.md",
      labels: {
        queueName: input.queueBacklog?.queueName ?? "unknown",
        depth: String(input.queueBacklog?.depth ?? 0),
        oldestAgeSeconds: String(input.queueBacklog?.oldestAgeSeconds ?? 0)
      }
    },
    {
      code: "db_failure",
      severity: "critical",
      message: "Database operation failed",
      triggered: input.dbFailure ?? false,
      owner: "backend",
      runbook: "docs/runbooks/db-migration-rollback.md",
      labels: {}
    },
    {
      code: "object_store_failure",
      severity: "critical",
      message: "Object storage operation failed",
      triggered: input.objectStoreFailure ?? false,
      owner: "backend",
      runbook: "docs/runbooks/proof-missing.md",
      labels: {}
    },
    {
      code: "read_only_parse_spike",
      severity: "high",
      message: "Read-only parsing failure rate exceeded threshold",
      triggered: (input.parseFailureRate ?? 0) > 0.05,
      owner: "data-quality",
      runbook: "docs/runbooks/read-only-parse-spike.md",
      labels: { parseFailureRate: String(input.parseFailureRate ?? 0) }
    },
    {
      code: "dedup_anomaly",
      severity: "medium",
      message: "Possible duplicate rate exceeded expected band",
      triggered: (input.dedupPossibleDuplicateRate ?? 0) > 0.25,
      owner: "data-quality",
      runbook: "docs/runbooks/dedup-anomaly.md",
      labels: { possibleDuplicateRate: String(input.dedupPossibleDuplicateRate ?? 0) }
    },
    {
      code: "unsupported_fact_attempted",
      severity: "critical",
      message: "Outbound reply attempted to use an unsupported fact",
      triggered: input.unsupportedFactAttempted ?? false,
      owner: "policy",
      runbook: "docs/runbooks/outbound-reply-failure.md",
      labels: {}
    },
    {
      code: "reply_validation_spike",
      severity: "high",
      message: "Recruiter reply validation failures detected",
      triggered: (input.replyValidationFailures ?? 0) > 0,
      owner: "conversation-automation",
      runbook: "docs/runbooks/outbound-reply-failure.md",
      labels: { failures: String(input.replyValidationFailures ?? 0) }
    },
    {
      code: "thread_contradiction_detected",
      severity: "high",
      message: "Outbound reply contradicted thread context",
      triggered: input.threadContradictionDetected ?? false,
      owner: "conversation-automation",
      runbook: "docs/runbooks/outbound-reply-failure.md",
      labels: {}
    },
    {
      code: "outbound_delivery_failure",
      severity: "high",
      message: "Outbound delivery failed after dispatch",
      triggered: (input.outboundDeliveryFailureCount ?? 0) > 0,
      owner: "ops",
      runbook: "docs/runbooks/outbound-reply-failure.md",
      labels: { failures: String(input.outboundDeliveryFailureCount ?? 0) }
    }
  ];
}

export function createTraceContext(input: { traceId?: string; entityId: string; providerId?: string | null; queueName?: string | null }): {
  traceId: string;
  attributes: Record<string, string>;
} {
  const traceId = input.traceId ?? `trace_${hashForTrace(input.entityId)}`;
  return {
    traceId,
    attributes: {
      entityId: input.entityId,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.queueName ? { queueName: input.queueName } : {})
    }
  };
}

export function buildDashboardDefinitions(): Array<{ id: string; title: string; panels: string[]; slo: string }> {
  return [
    { id: "provider-health", title: "Provider health and canaries", panels: ["canary success", "flow failures", "selector misses"], slo: "provider canary failure detected within scheduled interval" },
    { id: "queue-health", title: "Queue and DLQ health", panels: ["queue depth", "oldest task age", "DLQ count"], slo: "stuck task detected within configured timeout" },
    { id: "proof-coverage", title: "Irreversible action proof coverage", panels: ["application proof", "reply proof", "scheduling proof"], slo: "100% proof-bearing irreversible actions" },
    { id: "funnel", title: "Job-search funnel", panels: ["discovered", "shortlisted", "prepared", "responses", "interviews"], slo: "daily funnel report available" }
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

function prometheusMetricKey(key: string): string {
  const match = key.match(/^([^{]+)(?:\{(.*)\})?$/);
  if (!match) {
    return sanitizePrometheusName(key);
  }
  const name = sanitizePrometheusName(match[1]!);
  const labels = match[2];
  if (!labels) {
    return name;
  }
  const renderedLabels = labels
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [labelName = "", ...valueParts] = entry.split("=");
      return `${sanitizePrometheusName(labelName)}="${escapePrometheusLabelValue(valueParts.join("="))}"`;
    })
    .join(",");
  return `${name}{${renderedLabels}}`;
}

function sanitizePrometheusName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[a-zA-Z_:]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
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

function hashForTrace(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
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
