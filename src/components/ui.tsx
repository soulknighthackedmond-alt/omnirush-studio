import type { ReactNode } from "react";

export function Card({
  title,
  actions,
  children,
  tight,
  className,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  tight?: boolean;
  className?: string;
}) {
  return (
    <section className={className ? `card ${className}` : "card"}>
      {title ? (
        <header className="card-head">
          <h2>{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className={tight ? "card-body tight" : "card-body"}>{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  hint?: string;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-text">
        <strong>{title}</strong>
        {hint ? <span>{hint}</span> : null}
      </span>
    </label>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv-row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

export function CopyRow({ value, label = "Copy" }: { value: string; label?: string }) {
  return (
    <div className="copy-row">
      <div className="copy-value" title={value}>
        {value}
      </div>
      <button
        className="btn small"
        onClick={() => {
          navigator.clipboard?.writeText(value);
        }}
      >
        {label}
      </button>
    </div>
  );
}

export function Endpoint({
  method,
  path,
  note,
}: {
  method: "GET" | "POST";
  path: string;
  note: string;
}) {
  return (
    <div className="endpoint">
      <span className={method === "POST" ? "method post" : "method"}>{method}</span>
      <span>{path}</span>
      <span className="note">{note}</span>
    </div>
  );
}

export function Pill({
  tone = "off",
  children,
}: {
  tone?: "on" | "off" | "warn";
  children: ReactNode;
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
