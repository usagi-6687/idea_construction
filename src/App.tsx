import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { LazyStore } from "@tauri-apps/plugin-store";

const tauriStore = new LazyStore("network-diagram-data.json");
const STORAGE_KEY = "network-diagram-v1";
const HISTORY_LIMIT = 50;
const GRID_SIZE = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

// Future: expand to { segmentName, nicName, ipAddress, vlan }
type SegmentMembership = { segmentName: string };

// Future: expand to { protocol, port, direction, purpose }
type ProtocolAttribute = { protocol: string };

export type NodeType = "server" | "loadbalancer" | "database" | "monitor" | "user" | "firewall" | "router";
export type EdgeUsage = "business" | "management" | "monitoring" | "custom";

type NetworkNode = {
  id: string; displayName: string; hostname: string; ipAddress: string;
  role: string; note: string; nodeType: NodeType;
  x: number; y: number; w: number; h: number;
  segments: SegmentMembership[]; userTags: string[]; createdAt: number;
};

type NetworkEdge = {
  id: string; sourceId: string; targetId: string;
  direction: "one-way" | "two-way";
  protocols: ProtocolAttribute[];
  usage: EdgeUsage; label: string;
};

type NetworkArea = {
  id: string; name: string; color: string;
  x: number; y: number; w: number; h: number;
  nodeIds: string[];
};

type State = {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  areas: NetworkArea[];
  isSelectionMode: boolean;
  selectedNodeIds: string[];
  hydrated: boolean;
};

type Action =
  | { type: "addNode"; nodeType: NodeType; x: number; y: number }
  | { type: "moveNode"; id: string; x: number; y: number }
  | { type: "updateNode"; id: string; patch: Partial<Omit<NetworkNode, "id" | "createdAt">> }
  | { type: "updateNodeSize"; id: string; w: number; h: number }
  | { type: "deleteSelectedNodes" }
  | { type: "deleteNode"; id: string }
  | { type: "linkSelectedNodes"; direction: "one-way" | "two-way" }
  | { type: "unlinkSelectedNodes" }
  | { type: "updateEdge"; id: string; patch: Partial<Omit<NetworkEdge, "id">> }
  | { type: "deleteEdge"; id: string }
  | { type: "addArea"; name: string; x: number; y: number }
  | { type: "moveArea"; id: string; x: number; y: number }
  | { type: "resizeArea"; id: string; w: number; h: number }
  | { type: "deleteArea"; id: string }
  | { type: "updateArea"; id: string; patch: Partial<Omit<NetworkArea, "id">> }
  | { type: "toggleSelectionMode" }
  | { type: "toggleNodeSelection"; id: string }
  | { type: "clearSelection" }
  | { type: "hydrate"; state: any }
  | { type: "restore"; state: State };

const SKIP_HISTORY = new Set<Action["type"]>([
  "moveNode", "moveArea", "resizeArea", "updateNodeSize", "hydrate", "restore",
]);

// ─── Config ───────────────────────────────────────────────────────────────────

const NODE_TYPE_CONFIG: Record<NodeType, { label: string; bg: string; border: string; icon: string }> = {
  server:       { label: "Server",        bg: "#dbeafe", border: "#3b82f6", icon: "SV" },
  loadbalancer: { label: "Load Balancer", bg: "#d1fae5", border: "#059669", icon: "LB" },
  database:     { label: "Database",      bg: "#fef3c7", border: "#d97706", icon: "DB" },
  monitor:      { label: "Monitor",       bg: "#ede9fe", border: "#7c3aed", icon: "MN" },
  user:         { label: "User/Client",   bg: "#f1f5f9", border: "#64748b", icon: "UC" },
  firewall:     { label: "Firewall",      bg: "#fee2e2", border: "#ef4444", icon: "FW" },
  router:       { label: "Router",        bg: "#ffedd5", border: "#f97316", icon: "RT" },
};
const NODE_TYPES: NodeType[] = ["server", "loadbalancer", "database", "monitor", "user", "firewall", "router"];

const EDGE_USAGE_CONFIG: Record<EdgeUsage, { label: string; stroke: string; dasharray?: string; width: number }> = {
  business:   { label: "業務通信",  stroke: "#2563eb", width: 2 },
  management: { label: "管理通信",  stroke: "#059669", dasharray: "8,5", width: 1.5 },
  monitoring: { label: "監視通信",  stroke: "#7c3aed", dasharray: "2,5", width: 1.5 },
  custom:     { label: "カスタム",  stroke: "#6b7280", width: 1.5 },
};
const EDGE_USAGES: EdgeUsage[] = ["business", "management", "monitoring", "custom"];

const AREA_COLORS = ["#e0f2fe", "#fef9c3", "#dcfce7", "#fce7f3", "#ede9fe", "#ffedd5", "#f0fdf4", "#fff7ed"];
const DEFAULT_SEGMENT_NAMES = ["MGMT", "DMZ", "APP", "DB", "MON"];
const DEFAULT_PROTOCOLS = ["SSH", "HTTP", "HTTPS", "PostgreSQL", "MySQL", "SNMP", "ICMP", "DNS", "NTP", "SMTP"];

// ─── Sample Data ──────────────────────────────────────────────────────────────

