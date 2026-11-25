import { useEffect, useRef, useState } from "react";
import {
  connectionName,
  serviceName,
  type ConnectionView,
  type CrewMember,
  type TeamChoice,
} from "../../../server/shared";
import { usePresence } from "../motion";
import { Icon } from "./Icon";
import { MemberLogo, ProviderLogo } from "./ProviderLogo";

interface Props {
  team: TeamChoice;
  crew: CrewMember[];
  connections: ConnectionView[];
  onTeam: (t: TeamChoice) => void;
  onEditCrew: () => void;
}

interface SoloOption {
  key: string;
  connectionId: string;
  model?: string;
  name: string;
  via: string;
  conn: ConnectionView;
}

/** Every model you can run alone: each connection's default, plus models your crew uses. */
export function soloOptions(
  connections: ConnectionView[],
  crew: CrewMember[],
): SoloOption[] {
  const out = new Map<string, SoloOption>();
  const add = (conn: ConnectionView, model?: string) => {
    const m = model || conn.defaultModel;
    const key = `${conn.id}|${m ?? ""}`;
    if (out.has(key)) return;
    out.set(key, {
      key,
      connectionId: conn.id,
      model: model || undefined,
      name: m ? connectionName(conn.kind, conn.baseUrl, m) : conn.label,
      via: conn.acp?.agentName ?? serviceName(conn.kind, conn.baseUrl),
      conn,
    });
  };
  connections.forEach((c) => add(c));
  crew.forEach((m) => {
    const c = connections.find((x) => x.id === m.connectionId);
    if (c && m.model) add(c, m.model);
  });
  return [...out.values()];
}

/** Choose who works: Auto (MultiCode builds the team), your crew, or one model alone. */
export function TeamPicker(p: Props) {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, 160);
  const ref = useRef<HTMLDivElement>(null);
  const solos = soloOptions(p.connections, p.crew);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  const pick = (t: TeamChoice) => {
    p.onTeam(t);
    setOpen(false);
  };
  const solo =
    p.team.kind === "solo"
      ? solos.find(
          (s) =>
            s.connectionId ===
              (p.team as { connectionId: string }).connectionId &&
            s.model === (p.team as { model?: string }).model,
        )
      : undefined;

  const autoLogos = p.connections.map((c) => (
    <ProviderLogo
      key={c.id}
      kind={c.kind}
      acp={c.acp}
      baseUrl={c.baseUrl}
      model={c.defaultModel}
      size={12}
    />
  ));
  const crewLogos = p.crew.map((m) => (
    <MemberLogo key={m.id} member={m} connections={p.connections} size={12} />
  ));
  const current =
    p.team.kind === "auto"
      ? { logos: autoLogos, label: "Auto" }
      : p.team.kind === "solo" && solo
        ? {
            logos: [
              <ProviderLogo
                key="s"
                kind={solo.conn.kind}
                acp={solo.conn.acp}
                baseUrl={solo.conn.baseUrl}
                model={solo.model || solo.conn.defaultModel}
                size={12}
              />,
            ],
            label: solo.name,
          }
        : {
            logos: crewLogos,
            label:
              p.crew.length === 0
                ? "No crew yet"
                : p.crew.length === 1
                  ? p.crew[0]!.name
                  : `Crew of ${p.crew.length}`,
          };

  return (
    <div className="team-picker push-right" ref={ref}>
      {presence.mounted && (
        <div
          className={`menu-pop team-pop ${presence.closing ? "is-closing" : ""}`}
          role="menu"
          inert={!open}
        >
          <div className="team-head">Who works on this</div>
          <TeamItem
            active={p.team.kind === "auto"}
            title="Auto"
            text={`MultiCode builds the team from all ${p.connections.length} connection${p.connections.length === 1 ? "" : "s"}: the strongest model plans, the next reviews, the rest build.`}
            logos={autoLogos}
            onClick={() => pick({ kind: "auto" })}
          />
          <TeamItem
            active={p.team.kind === "crew"}
            title="My crew"
            text={
              p.crew.length
                ? `${p.crew.length} agent${p.crew.length === 1 ? "" : "s"} with the roles you set.`
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
          <div className="team-sep">Single model</div>
          <div className="team-solos">
            {solos.map((s) => (
              <button
                key={s.key}
                type="button"
                role="menuitemradio"
                aria-checked={solo?.key === s.key}
                className={`menu-item team-solo ${solo?.key === s.key ? "is-active" : ""}`}
                onClick={() =>
                  pick({
                    kind: "solo",
                    connectionId: s.connectionId,
                    ...(s.model ? { model: s.model } : {}),
                  })
                }
              >
                <ProviderLogo
                  kind={s.conn.kind}
                  acp={s.conn.acp}
                  baseUrl={s.conn.baseUrl}
                  model={s.model || s.conn.defaultModel}
                  size={15}
                />
                <span className="truncate">{s.name}</span>
                <span className="muted small truncate team-via">{s.via}</span>
                {solo?.key === s.key && (
                  <Icon name="check" size={14} className="team-check" />
                )}
              </button>
            ))}
            {solos.length === 0 && (
              <p className="muted small team-empty">Connect an AI first.</p>
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
        <span
          className="crew-logos"
          aria-hidden
          key={p.team.kind + current.label}
        >
          {current.logos.slice(0, 4).map((l, i) => (
            <span key={i} className="crew-logo">
              {l}
            </span>
          ))}
          {current.logos.length > 4 && (
            <span className="crew-logo crew-more">
              +{current.logos.length - 4}
            </span>
          )}
        </span>
        <span className="truncate team-label">{current.label}</span>
        <Icon name="chevronDown" size={13} className="team-chevron" />
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
