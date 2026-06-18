export function JsonView({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  const out: React.ReactNode[] = [];
  out.push(
    <span key="open" className="json-punct" data-testid="json-punct">
      {"{\n"}
    </span>,
  );
  entries.forEach(([k, v], i) => {
    const comma = i < entries.length - 1 ? "," : "";
    let valNode: React.ReactNode;
    if (v === null) valNode = <span className="json-num" data-testid="json-num">null</span>;
    else if (typeof v === "number" || typeof v === "boolean") valNode = <span className="json-num" data-testid="json-num">{String(v)}</span>;
    else valNode = <span className="json-str" data-testid="json-str">{JSON.stringify(String(v))}</span>;
    out.push(
      <span key={`r${i}`}>
        {"  "}
        <span className="json-key" data-testid="json-key">{JSON.stringify(k)}</span>
        <span className="json-punct" data-testid="json-punct">: </span>
        {valNode}
        <span className="json-punct" data-testid="json-punct">{comma}</span>
        {"\n"}
      </span>,
    );
  });
  out.push(
    <span key="close" className="json-punct" data-testid="json-punct">
      {"}"}
    </span>,
  );
  return <>{out}</>;
}
