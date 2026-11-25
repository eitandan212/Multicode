import { useEffect, useRef, useState } from "react";
import {
  connectionName,
  serviceName,
  type ConnectionView,
  type CrewMember,
  type ManagerView,
  type TeamChoice,
} from "../../../server/shared";
import { api } from "../api";
import { usePresence } from "../motion";
import { Icon } from "./Icon";
import { MemberLogo, ProviderLogo } from "./ProviderLogo";

interface Props {
  team: TeamChoice;
  crew: CrewMember[];
  connections: ConnectionView[];
  onTeam: (t: TeamChoice) => void;
  onEditCrew: () => void;
  manager?: ManagerView | null;
}

const modelLists = new Map<string, Promise<string[]>>();
function modelsOf(id: string): Promise<string[]> {
  if (!modelLists.has(id))
    modelLists.set(
      id,
      api.models(id).then(
        (r) => r.models,
        () => [],
      ),
    );
  return modelLists.get(id)!;
}

/**
 * Who works, picked the way T3 Code picks a model: a rail of providers on the left (plus the
 * team), searchable models on the right. A model runs alone; Auto and My crew run together.
 */
export function TeamPicker(p: Props) {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, 160);
  const ref = useRef<HTMLDivElement>(null);
  const [rail, setRail] = useState<string>("team");
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const conn = p.connections.find((c) => c.id === rail);

  useEffect(() => {
    if (!open) return;
    setRail(p.team.kind === "solo" ? p.team.connectionId : "team");
    setQuery("");
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
    // Only when the popover opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!conn) return;
    let live = true;
    setModels(null);
    void modelsOf(conn.id).then((m) => live && setModels(m));
    return () => {
      live = false;
    };
  }, [conn]);

  const pick = (t: TeamChoice) => {
    p.onTeam(t);
    setOpen(false);
  };

  const soloConn =
    p.team.kind === "solo"
      ? p.connections.find(
          (c) => c.id === (p.team as { connectionId: string }).connectionId,
        )
      : undefined;
  const soloModel =
    p.team.kind === "solo" ? p.team.model || soloConn?.defaultModel : undefined;
  const autoLogos = p.connections.map((c) => (
    <ProviderLogo
      key={c.id}
      kind={c.kind}
      acp={c.acp}
      baseUrl={c.baseUrl}
      model={c.defaultModel}
      size={13}
    />
  ));
  const crewLogos = p.crew.map((m) => (
    <MemberLogo key={m.id} member={m} connections={p.connections} size={13} />
  ));
  const chip =
    p.team.kind === "solo" && soloConn
      ? {
          logos: [
            <ProviderLogo
              key="s"
              kind={soloConn.kind}
              acp={soloConn.acp}
              baseUrl={soloConn.baseUrl}
              model={soloModel}
              size={14}
            />,
          ],
          label: soloModel
            ? connectionName(soloConn.kind, soloConn.baseUrl, soloModel)
            : soloConn.label,
        }
      : p.team.kind === "crew"
        ? {
            logos: crewLogos,
            label:
              p.crew.length === 1
                ? p.crew[0]!.name
                : `Crew of ${p.crew.length}`,
          }
        : { logos: autoLogos, label: "Auto" };

  const q = query.trim().toLowerCase();
  const list = conn
    ? [...new Set([conn.defaultModel ?? "", ...(models ?? [])])].filter(
        (m) =>
          !q ||
          (m || "default").toLowerCase().includes(q) ||
          connectionName(conn.kind, conn.baseUrl, m).toLowerCase().includes(q),
      )
    : [];

  return (
    <div className="team-picker push-right" ref={ref}>
      {presence.mounted && (
        <div
          className={`menu-pop team-pop ${presence.closing ? "is-closing" : ""}`}
          role="menu"
          inert={!open}
        >
          <div className="team-body">
            <div className="team-rail" role="tablist" aria-label="Providers">
              <button
                role="tab"
                aria-selected={rail === "team"}
                className={`team-rail-btn ${rail === "team" ? "is-active" : ""}`}
                onClick={() => setRail("team")}
                title="Models working together"
              >
                <Icon name="users" size={16} />
              </button>
              {p.connections.map((c) => (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={rail === c.id}
                  className={`team-rail-btn ${rail === c.id ? "is-active" : ""}`}
                  onClick={() => setRail(c.id)}
                  title={c.label}
                >
                  <ProviderLogo
                    kind={c.kind}
                    acp={c.acp}
                    baseUrl={c.baseUrl}
                    model={c.defaultModel}
                    size={17}
                  />
                </button>
              ))}
            </div>
            <div className="team-list">
              {rail === "team" ? (
                <>
                  <div className="team-list-head">Together</div>
                  <TeamItem
                    active={p.team.kind === "auto"}
                    title="Auto"
                    text={`MultiCode builds the team from your ${p.connections.length} connection${p.connections.length === 1 ? "" : "s"}.`}
                    logos={autoLogos}
                    onClick={() => pick({ kind: "auto" })}
                  />
                  <TeamItem
                    active={p.team.kind === "crew"}
                    title="My crew"
                    text={
                      p.crew.length
                        ? `${p.crew.length} agent${p.crew.length === 1 ? "" : "s"}: planner, builders and reviewers.`
                        : "Set up who plans, builds and reviews."
                    }
                    logos={crewLogos}
                    onClick={() => pick({ kind: "crew" })}
                    extra={
                      <button
                        type="button"
                        className="link small"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(false);
                          p.onEditCrew();
                        }}
                      >
                        Edit
                      </button>
                    }
                  />
                  <p className="muted small team-hint">
                    Or pick one model on the left to work alone.
                  </p>
                </>
              ) : conn ? (
                <>
                  <label className="team-search">
                    <Icon name="search" size={14} />
                    <input
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search models..."
                      aria-label="Search models"
                    />
                  </label>
                  <div className="team-models">
                    {models === null && (
                      <p className="muted small team-empty">Loading models…</p>
                    )}
                    {models !== null && list.length === 0 && (
                      <p className="muted small team-empty">No models found</p>
                    )}
                    {list.map((m) => {
                      const active =
                        p.team.kind === "solo" &&
                        p.team.connectionId === conn.id &&
                        (p.team.model || conn.defaultModel || "") === m;
                      return (
                        <button
                          key={m || "default"}
                          role="menuitemradio"
                          aria-checked={active}
                          className={`menu-item team-solo ${active ? "is-active" : ""}`}
                          onClick={() =>
                            pick({
                              kind: "solo",
                              connectionId: conn.id,
                              ...(m && m !== conn.defaultModel
                                ? { model: m }
                                : {}),
                            })
                          }
                        >
                          <ProviderLogo
                            kind={conn.kind}
                            acp={conn.acp}
                            baseUrl={conn.baseUrl}
                            model={m || conn.defaultModel}
                            size={15}
                          />
                          <span className="truncate">
                            {m
                              ? connectionName(conn.kind, conn.baseUrl, m)
                              : `${conn.label} default`}
                          </span>
                          {m && (
                            <span className="muted small truncate team-via">
                              {m}
                            </span>
                          )}
                          {active && (
                            <Icon
                              name="check"
                              size={14}
                              className="team-check"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <div className="team-foot small">
            {p.manager ? (
              <>
                <ProviderLogo
                  kind={p.manager.kind}
                  baseUrl={p.manager.baseUrl}
                  model={p.manager.model}
                  size={13}
                />
                <span className="truncate">
                  Managed by <b>{p.manager.name}</b>
                </span>
              </>
            ) : (
              <span className="muted">
                No manager: the planner assigns the tasks
              </span>
            )}
            {conn && (
              <span className="muted push-right truncate">
                {conn.acp?.agentName ?? serviceName(conn.kind, conn.baseUrl)}
              </span>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        className={`chip crew-chip ${open ? "is-open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose who works: Auto, your crew or one model"
      >
        <span className="crew-logos" aria-hidden key={p.team.kind + chip.label}>
          {chip.logos.slice(0, 4).map((l, i) => (
            <span key={i} className="crew-logo">
              {l}
            </span>
          ))}
          {chip.logos.length > 4 && (
            <span className="crew-logo crew-more">
              +{chip.logos.length - 4}
            </span>
          )}
        </span>
        <span className="truncate team-label">{chip.label}</span>
      </button>
    </div>
  );
}

function TeamItem(props: {
  active: boolean;
  title: string;
  text: string;
  logos: React.ReactNode[];
  onClick: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div
      role="menuitemradio"
      aria-checked={props.active}
      tabIndex={0}
      className={`team-item ${props.active ? "is-active" : ""}`}
      onClick={props.onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onClick();
        }
      }}
    >
      <div className="team-item-top">
        <strong>{props.title}</strong>
        <span className="crew-logos" aria-hidden>
          {props.logos.slice(0, 5).map((l, i) => (
            <span key={i} className="crew-logo">
              {l}
            </span>
          ))}
        </span>
        {props.extra}
        {props.active && <Icon name="check" size={14} className="team-check" />}
      </div>
      <span className="muted small">{props.text}</span>
    </div>
  );
}
