/**
 * Unit tests for the pre-believe policy hook.
 *
 * Covers:
 *   - empty / absent lists → allow by default
 *   - exact predicate deny / allow
 *   - glob-prefix subject allow / deny ("scene:*", "scene:admin/*")
 *   - max_object_bytes enforced via UTF-8 byte count (not char count)
 *   - first-match-wins evaluation order
 *   - file loader: missing, non-JSON, invalid-schema, valid
 *   - env resolver returns null when WEAVORY_POLICY_FILE is unset
 *   - integration with ops.believe: denial throws PolicyDenialError;
 *     allow lets the call complete normally
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compile,
  evaluate,
  loadPolicy,
  policyPathFromEnv,
  PolicyDenialError,
  type Policy,
  type PolicyFile,
} from "../../../src/engine/policy.js";
import { EngineState } from "../../../src/engine/state.js";
import { believe } from "../../../src/engine/ops.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "weavory-policy-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function p(fields: Partial<PolicyFile> = {}): Policy {
  return compile({ version: "1.0.0", ...fields });
}

// ---------- default / empty policy ----------

describe("policy — defaults", () => {
  it("an empty policy allows everything", () => {
    const r = evaluate(p(), { subject: "anything", predicate: "obs", object: { x: 1 } });
    expect(r.allowed).toBe(true);
  });

  it("empty arrays are treated as unset (everything allowed)", () => {
    const r = evaluate(
      p({ subject_allow: [], predicate_allow: [] }),
      { subject: "anything", predicate: "obs", object: { x: 1 } }
    );
    expect(r.allowed).toBe(true);
  });
});

// ---------- predicate rules ----------

describe("policy — predicate", () => {
  it("predicate_deny exact match → deny", () => {
    const r = evaluate(p({ predicate_deny: ["internal.secret"] }), {
      subject: "s",
      predicate: "internal.secret",
      object: {},
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.rule).toBe("predicate_deny");
  });

  it("predicate_allow set and match missing → deny", () => {
    const r = evaluate(p({ predicate_allow: ["observation"] }), {
      subject: "s",
      predicate: "claim",
      object: {},
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.rule).toBe("predicate_allow");
  });

  it("predicate_allow set and match present → allow", () => {
    const r = evaluate(p({ predicate_allow: ["observation"] }), {
      subject: "s",
      predicate: "observation",
      object: {},
    });
    expect(r.allowed).toBe(true);
  });
});

// ---------- subject rules (glob) ----------

describe("policy — subject globs", () => {
  it('"scene:*" allows any subject starting with "scene:"', () => {
    const pol = p({ subject_allow: ["scene:*"] });
    expect(evaluate(pol, { subject: "scene:rome", predicate: "obs", object: {} }).allowed).toBe(true);
    expect(evaluate(pol, { subject: "agent:alice", predicate: "obs", object: {} }).allowed).toBe(
      false
    );
  });

  it("subject_deny takes precedence over subject_allow on overlap", () => {
    const pol = p({
      subject_allow: ["scene:*"],
      subject_deny: ["scene:admin/*"],
    });
    expect(evaluate(pol, { subject: "scene:rome", predicate: "obs", object: {} }).allowed).toBe(true);
    expect(
      evaluate(pol, { subject: "scene:admin/users", predicate: "obs", object: {} }).allowed
    ).toBe(false);
  });

  it("exact subject match (no trailing *) works", () => {
    const r = evaluate(
      p({ subject_allow: ["agent:root"] }),
      { subject: "agent:root", predicate: "obs", object: {} }
    );
    expect(r.allowed).toBe(true);
  });
});

// ---------- size cap ----------

describe("policy — max_object_bytes", () => {
  it("deny when object bytes exceed the cap", () => {
    const pol = p({ max_object_bytes: 16 });
    const r = evaluate(pol, { subject: "s", predicate: "obs", object: { x: "0123456789abcde" } });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.rule).toBe("max_object_bytes");
  });

  it("counts UTF-8 bytes, not characters (four-byte emoji ≠ one byte)", () => {
    // The rocket emoji 🚀 encodes as 4 UTF-8 bytes.
    // JSON.stringify wraps it in quotes → 6 bytes total ("\u{1F680}" surrogate,
    // but String.fromCodePoint returns the full character).
    const emoji = "🚀";
    const pol = p({ max_object_bytes: 5 });
    const r = evaluate(pol, { subject: "s", predicate: "obs", object: emoji });
    expect(r.allowed).toBe(false);
  });

  it("under-cap passes cleanly", () => {
    const pol = p({ max_object_bytes: 1024 });
    const r = evaluate(pol, { subject: "s", predicate: "obs", object: { foo: "bar" } });
    expect(r.allowed).toBe(true);
  });
});

// ---------- file loader ----------

describe("policy — file loader", () => {
  it("loads + parses a valid policy file", () => {
    const path = join(tmpDir, "policy.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: "1.0.0",
        subject_allow: ["scene:*"],
        predicate_allow: ["observation"],
      })
    );
    const pol = loadPolicy(path);
    expect(pol.raw.subject_allow).toEqual(["scene:*"]);
    expect(pol.maxObjectBytes).toBe(1024 * 1024);
  });

  it("throws on missing file with a clear message", () => {
    expect(() => loadPolicy(join(tmpDir, "missing.json"))).toThrow(/cannot read file/);
  });

  it("throws on invalid JSON", () => {
    const path = join(tmpDir, "broken.json");
    writeFileSync(path, "{not json");
    expect(() => loadPolicy(path)).toThrow(/not valid JSON/);
  });

  it("throws on schema violation (missing version)", () => {
    const path = join(tmpDir, "noversion.json");
    writeFileSync(path, JSON.stringify({ subject_allow: ["scene:*"] }));
    expect(() => loadPolicy(path)).toThrow(/failed validation/);
  });

  it("rejects unexpected version strings", () => {
    const path = join(tmpDir, "badversion.json");
    writeFileSync(path, JSON.stringify({ version: "2.0.0" }));
    expect(() => loadPolicy(path)).toThrow(/failed validation/);
  });
});

// ---------- env helper ----------

describe("policy — policyPathFromEnv", () => {
  it("null when unset", () => {
    expect(policyPathFromEnv({})).toBeNull();
  });
  it("null when set to empty string", () => {
    expect(policyPathFromEnv({ WEAVORY_POLICY_FILE: "  " })).toBeNull();
  });
  it("returns the path when set", () => {
    expect(policyPathFromEnv({ WEAVORY_POLICY_FILE: "/etc/weavory/policy.json" })).toBe(
      "/etc/weavory/policy.json"
    );
  });
});

// ---------- integration with believe() ----------

describe("policy — integration with ops.believe", () => {
  it("no policy attached = believe() works as before", () => {
    const s = new EngineState();
    const out = believe(s, {
      subject: "scene:rome",
      predicate: "observation",
      object: { x: 1 },
      signer_seed: "alice",
    });
    expect(out.id.length).toBe(64);
  });

  it("policy denying the predicate throws PolicyDenialError before signing", () => {
    const s = new EngineState();
    s.attachPolicy(p({ predicate_deny: ["observation"] }));
    expect(() =>
      believe(s, {
        subject: "scene:rome",
        predicate: "observation",
        object: { x: 1 },
        signer_seed: "alice",
      })
    ).toThrow(PolicyDenialError);

    // Side-effect check: no belief / audit entry was recorded.
    expect(s.beliefs.size).toBe(0);
    expect(s.audit.length()).toBe(0);
  });

  it("policy denying by subject_deny is reported with the correct rule", () => {
    const s = new EngineState();
    s.attachPolicy(p({ subject_deny: ["scene:admin/*"] }));
    try {
      believe(s, {
        subject: "scene:admin/users",
        predicate: "observation",
        object: {},
        signer_seed: "alice",
      });
      expect.fail("expected PolicyDenialError");
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDenialError);
      if (err instanceof PolicyDenialError) {
        expect(err.rule).toBe("subject_deny");
      }
    }
  });
});
