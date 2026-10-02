import { useMemo, useState } from "react";
import type { LogEntry } from "../types";
import { Card } from "./ui";

const LEVELS = ["all", "info", "success", "warn", "error"] as const;

export function Logs({
  entries,
  onClear,
}: {
  entries: LogEntry[];
  onClear: () => void;
}) {
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);

  const filtered = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (level === "all" || entry.level === level) &&
          (!query || (entry.message + entry.scope).toLowerCase().includes(query.toLowerCase())),
      ),
    [entries, level, query],
  );

  return (
    <Card
      title="Logs"
      tight
      actions={
        <div style={{ display: "flex", gap: 8 }}>
          <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
            {filtered.length} / {entries.length}
          </span>
          <button className="btn small ghost" onClick={onClear}>
            Clear
          </button>
        </div>
      }
    >
      <div className="log-toolbar" style={{ margin: "0 -16px" }}>
        <select value={level} onChange={(e) => setLevel(e.target.value as (typeof LEVELS)[number])} style={{ width: 130 }}>
          {LEVELS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ maxWidth: 280 }}
        />
        <label className="switch" style={{ marginLeft: "auto" }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          <span className="switch-text">
            <strong>Follow</strong>
          </span>
        </label>
      </div>

      <div className="log-list" style={{ margin: "0 -16px", paddingBottom: 12 }}>
        {filtered.length === 0 ? (
          <div className="empty" style={{ padding: 40 }}>
            Nothing logged yet. Start the server or run a probe.
          </div>
        ) : null}
        {filtered.map((entry) => (
          <div className="log-line" key={entry.id}>
            <span className="t">{entry.at.slice(11, 19)}</span>
            <span className={`lv ${entry.level}`}>{entry.level}</span>
            <span className="sc">{entry.scope}</span>
            <span className="m">{entry.message}</span>
          </div>
        ))}
      </div>
      {follow ? <FollowAnchor count={filtered.length} /> : null}
    </Card>
  );
}

function FollowAnchor({ count }: { count: number }) {
  // A tiny element at the end of the list; scrolling it into view keeps the
  // newest line visible without re-rendering the whole page.
  return (
    <div
      style={{ height: 0 }}
      ref={(el) => {
        if (el && count) el.scrollIntoView({ block: "end" });
      }}
    />
  );
}
