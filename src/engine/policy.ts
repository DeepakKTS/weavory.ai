/**
 * weavory.ai — pre-believe policy hook (Phase I.P0-4)
 *
 * A small, fast, deterministic gate that runs BEFORE `believe()` signs and
 * stores a payload. When no policy is configured, this module is a no-op by
 * design — Phase-1 semantics are preserved exactly.
 *
 * Policy file format (JSON, loaded once at startup from WEAVORY_POLICY_FILE):
 *
 *   {
 *     "version": "1.0.0",
 *     "subject_allow": ["scene:*", "agent:*"],          // optional glob list
 *     "subject_deny":  ["scene:admin/*"],               // optional glob list
 *     "predicate_allow": ["observation", "claim"],      // optional exact list
 *     "predicate_deny":  ["internal.secret"],           // optional exact list
 *     "max_object_bytes": 65536                         // optional, default 1 MiB
 *   }
 *
 * Evaluation order (short-circuit on first deny):
 *   1. max_object_bytes — exceeded → deny
 *   2. predicate_deny   — matches  → deny
 *   3. predicate_allow  — present and doesn't match → deny
 *   4. subject_deny     — matches  → deny
 *   5. subject_allow    — present and doesn't match → deny
 *   6. otherwise → allow
 *
 * Empty or absent allow-lists mean "everything allowed"; the policy is
 * permissive by default and tightened only via explicit entries. This matches
 * SOC2 CC6.1 "least privilege" when operators define the allow-list, but
 * stays invisible for hackathon demos.
 *
 * Subject globs support exactly two forms:
 *   - trailing "*" for prefix match ("scene:*" matches "scene:rome")
 *   - exact match ("observation")
 * No regex — deliberately, to make policy files diff-reviewable.
 *
 * Predicate match is exact only. Predicates are a small vocabulary in
 * practice, so globbing would over-deliver.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { JsonValue } from "../core/schema.js";

const DEFAULT_MAX_OBJECT_BYTES = 1 * 1024 * 1024; // 1 MiB

export const PolicyFileSchema = z
  .object({
    version: z.literal("1.0.0"),
    subject_allow: z.array(z.string().min(1).max(2048)).optional(),
    subject_deny: z.array(z.string().min(1).max(2048)).optional(),
    predicate_allow: z.array(z.string().min(1).max(512)).optional(),
    predicate_deny: z.array(z.string().min(1).max(512)).optional(),
    max_object_bytes: z.number().int().positive().max(16 * 1024 * 1024).optional(),
  })
  .strict();

export type PolicyFile = z.infer<typeof PolicyFileSchema>;

/** Runtime-compiled policy (glob patterns pre-parsed). */
export type Policy = {
  raw: PolicyFile;
  maxObjectBytes: number;
};

export type PolicyDenial = {
  allowed: false;
  rule: string;
  message: string;
};
export type PolicyAllow = { allowed: true };
export type PolicyResult = PolicyAllow | PolicyDenial;

/** Public input shape matching what ops.believe() has available at the gate. */
export type BelieveGateInput = {
  subject: string;
  predicate: string;
  object: JsonValue;
};

/**
 * Load + compile a policy from a filesystem path. Throws on IO errors or
 * schema violations so the CLI fails loudly at startup rather than silently
 * operating with an invalid policy.
 */
export function loadPolicy(path: string): Policy {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`policy: cannot read file ${path}: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`policy: ${path} is not valid JSON: ${reason}`);
  }
  const result = PolicyFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join("; ");
    throw new Error(`policy: ${path} failed validation: ${issues}`);
  }
  return compile(result.data);
}

/** Compile a validated PolicyFile into runtime form. */
export function compile(raw: PolicyFile): Policy {
  return {
    raw,
    maxObjectBytes: raw.max_object_bytes ?? DEFAULT_MAX_OBJECT_BYTES,
  };
}

/**
 * Evaluate a believe() candidate against a policy. Returns either
 * { allowed: true } or { allowed: false, rule, message }.
 *
 * Deterministic and cheap: stringifies the object once to size-check, then
 * runs four list checks. Safe to call on the believe() hot path.
 */
export function evaluate(policy: Policy, input: BelieveGateInput): PolicyResult {
  // 1. object size cap
  const objStr = JSON.stringify(input.object);
  const objBytes = Buffer.byteLength(objStr, "utf8");
  if (objBytes > policy.maxObjectBytes) {
    return {
      allowed: false,
      rule: "max_object_bytes",
      message: `object payload ${objBytes} bytes exceeds max ${policy.maxObjectBytes}`,
    };
  }

  // 2. predicate deny
  if (policy.raw.predicate_deny && policy.raw.predicate_deny.includes(input.predicate)) {
    return {
      allowed: false,
      rule: "predicate_deny",
      message: `predicate "${input.predicate}" is on the deny-list`,
    };
  }

  // 3. predicate allow (if set)
  if (
    policy.raw.predicate_allow &&
    policy.raw.predicate_allow.length > 0 &&
    !policy.raw.predicate_allow.includes(input.predicate)
  ) {
    return {
      allowed: false,
      rule: "predicate_allow",
      message:
        `predicate "${input.predicate}" is not on the allow-list ` +
        `(${policy.raw.predicate_allow.length} entries)`,
    };
  }

  // 4. subject deny
  if (policy.raw.subject_deny) {
    for (const pat of policy.raw.subject_deny) {
      if (matchSubjectGlob(pat, input.subject)) {
        return {
          allowed: false,
          rule: "subject_deny",
          message: `subject "${input.subject}" matches deny pattern "${pat}"`,
        };
      }
    }
  }

  // 5. subject allow (if set)
  if (policy.raw.subject_allow && policy.raw.subject_allow.length > 0) {
    let any = false;
    for (const pat of policy.raw.subject_allow) {
      if (matchSubjectGlob(pat, input.subject)) {
        any = true;
        break;
      }
    }
    if (!any) {
      return {
        allowed: false,
        rule: "subject_allow",
        message:
          `subject "${input.subject}" matches no allow pattern ` +
          `(${policy.raw.subject_allow.length} entries)`,
      };
    }
  }

  return { allowed: true };
}

/** Glob match: trailing "*" is prefix, otherwise exact. No other metacharacters. */
function matchSubjectGlob(pattern: string, subject: string): boolean {
  if (pattern.endsWith("*")) {
    return subject.startsWith(pattern.slice(0, -1));
  }
  return subject === pattern;
}

/**
 * Error thrown by the gate so callers (ops.believe) can distinguish policy
 * denial from other errors (schema failure, unknown cause id, etc.).
 */
export class PolicyDenialError extends Error {
  readonly rule: string;
  constructor(denial: PolicyDenial) {
    super(`policy denial (${denial.rule}): ${denial.message}`);
    this.name = "PolicyDenialError";
    this.rule = denial.rule;
  }
}

/** Resolve policy file path from env; null means no policy (disabled). */
export function policyPathFromEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.WEAVORY_POLICY_FILE ?? "").trim();
  return raw.length > 0 ? raw : null;
}