function createSampleData(): Pick<State, "nodes" | "edges" | "areas"> {
  const now = Date.now();
  const nodes: NetworkNode[] = [
    { id: "n-jump", displayName: "jump-01", hostname: "jump-01", ipAddress: "192.168.10.10", role: "踏み台サーバ", note: "", nodeType: "server",       x: 50,  y: 80,  w: 150, h: 72, segments: [{ segmentName: "MGMT" }], userTags: [], createdAt: now },
    { id: "n-mon",  displayName: "mon-01",  hostname: "mon-01",  ipAddress: "192.168.10.20", role: "監視サーバ",  note: "", nodeType: "monitor",      x: 50,  y: 400, w: 150, h: 72, segments: [{ segmentName: "MGMT" }], userTags: [], createdAt: now },
    { id: "n-lb",   displayName: "lb-01",   hostname: "lb-01",   ipAddress: "172.16.0.10",   role: "ロードバランサ", note: "", nodeType: "loadbalancer", x: 300, y: 80,  w: 150, h: 72, segments: [{ segmentName: "DMZ" }],  userTags: [], createdAt: now },
    { id: "n-app1", displayName: "app-01",  hostname: "app-01",  ipAddress: "10.0.1.11",     role: "APサーバ",   note: "", nodeType: "server",       x: 300, y: 280, w: 150, h: 72, segments: [{ segmentName: "APP" }],  userTags: [], createdAt: now },
    { id: "n-app2", displayName: "app-02",  hostname: "app-02",  ipAddress: "10.0.1.12",     role: "APサーバ",   note: "", nodeType: "server",       x: 300, y: 400, w: 150, h: 72, segments: [{ segmentName: "APP" }],  userTags: [], createdAt: now },
    { id: "n-db",   displayName: "db-01",   hostname: "db-01",   ipAddress: "10.0.2.11",     role: "DBサーバ",   note: "", nodeType: "database",     x: 560, y: 340, w: 150, h: 72, segments: [{ segmentName: "DB" }],   userTags: [], createdAt: now },
  ];
  const edges: NetworkEdge[] = [
    { id: "e1",  sourceId: "n-jump", targetId: "n-lb",   direction: "one-way", protocols: [{ protocol: "SSH" }],        usage: "management", label: "SSH/22" },
    { id: "e2",  sourceId: "n-jump", targetId: "n-app1", direction: "one-way", protocols: [{ protocol: "SSH" }],        usage: "management", label: "SSH/22" },
    { id: "e3",  sourceId: "n-jump", targetId: "n-app2", direction: "one-way", protocols: [{ protocol: "SSH" }],        usage: "management", label: "SSH/22" },
    { id: "e4",  sourceId: "n-jump", targetId: "n-db",   direction: "one-way", protocols: [{ protocol: "SSH" }],        usage: "management", label: "SSH/22" },
    { id: "e5",  sourceId: "n-lb",   targetId: "n-app1", direction: "one-way", protocols: [{ protocol: "HTTP" }],       usage: "business",   label: "HTTP/80" },
    { id: "e6",  sourceId: "n-lb",   targetId: "n-app2", direction: "one-way", protocols: [{ protocol: "HTTP" }],       usage: "business",   label: "HTTP/80" },
    { id: "e7",  sourceId: "n-app1", targetId: "n-db",   direction: "one-way", protocols: [{ protocol: "PostgreSQL" }], usage: "business",   label: "PgSQL/5432" },
    { id: "e8",  sourceId: "n-app2", targetId: "n-db",   direction: "one-way", protocols: [{ protocol: "PostgreSQL" }], usage: "business",   label: "PgSQL/5432" },
    { id: "e9",  sourceId: "n-mon",  targetId: "n-lb",   direction: "one-way", protocols: [{ protocol: "SNMP" }],       usage: "monitoring", label: "監視" },
    { id: "e10", sourceId: "n-mon",  targetId: "n-app1", direction: "one-way", protocols: [{ protocol: "SNMP" }],       usage: "monitoring", label: "監視" },
    { id: "e11", sourceId: "n-mon",  targetId: "n-app2", direction: "one-way", protocols: [{ protocol: "SNMP" }],       usage: "monitoring", label: "監視" },
    { id: "e12", sourceId: "n-mon",  targetId: "n-db",   direction: "one-way", protocols: [{ protocol: "SNMP" }],       usage: "monitoring", label: "監視" },
  ];
  const areas: NetworkArea[] = [
    { id: "a-mgmt", name: "MGMT", color: "#e0f2fe", x: 20,  y: 20,  w: 210, h: 520, nodeIds: ["n-jump", "n-mon"] },
    { id: "a-dmz",  name: "DMZ",  color: "#fef9c3", x: 260, y: 20,  w: 210, h: 200, nodeIds: ["n-lb"] },
    { id: "a-app",  name: "APP",  color: "#dcfce7", x: 260, y: 240, w: 210, h: 280, nodeIds: ["n-app1", "n-app2"] },
    { id: "a-db",   name: "DB",   color: "#fce7f3", x: 520, y: 280, w: 210, h: 200, nodeIds: ["n-db"] },
  ];
  return { nodes, edges, areas };
}

const initialState: State = {
  nodes: [], edges: [], areas: [],
  isSelectionMode: false, selectedNodeIds: [], hydrated: false,
};

