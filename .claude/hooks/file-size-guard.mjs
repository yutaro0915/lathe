#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

const LIMIT_LINES = 500;
const mode = process.argv[2];

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parseJson(raw) {
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

function lineCount(value) {
  if (typeof value !== "string" || value.length === 0) {
    return 0;
  }
  const newlines = value.match(/\n/g)?.length ?? 0;
  return newlines + (value.endsWith("\n") ? 0 : 1);
}

function payloadLineCount(toolInput) {
  const payloads = [toolInput?.content, toolInput?.new_string].filter(
    (value) => typeof value === "string",
  );
  if (payloads.length === 0) {
    return 0;
  }
  return Math.max(...payloads.map(lineCount));
}

function fileLineCount(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return 0;
  }
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return 0;
  }
  return lineCount(fs.readFileSync(filePath, "utf8"));
}

function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

const input = parseJson(await readStdin());
const toolInput = input.tool_input ?? {};
const payloadLines = payloadLineCount(toolInput);

if (mode === "pre") {
  if (payloadLines > LIMIT_LINES) {
    block(
      `file-size guard: tool payload is ${payloadLines} lines; limit is ${LIMIT_LINES}`,
    );
  }
  process.exit(0);
}

if (mode === "post") {
  const actualLines = fileLineCount(toolInput.file_path);
  if (actualLines > LIMIT_LINES && payloadLines > 0) {
    block(
      `file-size guard: ${toolInput.file_path} is ${actualLines} lines; limit is ${LIMIT_LINES}`,
    );
  }
  process.exit(0);
}

process.stderr.write("usage: file-size-guard.mjs pre|post\n");
process.exit(1);
