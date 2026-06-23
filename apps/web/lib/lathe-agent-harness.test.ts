import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { PermissionRequest } from "@lathe/acp-client";
import {
  allowLathePermission,
  permissionToolName,
  type LathePermissionPolicy,
} from "./lathe-agent-harness";

const permissionOptions: PermissionRequest["options"] = [
  { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
  { kind: "reject_once", name: "Reject once", optionId: "reject-once" },
];

function request(toolCall: PermissionRequest["toolCall"]): PermissionRequest {
  return {
    sessionId: "session-1",
    options: permissionOptions,
    toolCall,
  };
}

function assertPermission(policy: LathePermissionPolicy, toolName: string, optionId: string): void {
  assert.deepEqual(
    allowLathePermission(policy, request({ name: toolName })),
    { outcome: "selected", optionId },
    `${policy} ${toolName}`,
  );
}

test("permissionToolName reads tool identifiers in precedence order", () => {
  const cases: Array<{ name: string; toolCall: PermissionRequest["toolCall"]; expected: string }> = [
    {
      name: "name wins",
      toolCall: {
        name: "from-name",
        toolName: "from-toolName",
        _meta: { toolName: "from-meta" },
        title: "from-title",
      },
      expected: "from-name",
    },
    {
      name: "toolName wins without name",
      toolCall: {
        toolName: "from-toolName",
        _meta: { toolName: "from-meta" },
        title: "from-title",
      },
      expected: "from-toolName",
    },
    {
      name: "meta toolName wins without direct names",
      toolCall: {
        _meta: { toolName: "from-meta" },
        title: "from-title",
      },
      expected: "from-meta",
    },
    {
      name: "title is fallback",
      toolCall: { title: "from-title" },
      expected: "from-title",
    },
  ];

  for (const { name, toolCall, expected } of cases) {
    assert.equal(permissionToolName(request(toolCall)), expected, name);
  }
});

test("permissionToolName returns an empty string when no string tool identifier exists", () => {
  const cases: PermissionRequest["toolCall"][] = [
    {},
    { name: 12, toolName: false, _meta: ["not", "an", "object"], title: null },
    { _meta: { toolName: 99 } },
  ];

  for (const toolCall of cases) assert.equal(permissionToolName(request(toolCall)), "");
});

test("allowLathePermission chat-readonly allows only read-only lathe tools", () => {
  const allowed = [
    "mcp__lathe__list_sessions",
    "mcp__lathe__get_session_bundle",
    "mcp__lathe__query_findings",
    "mcp__lathe__get_evidence_context",
    "list_sessions",
    "get_session_bundle",
    "query_findings",
    "get_evidence_context",
  ];
  const denied = [
    "mcp__lathe__submit_finding",
    "submit_finding",
    "edit",
    "bash",
    "unknown",
  ];

  for (const toolName of allowed) assertPermission("chat-readonly", toolName, "allow-once");
  for (const toolName of denied) assertPermission("chat-readonly", toolName, "reject-once");
});

test("allowLathePermission analyst-submit allows only submit_finding tools", () => {
  const allowed = ["mcp__lathe__submit_finding", "submit_finding"];
  const denied = [
    "mcp__lathe__list_sessions",
    "mcp__lathe__get_session_bundle",
    "mcp__lathe__query_findings",
    "mcp__lathe__get_evidence_context",
    "list_sessions",
    "get_session_bundle",
    "query_findings",
    "get_evidence_context",
    "edit",
    "bash",
    "unknown",
  ];

  for (const toolName of allowed) assertPermission("analyst-submit", toolName, "allow-once");
  for (const toolName of denied) assertPermission("analyst-submit", toolName, "reject-once");
});
