// Recursive JSON syntax highlighter for the documented 3-hue palette
// (keys / strings / numbers — the explicit D10 color-rationing exception, D35).
// Colors come from the --json-key/--json-str/--json-num tokens via the
// json-key/json-str/json-num classes (components.css); mono font via .run-json.
// Recurses into nested objects/arrays so fields like meta:{…} are coloured too.

type Json = unknown;

function punct(key: string, text: string): React.ReactNode {
  return (
    <span key={key} className="json-punct" data-testid="json-punct">
      {text}
    </span>
  );
}

function scalar(value: null | number | boolean | string): React.ReactNode {
  if (typeof value === "string") {
    return (
      <span className="json-str" data-testid="json-str">
        {JSON.stringify(value)}
      </span>
    );
  }
  // null / number / boolean share the numeric hue (matches the prior shallow view).
  return (
    <span className="json-num" data-testid="json-num">
      {value === null ? "null" : String(value)}
    </span>
  );
}

// Renders `value` starting at `depth` (the opening brace/bracket sits at the
// caller's current column; children are indented to depth+1).
function render(value: Json, depth: number, keyPrefix: string): React.ReactNode {
  const pad = "  ".repeat(depth + 1);
  const closePad = "  ".repeat(depth);

  if (Array.isArray(value)) {
    if (value.length === 0) return punct(`${keyPrefix}empty`, "[]");
    const rows: React.ReactNode[] = [];
    rows.push(punct(`${keyPrefix}open`, "[\n"));
    value.forEach((item, i) => {
      const comma = i < value.length - 1 ? "," : "";
      rows.push(
        <span key={`${keyPrefix}i${i}`}>
          {pad}
          {render(item, depth + 1, `${keyPrefix}i${i}.`)}
          {comma}
          {"\n"}
        </span>,
      );
    });
    rows.push(
      <span key={`${keyPrefix}close`}>
        {closePad}
        {punct(`${keyPrefix}closeb`, "]")}
      </span>,
    );
    return <>{rows}</>;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return punct(`${keyPrefix}empty`, "{}");
    const rows: React.ReactNode[] = [];
    rows.push(punct(`${keyPrefix}open`, "{\n"));
    entries.forEach(([k, v], i) => {
      const comma = i < entries.length - 1 ? "," : "";
      rows.push(
        <span key={`${keyPrefix}r${i}`}>
          {pad}
          <span className="json-key" data-testid="json-key">
            {JSON.stringify(k)}
          </span>
          <span className="json-punct" data-testid="json-punct">: </span>
          {render(v, depth + 1, `${keyPrefix}r${i}.`)}
          {comma}
          {"\n"}
        </span>,
      );
    });
    rows.push(
      <span key={`${keyPrefix}close`}>
        {closePad}
        {punct(`${keyPrefix}closeb`, "}")}
      </span>,
    );
    return <>{rows}</>;
  }

  return scalar(value as null | number | boolean | string);
}

export function JsonView({ value }: { value: Json }) {
  return <>{render(value, 0, "")}</>;
}