// ─── Reducer ──────────────────────────────────────────────────────────────────

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "addNode": {
      const cfg = NODE_TYPE_CONFIG[action.nodeType];
      return {
        ...state,
        nodes: [...state.nodes, {
          id: crypto.randomUUID(), displayName: cfg.label,
          hostname: "", ipAddress: "", role: "", note: "",
          nodeType: action.nodeType,
          x: action.x, y: action.y, w: 150, h: 72,
          segments: [], userTags: [], createdAt: Date.now(),
        }],
      };
    }
    case "moveNode":
      return { ...state, nodes: state.nodes.map(n => n.id === action.id ? { ...n, x: action.x, y: action.y } : n) };
    case "updateNode":
      return { ...state, nodes: state.nodes.map(n => n.id === action.id ? { ...n, ...action.patch } : n) };
    case "updateNodeSize":
      return { ...state, nodes: state.nodes.map(n => n.id === action.id ? { ...n, w: action.w, h: action.h } : n) };
    case "deleteNode": {
      return {
        ...state,
        nodes: state.nodes.filter(n => n.id !== action.id),
        edges: state.edges.filter(e => e.sourceId !== action.id && e.targetId !== action.id),
        areas: state.areas.map(a => ({ ...a, nodeIds: a.nodeIds.filter(id => id !== action.id) })),
        selectedNodeIds: state.selectedNodeIds.filter(id => id !== action.id),
      };
    }
    case "deleteSelectedNodes": {
      const rm = new Set(state.selectedNodeIds);
      return {
        ...state,
        nodes: state.nodes.filter(n => !rm.has(n.id)),
        edges: state.edges.filter(e => !rm.has(e.sourceId) && !rm.has(e.targetId)),
        areas: state.areas.map(a => ({ ...a, nodeIds: a.nodeIds.filter(id => !rm.has(id)) })),
        selectedNodeIds: [], isSelectionMode: false,
      };
    }
    case "linkSelectedNodes": {
      if (state.selectedNodeIds.length < 2) return state;
      const ids = state.selectedNodeIds;
      const nextEdges = [...state.edges];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const src = ids[i], tgt = ids[j];
          const idx = nextEdges.findIndex(e => (e.sourceId === src && e.targetId === tgt) || (e.sourceId === tgt && e.targetId === src));
          if (idx >= 0) {
            nextEdges[idx] = { ...nextEdges[idx], sourceId: src, targetId: tgt, direction: action.direction };
          } else {
            nextEdges.push({ id: crypto.randomUUID(), sourceId: src, targetId: tgt, direction: action.direction, protocols: [], usage: "custom", label: "" });
          }
        }
      }
      return { ...state, edges: nextEdges };
    }
    case "unlinkSelectedNodes": {
      const sel = new Set(state.selectedNodeIds);
      return { ...state, edges: state.edges.filter(e => !(sel.has(e.sourceId) && sel.has(e.targetId))) };
    }
    case "updateEdge":
      return { ...state, edges: state.edges.map(e => e.id === action.id ? { ...e, ...action.patch } : e) };
    case "deleteEdge":
      return { ...state, edges: state.edges.filter(e => e.id !== action.id) };
    case "addArea": {
      const color = AREA_COLORS[state.areas.length % AREA_COLORS.length];
      return {
        ...state,
        areas: [...state.areas, { id: crypto.randomUUID(), name: action.name, color, x: action.x, y: action.y, w: 240, h: 200, nodeIds: [] }],
      };
    }
    case "moveArea": {
      const a = state.areas.find(x => x.id === action.id);
      if (!a) return state;
      const dx = action.x - a.x, dy = action.y - a.y;
      const movedIds = new Set(a.nodeIds);
      return {
        ...state,
        areas: state.areas.map(ar => ar.id === action.id ? { ...ar, x: action.x, y: action.y } : ar),
        nodes: state.nodes.map(n => movedIds.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n),
      };
    }
    case "resizeArea":
      return { ...state, areas: state.areas.map(a => a.id === action.id ? { ...a, w: action.w, h: action.h } : a) };
    case "deleteArea":
      return { ...state, areas: state.areas.filter(a => a.id !== action.id) };
    case "updateArea":
      return { ...state, areas: state.areas.map(a => a.id === action.id ? { ...a, ...action.patch } : a) };
    case "toggleSelectionMode": {
      const next = !state.isSelectionMode;
      return { ...state, isSelectionMode: next, selectedNodeIds: next ? state.selectedNodeIds : [] };
    }
    case "toggleNodeSelection": {
      if (!state.isSelectionMode) return state;
      const has = state.selectedNodeIds.includes(action.id);
      return { ...state, selectedNodeIds: has ? state.selectedNodeIds.filter(id => id !== action.id) : [...state.selectedNodeIds, action.id] };
    }
    case "clearSelection":
      return { ...state, selectedNodeIds: [] };
    case "restore":
      return { ...action.state, hydrated: true };
    case "hydrate": {
      const s = action.state ?? {};
      const nodes: NetworkNode[] = (s.nodes ?? []).map((n: any) => ({
        id: n.id, displayName: n.displayName ?? "",
        hostname: n.hostname ?? "", ipAddress: n.ipAddress ?? "",
        role: n.role ?? "", note: n.note ?? "",
        nodeType: (n.nodeType ?? "server") as NodeType,
        x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? 150, h: n.h ?? 72,
        segments: n.segments ?? [],
        userTags: n.userTags ?? [],
        createdAt: n.createdAt ?? Date.now(),
      }));
      const edges: NetworkEdge[] = (s.edges ?? []).map((e: any) => ({
        id: e.id, sourceId: e.sourceId, targetId: e.targetId,
        direction: e.direction ?? "one-way",
        protocols: e.protocols ?? [],
        usage: (e.usage ?? "custom") as EdgeUsage,
        label: e.label ?? "",
      }));
      const areas: NetworkArea[] = (s.areas ?? []).map((a: any) => ({
        id: a.id, name: a.name ?? "",
        color: a.color ?? AREA_COLORS[0],
        x: a.x ?? 0, y: a.y ?? 0, w: a.w ?? 240, h: a.h ?? 200,
        nodeIds: a.nodeIds ?? [],
      }));
      const hasData = nodes.length > 0 || edges.length > 0 || areas.length > 0;
      const data = hasData ? { nodes, edges, areas } : createSampleData();
      return { ...initialState, ...data, hydrated: true };
    }
    default:
      return state;
  }
}

// ─── Geometry ─────────────────────────────────────────────────────────────────

function nodeEdgePoint(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number) {
  const dx = tx - cx, dy = ty - cy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.5) return { x: cx, y: cy };
  const nx = dx / len, ny = dy / len;
  const t = Math.min(hw / (Math.abs(nx) || 1e-9), hh / (Math.abs(ny) || 1e-9));
  return { x: cx + nx * t, y: cy + ny * t };
}

function calcEdgePoints(src: NetworkNode, tgt: NetworkNode) {
  const hw1 = src.w / 2, hh1 = src.h / 2;
  const hw2 = tgt.w / 2, hh2 = tgt.h / 2;
  const cx1 = src.x + hw1, cy1 = src.y + hh1;
  const cx2 = tgt.x + hw2, cy2 = tgt.y + hh2;
  const p1 = nodeEdgePoint(cx1, cy1, hw1, hh1, cx2, cy2);
  const p2 = nodeEdgePoint(cx2, cy2, hw2, hh2, cx1, cy1);
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, mx: (cx1 + cx2) / 2, my: (cy1 + cy2) / 2 };
}

// ─── ResizeDivider ────────────────────────────────────────────────────────────

function ResizeDivider({ onDrag }: { onDrag: (dx: number) => void }) {
  const startXRef = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  return (
    <div
      className={active ? "resize-divider active" : "resize-divider"}
      onPointerDown={(e) => { startXRef.current = e.clientX; setActive(true); e.currentTarget.setPointerCapture(e.pointerId); e.stopPropagation(); }}
      onPointerMove={(e) => { if (startXRef.current === null) return; onDrag(e.clientX - startXRef.current); startXRef.current = e.clientX; }}
      onPointerUp={() => { startXRef.current = null; setActive(false); }}
    />
  );
}

// ─── NetworkAreaEl ────────────────────────────────────────────────────────────

function NetworkAreaEl({ area, outerRef, zoom, pan, onMove, onResize, onDelete, onRename }: {
  area: NetworkArea;
  outerRef: React.RefObject<HTMLDivElement>;
  zoom: number; pan: { x: number; y: number };
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, w: number, h: number) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const ptrRef = useRef<number | null>(null);
  const modeRef = useRef<"none" | "move" | "resize">("none");
  const startRef = useRef({ cx: 0, cy: 0, ax: 0, ay: 0, aw: 0, ah: 0 });
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(area.name);

  useEffect(() => { setNameVal(area.name); }, [area.name]);

  function toCanvas(clientX: number, clientY: number) {
    const rect = outerRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
  }

  function onDown(e: React.PointerEvent, mode: "move" | "resize") {
    const pos = toCanvas(e.clientX, e.clientY);
    modeRef.current = mode; ptrRef.current = e.pointerId;
    startRef.current = { cx: pos.x, cy: pos.y, ax: area.x, ay: area.y, aw: area.w, ah: area.h };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.stopPropagation();
  }

  function onPMove(e: React.PointerEvent) {
    if (modeRef.current === "none" || ptrRef.current !== e.pointerId) return;
    const pos = toCanvas(e.clientX, e.clientY);
    const dx = pos.x - startRef.current.cx, dy = pos.y - startRef.current.cy;
    if (modeRef.current === "move") onMove(area.id, startRef.current.ax + dx, startRef.current.ay + dy);
    else onResize(area.id, Math.max(80, startRef.current.aw + dx), Math.max(60, startRef.current.ah + dy));
  }

  function onUp(e: React.PointerEvent) {
    if (ptrRef.current !== e.pointerId) return;
    modeRef.current = "none"; ptrRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  return (
    <div className="network-area" style={{ left: area.x, top: area.y, width: area.w, height: area.h, background: area.color + "99", borderColor: area.color }}>
      <div style={{ position: "absolute", inset: 0, cursor: "move" }}
        onPointerDown={e => onDown(e, "move")} onPointerMove={onPMove} onPointerUp={onUp}
      />
      <div className="area-header" style={{ pointerEvents: "none", position: "relative" }}>
        {editingName ? (
          <input
            className="area-name-input"
            autoFocus value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={() => { onRename(area.id, nameVal.trim() || area.name); setEditingName(false); }}
            onKeyDown={e => { if (e.key === "Enter") { onRename(area.id, nameVal.trim() || area.name); setEditingName(false); } }}
            style={{ pointerEvents: "auto" }}
            onPointerDown={e => e.stopPropagation()}
          />
        ) : (
          <span className="area-name" style={{ pointerEvents: "auto" }}
            onDoubleClick={e => { e.stopPropagation(); setEditingName(true); }}
          >{area.name}</span>
        )}
        <button className="area-del-btn" style={{ pointerEvents: "auto" }}
          onPointerDown={e => e.stopPropagation()}
          onClick={() => onDelete(area.id)}
        >×</button>
      </div>
      <div className="area-resize-handle"
        onPointerDown={e => onDown(e, "resize")} onPointerMove={onPMove} onPointerUp={onUp}
      />
    </div>
  );
}

// ─── NetworkNodeEl ────────────────────────────────────────────────────────────

function NetworkNodeEl({ node, outerRef, zoom, pan, isSelectionMode, isSelected, selectionIndex, isInfoActive, onMove, onSizeChange, onToggleSelect, onInfo }: {
  node: NetworkNode;
  outerRef: React.RefObject<HTMLDivElement>;
  zoom: number; pan: { x: number; y: number };
  isSelectionMode: boolean; isSelected: boolean; selectionIndex?: number; isInfoActive: boolean;
  onMove: (id: string, x: number, y: number) => void;
  onSizeChange: (id: string, w: number, h: number) => void;
  onToggleSelect: (id: string) => void;
  onInfo: (id: string) => void;
}) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const offsetRef = useRef({ x: 0, y: 0 });
  const ptrRef = useRef<number | null>(null);
  const cfg = NODE_TYPE_CONFIG[node.nodeType];

  useEffect(() => {
    if (!nodeRef.current) return;
    const obs = new ResizeObserver(() => {
      if (nodeRef.current) onSizeChange(node.id, nodeRef.current.offsetWidth, nodeRef.current.offsetHeight);
    });
    obs.observe(nodeRef.current);
    return () => obs.disconnect();
  }, [node.id, onSizeChange]);

  function toCanvas(clientX: number, clientY: number) {
    const rect = outerRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (isSelectionMode) { onToggleSelect(node.id); e.preventDefault(); return; }
    const pos = toCanvas(e.clientX, e.clientY);
    draggingRef.current = true; ptrRef.current = e.pointerId;
    offsetRef.current = { x: pos.x - node.x, y: pos.y - node.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!draggingRef.current || ptrRef.current !== e.pointerId) return;
    const pos = toCanvas(e.clientX, e.clientY);
    onMove(node.id, pos.x - offsetRef.current.x, pos.y - offsetRef.current.y);
  }

  function onPointerUp(e: React.PointerEvent) {
    if (ptrRef.current !== e.pointerId) return;
    draggingRef.current = false; ptrRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const borderColor = isSelected ? "#1d4ed8" : isInfoActive ? "#6d28d9" : cfg.border;
  const borderWidth = isSelected || isInfoActive ? "2.5px" : "1.5px";

  return (
    <div
      ref={nodeRef}
      className={`network-node${isSelected ? " selected" : ""}${isInfoActive ? " info-active" : ""}`}
      style={{ left: node.x, top: node.y, background: cfg.bg, borderColor, borderWidth }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={() => { if (!isSelectionMode) onInfo(node.id); }}
    >
      {selectionIndex !== undefined && <div className="selection-badge">{selectionIndex + 1}</div>}
      <div className="node-icon-badge" style={{ background: cfg.border }}>{cfg.icon}</div>
      <div className="node-body">
        <div className="node-display-name">{node.displayName || "(unnamed)"}</div>
        {node.hostname && <div className="node-sub">{node.hostname}</div>}
        {node.ipAddress && <div className="node-sub node-ip">{node.ipAddress}</div>}
      </div>
      {node.segments.length > 0 && (
        <div className="node-segs">
          {node.segments.map(s => (
            <span key={s.segmentName} className="seg-badge">{s.segmentName}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const canvasOuterRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const [snapToGrid, setSnapToGrid] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [rightPanelWidth, setRightPanelWidth] = useState(290);

  // Input state for detail panel edits
  const [newSegmentInput, setNewSegmentInput] = useState("");
  const [newUserTagInput, setNewUserTagInput] = useState("");
  const [newProtocolInput, setNewProtocolInput] = useState("");
  const [newAreaName, setNewAreaName] = useState("");

  const [defaultNodeType, setDefaultNodeType] = useState<NodeType>("server");

  const pastRef = useRef<State[]>([]);
  const futureRef = useRef<State[]>([]);

  const dispatchWithHistory = useCallback((action: Action) => {
    if (!SKIP_HISTORY.has(action.type)) {
      pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), state];
      futureRef.current = [];
    }
    dispatch(action);
  }, [state]);

  const undo = useCallback(() => {
    if (!pastRef.current.length) return;
    const prev = pastRef.current[pastRef.current.length - 1];
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [state, ...futureRef.current.slice(0, HISTORY_LIMIT - 1)];
    dispatch({ type: "restore", state: prev });
  }, [state]);

  const redo = useCallback(() => {
    if (!futureRef.current.length) return;
    const next = futureRef.current[0];
    futureRef.current = futureRef.current.slice(1);
    pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), state];
    dispatch({ type: "restore", state: next });
  }, [state]);

  // Center canvas on first render
  useEffect(() => {
    const el = canvasOuterRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPan({ x: width / 2, y: height / 2 });
  }, []);

  // Hydrate from storage
  useEffect(() => {
    tauriStore.get<any>(STORAGE_KEY).then(async (data) => {
      let raw = typeof data === "string" ? data : data?.value;
      if (!raw) {
        raw = localStorage.getItem(STORAGE_KEY);
        if (raw) { await tauriStore.set(STORAGE_KEY, raw); await tauriStore.save(); }
      }
      if (!raw) { dispatch({ type: "hydrate", state: {} }); return; }
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        dispatch({ type: "hydrate", state: parsed });
      } catch { dispatch({ type: "hydrate", state: {} }); }
    }).catch(() => dispatch({ type: "hydrate", state: {} }));
  }, []);

  // Persist on state change
  useEffect(() => {
    if (!state.hydrated) return;
    tauriStore.set(STORAGE_KEY, JSON.stringify(state)).then(() => tauriStore.save()).catch(console.error);
  }, [state]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  function snap(v: number) { return snapToGrid ? Math.round(v / GRID_SIZE) * GRID_SIZE : v; }

  function canvasCenter() {
    const rect = canvasOuterRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 800, h = rect?.height ?? 600;
    return { x: snap((w / 2 - pan.x) / zoom), y: snap((h / 2 - pan.y) / zoom) };
  }

  // Canvas wheel zoom
  function onCanvasWheel(e: React.WheelEvent) {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(z => {
      const nz = Math.min(3, Math.max(0.2, z * delta));
      setPan(p => ({ x: mx - (mx - p.x) * (nz / z), y: my - (my - p.y) * (nz / z) }));
      return nz;
    });
  }

  function onCanvasPointerDown(e: React.PointerEvent) {
    const isBg = (e.target as HTMLElement).classList.contains("canvas") || (e.target as HTMLElement).classList.contains("canvas-inner");
    if (e.button === 1 || (e.button === 0 && isBg)) {
      isPanningRef.current = true;
      panStartRef.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  }

  function onCanvasPointerMove(e: React.PointerEvent) {
    if (!isPanningRef.current) return;
    setPan({ x: panStartRef.current.px + (e.clientX - panStartRef.current.mx), y: panStartRef.current.py + (e.clientY - panStartRef.current.my) });
  }

  function onCanvasPointerUp() { isPanningRef.current = false; }

  // Double-click canvas to add node
  function onCanvasDoubleClick(e: React.MouseEvent) {
    const isBg = (e.target as HTMLElement).classList.contains("canvas") || (e.target as HTMLElement).classList.contains("canvas-inner");
    if (!isBg) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = snap((e.clientX - rect.left - pan.x) / zoom);
    const y = snap((e.clientY - rect.top - pan.y) / zoom);
    dispatchWithHistory({ type: "addNode", nodeType: defaultNodeType, x: x - 75, y: y - 36 });
  }

  function resetView() {
    const el = canvasOuterRef.current;
    if (!el) { setZoom(1); setPan({ x: 0, y: 0 }); return; }
    const { width, height } = el.getBoundingClientRect();
    setZoom(1); setPan({ x: width / 2, y: height / 2 });
  }

  // Derived state
  const nodesById = useMemo(() => {
    const m = new Map<string, NetworkNode>();
    state.nodes.forEach(n => m.set(n.id, n));
    return m;
  }, [state.nodes]);

  const activeNode = activeNodeId ? nodesById.get(activeNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? state.edges.find(e => e.id === selectedEdgeId) ?? null : null;

  useEffect(() => {
    if (activeNodeId && !nodesById.has(activeNodeId)) setActiveNodeId(null);
  }, [nodesById, activeNodeId]);

  const selectedHasLinks = useMemo(() => {
    if (state.selectedNodeIds.length < 2) return false;
    const sel = new Set(state.selectedNodeIds);
    return state.edges.some(e => sel.has(e.sourceId) && sel.has(e.targetId));
  }, [state.selectedNodeIds, state.edges]);

  // JSON export/import
  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `network-diagram-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        dispatchWithHistory({ type: "hydrate", state: parsed });
      } catch { alert("JSONの読み込みに失敗しました。"); }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // ─── Left Panel ────────────────────────────────────────────────────────────

  const leftPanel = (
    <div className="left-panel">
      <div className="panel-section-title">ノード追加</div>
      <div className="node-palette">
        {NODE_TYPES.map(type => {
          const cfg = NODE_TYPE_CONFIG[type];
          const isDefault = defaultNodeType === type;
          return (
            <button
              key={type}
              className={`node-palette-btn${isDefault ? " default-type" : ""}`}
              style={{ borderColor: cfg.border, background: isDefault ? cfg.bg : "white" }}
              title={`${cfg.label}を追加 (ダブルクリックでもこの種別が追加されます)`}
              onClick={() => {
                setDefaultNodeType(type);
                const c = canvasCenter();
                dispatchWithHistory({ type: "addNode", nodeType: type, x: c.x - 75, y: c.y - 36 });
              }}
            >
              <span className="palette-icon" style={{ background: cfg.border }}>{cfg.icon}</span>
              <span className="palette-label">{cfg.label}</span>
            </button>
          );
        })}
      </div>

      <div className="panel-sep" />
      <div className="panel-section-title">エリア追加</div>
      <div className="area-palette">
        {DEFAULT_SEGMENT_NAMES.map(seg => (
          <button key={seg} className="area-palette-btn"
            onClick={() => {
              const c = canvasCenter();
              dispatchWithHistory({ type: "addArea", name: seg, x: c.x - 120, y: c.y - 100 });
            }}
          >{seg}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
        <input
          className="detail-input" placeholder="カスタム名..."
          value={newAreaName} onChange={e => setNewAreaName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && newAreaName.trim()) {
              const c = canvasCenter();
              dispatchWithHistory({ type: "addArea", name: newAreaName.trim(), x: c.x - 120, y: c.y - 100 });
              setNewAreaName("");
            }
          }}
          style={{ flex: 1, fontSize: 12 }}
        />
        <button className="btn small" onClick={() => {
          if (!newAreaName.trim()) return;
          const c = canvasCenter();
          dispatchWithHistory({ type: "addArea", name: newAreaName.trim(), x: c.x - 120, y: c.y - 100 });
          setNewAreaName("");
        }}>+</button>
      </div>

      <div className="panel-sep" />
      <div className="panel-section-title">通信種別の凡例</div>
      <div className="edge-legend">
        {EDGE_USAGES.map(usage => {
          const cfg = EDGE_USAGE_CONFIG[usage];
          return (
            <div key={usage} className="legend-row">
              <svg width="32" height="14">
                <line x1="2" y1="7" x2="30" y2="7"
                  stroke={cfg.stroke} strokeWidth={cfg.width}
                  strokeDasharray={cfg.dasharray}
                />
                <polygon points="26,4 30,7 26,10" fill={cfg.stroke} />
              </svg>
              <span style={{ fontSize: 11, color: "#444" }}>{cfg.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );

  // ─── Detail Panel ──────────────────────────────────────────────────────────

  const nodeDetailPanel = activeNode && (
    <div className="detail-content">
      <div className="detail-row">
        <label className="detail-label">種別</label>
        <div className="node-type-grid">
          {NODE_TYPES.map(t => {
            const c = NODE_TYPE_CONFIG[t];
            return (
              <button key={t} className={`type-select-btn${activeNode.nodeType === t ? " active" : ""}`}
                style={{ borderColor: c.border, background: activeNode.nodeType === t ? c.bg : "white" }}
                onClick={() => dispatchWithHistory({ type: "updateNode", id: activeNode.id, patch: { nodeType: t } })}
                title={c.label}
              >
                <span style={{ background: c.border, color: "white", borderRadius: 3, padding: "1px 4px", fontSize: 10, fontWeight: 700 }}>{c.icon}</span>
              </button>
            );
          })}
        </div>
      </div>

      {([
        ["displayName", "表示名"],
        ["hostname",    "ホスト名"],
        ["ipAddress",   "IPアドレス"],
        ["role",        "役割"],
      ] as [keyof NetworkNode, string][]).map(([field, label]) => (
        <div key={field} className="detail-row">
          <label className="detail-label">{label}</label>
          <input className="detail-input"
            value={(activeNode[field] as string) ?? ""}
            placeholder={label}
            onChange={e => dispatchWithHistory({ type: "updateNode", id: activeNode.id, patch: { [field]: e.target.value } })}
          />
        </div>
      ))}

      <div className="detail-row">
        <label className="detail-label">備考</label>
        <textarea className="detail-textarea"
          value={activeNode.note}
          placeholder="備考・メモ"
          onChange={e => dispatchWithHistory({ type: "updateNode", id: activeNode.id, patch: { note: e.target.value } })}
        />
      </div>

      <div className="detail-row">
        <label className="detail-label">セグメント</label>
        <div className="tag-list">
          {activeNode.segments.map(s => (
            <span key={s.segmentName} className="tag seg-tag">
              {s.segmentName}
              <button className="tag-remove" onClick={() => dispatchWithHistory({ type: "updateNode", id: activeNode.id, patch: { segments: activeNode.segments.filter(x => x.segmentName !== s.segmentName) } })}>×</button>
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
          <select className="detail-input" value={newSegmentInput} onChange={e => setNewSegmentInput(e.target.value)} style={{ flex: 1 }}>
            <option value="">-- 選択 --</option>
            {DEFAULT_SEGMENT_NAMES.filter(s => !activeNode.segments.some(x => x.segmentName === s)).map(s => <option key={s} value={s}>{s}</option>)}
            <option value="__custom__">カスタム入力...</option>
          </select>
          <button className="btn small" onClick={() => {
            const name = newSegmentInput === "__custom__" ? (window.prompt("セグメント名") ?? "") : newSegmentInput;
            if (!name.trim() || activeNode.segments.some(x => x.segmentName === name)) { setNewSegmentInput(""); return; }
            dispatchWithHistory({ type: "updateNode", id: activeNode.id, patch: { segments: [...activeNode.segments, { segmentName: name.trim() }] } });
            setNewSegmentInput("");
          }}>+</button>
        </div>
      </div>

      <div className="detail-row">
        <label className="detail-label">ユーザータグ</label>
        <div className="tag-list">
          {activeNode.userTags.map(t => (
            <span key={t} className="tag">
              #{t}
              <button className="tag-remove" onClick={() => dispatchWithHistory({ type: "updateNode", id: activeNode.id, patch: { userTags: activeNode.userTags.filter(x => x !== t) } })}>×</button>
            </span>
          ))}
        </div>
        <input className="detail-input" placeholder="タグ追加 (Enter)" value={newUserTagInput}
          onChange={e => setNewUserTagInput(e.target.value)}
          onKeyDown={e => {
            if (e.key !== "Enter") return;
            const t = newUserTagInput.trim().replace(/^#+/, "");
            if (!t || activeNode.userTags.includes(t)) { setNewUserTagInput(""); return; }
            dispatchWithHistory({ type: "updateNode", id: activeNode.id, patch: { userTags: [...activeNode.userTags, t] } });
            setNewUserTagInput("");
          }}
          style={{ marginTop: 4 }}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <button className="btn danger" onClick={() => { dispatchWithHistory({ type: "deleteNode", id: activeNode.id }); setActiveNodeId(null); }}>
          このノードを削除
        </button>
      </div>
    </div>
  );

  const edgeDetailPanel = selectedEdge && (
    <div className="detail-content">
      <div className="detail-row">
        <label className="detail-label">方向</label>
        <div style={{ display: "flex", gap: 6 }}>
          {(["one-way", "two-way"] as const).map(d => (
            <button key={d} className={`btn small${selectedEdge.direction === d ? " active" : ""}`}
              onClick={() => dispatchWithHistory({ type: "updateEdge", id: selectedEdge.id, patch: { direction: d } })}
            >{d === "one-way" ? "→ 一方向" : "↔ 双方向"}</button>
          ))}
        </div>
      </div>

      <div className="detail-row">
        <label className="detail-label">通信種別</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {EDGE_USAGES.map(u => {
            const c = EDGE_USAGE_CONFIG[u];
            return (
              <button key={u} className="btn small"
                style={selectedEdge.usage === u
                  ? { borderColor: c.stroke, background: c.stroke + "22", color: "#1a202c", fontWeight: 600 }
                  : {}}
                onClick={() => dispatchWithHistory({ type: "updateEdge", id: selectedEdge.id, patch: { usage: u } })}
              >{c.label}</button>
            );
          })}
        </div>
      </div>

      <div className="detail-row">
        <label className="detail-label">プロトコル</label>
        <div className="tag-list">
          {selectedEdge.protocols.map((p, i) => (
            <span key={i} className="tag proto-tag">
              {p.protocol}
              <button className="tag-remove" onClick={() => {
                const next = selectedEdge.protocols.filter((_, idx) => idx !== i);
                dispatchWithHistory({ type: "updateEdge", id: selectedEdge.id, patch: { protocols: next } });
              }}>×</button>
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
          <select className="detail-input" value={newProtocolInput} onChange={e => setNewProtocolInput(e.target.value)} style={{ flex: 1 }}>
            <option value="">-- 選択 --</option>
            {DEFAULT_PROTOCOLS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <button className="btn small" onClick={() => {
            if (!newProtocolInput || selectedEdge.protocols.some(p => p.protocol === newProtocolInput)) { setNewProtocolInput(""); return; }
            dispatchWithHistory({ type: "updateEdge", id: selectedEdge.id, patch: { protocols: [...selectedEdge.protocols, { protocol: newProtocolInput }] } });
            setNewProtocolInput("");
          }}>+</button>
        </div>
      </div>

      <div className="detail-row">
        <label className="detail-label">ラベル</label>
        <input className="detail-input"
          value={selectedEdge.label}
          placeholder="自由テキスト"
          onChange={e => dispatchWithHistory({ type: "updateEdge", id: selectedEdge.id, patch: { label: e.target.value } })}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <button className="btn danger" onClick={() => { dispatchWithHistory({ type: "deleteEdge", id: selectedEdge.id }); setSelectedEdgeId(null); }}>
          この接続線を削除
        </button>
      </div>
    </div>
  );

  const rightPanel = (
    <div className="detail-panel" style={{ width: rightPanelWidth }}>
      <div className="panel-title">
        {activeNode ? "ノード詳細" : selectedEdge ? "接続線詳細" : "詳細"}
        {(activeNode || selectedEdge) && (
          <button className="btn small ml-auto" style={{ fontSize: 11 }}
            onClick={() => { setActiveNodeId(null); setSelectedEdgeId(null); }}
          >✕</button>
        )}
      </div>
      {activeNode ? nodeDetailPanel :
       selectedEdge ? edgeDetailPanel :
       <div style={{ padding: "16px 12px", color: "#999", fontSize: 12, lineHeight: 1.6 }}>
         ノードをクリックすると詳細を編集できます。<br />
         接続線をクリックするとプロトコル・種別を編集できます。
       </div>
      }
    </div>
  );

  // ─── Canvas ────────────────────────────────────────────────────────────────

  const canvas = (
    <div className="canvas-wrapper">
      <div
        ref={canvasOuterRef}
        className="canvas"
        style={snapToGrid ? {
          backgroundImage: "linear-gradient(rgba(0,0,0,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.06) 1px, transparent 1px)",
          backgroundSize: `${GRID_SIZE * zoom}px ${GRID_SIZE * zoom}px`,
          backgroundPosition: `${pan.x % (GRID_SIZE * zoom)}px ${pan.y % (GRID_SIZE * zoom)}px`,
        } : undefined}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onDoubleClick={onCanvasDoubleClick}
        onWheel={onCanvasWheel}
        onContextMenu={e => e.preventDefault()}
      >
        <div className="canvas-inner" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}>
          {/* Origin marker */}
          <svg style={{ position: "absolute", left: -12, top: -12, width: 24, height: 24, pointerEvents: "none", overflow: "visible" }}>
            <line x1="12" y1="0" x2="12" y2="24" stroke="#ccc" strokeWidth="1" strokeDasharray="2,2" />
            <line x1="0" y1="12" x2="24" y2="12" stroke="#ccc" strokeWidth="1" strokeDasharray="2,2" />
            <circle cx="12" cy="12" r="2" fill="#ccc" />
          </svg>

          {/* Network areas (behind everything) */}
          {state.areas.map(area => (
            <NetworkAreaEl key={area.id} area={area} outerRef={canvasOuterRef} zoom={zoom} pan={pan}
              onMove={(id, x, y) => dispatch({ type: "moveArea", id, x: snap(x), y: snap(y) })}
              onResize={(id, w, h) => dispatch({ type: "resizeArea", id, w: snap(w), h: snap(h) })}
              onDelete={id => dispatchWithHistory({ type: "deleteArea", id })}
              onRename={(id, name) => dispatchWithHistory({ type: "updateArea", id, patch: { name } })}
            />
          ))}

          {/* SVG edges */}
          <svg className="links-layer" style={{ overflow: "visible" }}>
            <defs>
              {EDGE_USAGES.map(usage => {
                const c = EDGE_USAGE_CONFIG[usage];
                return (
                  <g key={usage}>
                    <marker id={`arr-end-${usage}`} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                      <polygon points="0 0, 8 3, 0 6" fill={c.stroke} fillOpacity={0.85} />
                    </marker>
                    <marker id={`arr-start-${usage}`} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto-start-reverse">
                      <polygon points="0 0, 8 3, 0 6" fill={c.stroke} fillOpacity={0.85} />
                    </marker>
                  </g>
                );
              })}
              <marker id="arr-end-selected" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#1d4ed8" />
              </marker>
              <marker id="arr-start-selected" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto-start-reverse">
                <polygon points="0 0, 8 3, 0 6" fill="#1d4ed8" />
              </marker>
            </defs>
            {state.edges.map(edge => {
              const src = nodesById.get(edge.sourceId);
              const tgt = nodesById.get(edge.targetId);
              if (!src || !tgt) return null;
              const { x1, y1, x2, y2, mx, my } = calcEdgePoints(src, tgt);
              const isSelected = edge.id === selectedEdgeId;
              const cfg = EDGE_USAGE_CONFIG[edge.usage];
              const stroke = isSelected ? "#1d4ed8" : cfg.stroke;
              const markerSuffix = isSelected ? "selected" : edge.usage;
              const displayLabel = edge.label || edge.protocols.map(p => p.protocol).join(", ");
              return (
                <g key={edge.id}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke="transparent" strokeWidth={12}
                    style={{ cursor: "pointer", pointerEvents: "stroke" }}
                    onClick={() => { setActiveNodeId(null); setSelectedEdgeId(prev => prev === edge.id ? null : edge.id); }}
                  />
                  <line x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={stroke}
                    strokeWidth={isSelected ? cfg.width + 1 : cfg.width}
                    strokeDasharray={isSelected ? undefined : cfg.dasharray}
                    strokeOpacity={isSelected ? 1 : 0.75}
                    markerEnd={`url(#arr-end-${markerSuffix})`}
                    markerStart={edge.direction === "two-way" ? `url(#arr-start-${markerSuffix})` : undefined}
                    style={{ pointerEvents: "none" }}
                  />
                  {displayLabel && (
                    <text x={mx} y={my - 6} textAnchor="middle" fontSize={10} fill={isSelected ? "#1d4ed8" : "#555"} fontWeight={isSelected ? 600 : 400} style={{ pointerEvents: "none", userSelect: "none" }}>
                      {displayLabel}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Nodes */}
          {state.nodes.map(node => {
            const selIdx = state.isSelectionMode ? state.selectedNodeIds.indexOf(node.id) : -1;
            return (
              <NetworkNodeEl key={node.id} node={node} outerRef={canvasOuterRef} zoom={zoom} pan={pan}
                isSelectionMode={state.isSelectionMode}
                isSelected={selIdx >= 0}
                selectionIndex={selIdx >= 0 ? selIdx : undefined}
                isInfoActive={activeNodeId === node.id}
                onMove={(id, x, y) => dispatch({ type: "moveNode", id, x: snap(x), y: snap(y) })}
                onSizeChange={(id, w, h) => dispatch({ type: "updateNodeSize", id, w, h })}
                onToggleSelect={id => dispatchWithHistory({ type: "toggleNodeSelection", id })}
                onInfo={id => { setSelectedEdgeId(null); setActiveNodeId(prev => prev === id ? null : id); }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <input ref={importRef} type="file" accept=".json" style={{ display: "none" }} onChange={handleImport} />

      <header className="topbar">
        <div className="title">Network Diagram</div>
        <div className="topbar-actions">
          <button className="btn small topbar-btn" onClick={undo} title="Ctrl+Z">↩ Undo</button>
          <button className="btn small topbar-btn" onClick={redo} title="Ctrl+Y">↪ Redo</button>
          <div className="toolbar-sep" />
          <button className="btn small topbar-btn" onClick={exportJSON}>Export JSON</button>
          <button className="btn small topbar-btn" onClick={() => importRef.current?.click()}>Import JSON</button>
        </div>
      </header>

      <main className="board-view">
        {/* Toolbar */}
        <div className="board-toolbar">
          <button className={state.isSelectionMode ? "btn active" : "btn"}
            onClick={() => dispatchWithHistory({ type: "toggleSelectionMode" })}
          >Select {state.isSelectionMode ? "ON" : "OFF"}</button>

          {state.isSelectionMode && (
            <>
              <div className="toolbar-sep" />
              <button className="btn" disabled={state.selectedNodeIds.length < 2}
                onClick={() => dispatchWithHistory({ type: "linkSelectedNodes", direction: "one-way" })} title="一方向接続">Link →</button>
              <button className="btn" disabled={state.selectedNodeIds.length < 2}
                onClick={() => dispatchWithHistory({ type: "linkSelectedNodes", direction: "two-way" })} title="双方向接続">Link ↔</button>
              <button className="btn" disabled={!selectedHasLinks}
                onClick={() => dispatchWithHistory({ type: "unlinkSelectedNodes" })}>Unlink</button>
              <button className="btn danger" disabled={state.selectedNodeIds.length === 0}
                onClick={() => { dispatchWithHistory({ type: "deleteSelectedNodes" }); setActiveNodeId(null); }}>Delete</button>
            </>
          )}

          <div className="toolbar-sep" />
          <button className={snapToGrid ? "btn active" : "btn"} onClick={() => setSnapToGrid(v => !v)}>
            Grid {snapToGrid ? "ON" : "OFF"}
          </button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="btn small" onClick={resetView} title="ズームリセット・中央へ">⌖ Home</button>

          <div className="toolbar-sep" />
          <span style={{ fontSize: 11, color: "#888" }}>
            ダブルクリックで <strong>{NODE_TYPE_CONFIG[defaultNodeType].label}</strong> を追加
          </span>
        </div>

        {/* Main columns */}
        <div className="board-columns">
          {leftPanel}
          <ResizeDivider onDrag={() => {}} />
          {canvas}
          <ResizeDivider onDrag={dx => setRightPanelWidth(w => Math.max(200, Math.min(480, w - dx)))} />
          {rightPanel}
        </div>
      </main>
    </div>
  );
}
