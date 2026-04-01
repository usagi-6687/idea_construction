import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { LazyStore } from "@tauri-apps/plugin-store";

const tauriStore = new LazyStore("brainstorming-data.json");

// ─── Types ────────────────────────────────────────────────────────────────────

type Memo = { id: string; text: string; createdAt: number; updatedAt: number; folderId: string | null };
type Folder = { id: string; name: string; color: string; parentId: string | null; order: number; createdAt: number };

export type CardColor = "yellow" | "blue" | "green" | "red" | "purple" | "orange";
export const CARD_COLORS: { value: CardColor; bg: string; border: string; label: string }[] = [
  { value: "yellow", bg: "#fff6c7", border: "#e3d67a", label: "黄" },
  { value: "blue",   bg: "#dbeafe", border: "#93c5fd", label: "青" },
  { value: "green",  bg: "#dcfce7", border: "#86efac", label: "緑" },
  { value: "red",    bg: "#fee2e2", border: "#fca5a5", label: "赤" },
  { value: "purple", bg: "#f3e8ff", border: "#d8b4fe", label: "紫" },
  { value: "orange", bg: "#ffedd5", border: "#fdba74", label: "橙" },
];

type LinkType = "one-way" | "two-way";
type LinkEdge = { id: string; sourceId: string; targetId: string; type: LinkType; label: string };

type CardGroup = { id: string; name: string; cardIds: string[]; color: string; x: number; y: number; w: number; h: number };

type CardInstance = {
  id: string;
  memoId: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  createdAt: number;
  note: string;
  tags: string[];
  color: CardColor;
};

type TabKey = "memo" | "board";

type State = {
  memos: Memo[];
  cards: CardInstance[];
  edges: LinkEdge[];
  groups: CardGroup[];
  folders: Folder[];
  activeTab: TabKey;
  isSelectionMode: boolean;
  selectedCardIds: string[];
  hydrated: boolean;
};

type Action =
  | { type: "addMemo"; folderId?: string | null }
  | { type: "addFolder"; parentId: string | null }
  | { type: "renameFolder"; id: string; name: string }
  | { type: "setFolderColor"; id: string; color: string }
  | { type: "deleteFolder"; id: string }
  | { type: "moveMemoToFolder"; memoId: string; folderId: string | null }
  | { type: "reorderFolder"; dragId: string; targetId: string; position: "before" | "after" }
  | { type: "moveFolderToParent"; id: string; parentId: string | null }
  | { type: "updateMemo"; id: string; text: string }
  | { type: "deleteMemo"; id: string }
  | { type: "addCard"; memoId: string; x: number; y: number }
  | { type: "moveCard"; id: string; x: number; y: number }
  | { type: "moveCards"; moves: { id: string; x: number; y: number }[] }
  | { type: "updateCardNote"; id: string; note: string }
  | { type: "addCardTags"; id: string; tags: string[] }
  | { type: "removeCardTag"; id: string; tag: string }
  | { type: "setCardColor"; id: string; color: CardColor }
  | { type: "toggleSelectionMode" }
  | { type: "toggleCardSelection"; id: string }
  | { type: "deleteSelectedCards" }
  | { type: "linkSelectedCards"; linkType: LinkType }
  | { type: "unlinkSelectedCards" }
  | { type: "updateEdgeLabel"; id: string; label: string }
  | { type: "groupSelectedCards" }
  | { type: "updateGroupBounds"; id: string; w: number; h: number }
  | { type: "moveGroupAbsolute"; id: string; x: number; y: number }
  | { type: "deleteGroup"; id: string }
  | { type: "updateGroupName"; id: string; name: string }
  | { type: "clearSelection" }
  | { type: "setTab"; tab: TabKey }
  | { type: "addMemoAndCard"; x: number; y: number }
  | { type: "updateCardSize"; id: string; w: number; h: number }
  | { type: "hydrate"; state: any }
  | { type: "restore"; state: State };

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "brainstorming-v1";
const CARD_HALF_W = 80;
const CARD_HALF_H = 30;
const HISTORY_LIMIT = 50;
const SKIP_HISTORY = new Set<Action["type"]>(["moveCard", "moveCards", "moveGroupAbsolute", "updateGroupBounds", "updateCardSize", "hydrate", "restore"]);

const GROUP_COLORS = ["#e0f2fe", "#fef9c3", "#dcfce7", "#fce7f3", "#ede9fe", "#ffedd5"];
const FOLDER_COLORS = ["#6b7280","#ef4444","#f97316","#eab308","#22c55e","#3b82f6","#8b5cf6","#ec4899"];

const initialState: State = {
  memos: [],
  cards: [],
  edges: [],
  groups: [],
  folders: [],
  activeTab: "memo",
  isSelectionMode: false,
  selectedCardIds: [],
  hydrated: false,
};

// ─── Reducer ──────────────────────────────────────────────────────────────────

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "addMemo": {
      const now = Date.now();
      return {
        ...state,
        memos: [{ id: crypto.randomUUID(), text: "", createdAt: now, updatedAt: now, folderId: action.folderId ?? null }, ...state.memos],
      };
    }
    case "updateMemo":
      return {
        ...state,
        memos: state.memos.map((m) =>
          m.id === action.id ? { ...m, text: action.text, updatedAt: Date.now() } : m
        ),
      };
    case "deleteMemo": {
      const deadIds = new Set(state.cards.filter((c) => c.memoId === action.id).map((c) => c.id));
      return {
        ...state,
        memos: state.memos.filter((m) => m.id !== action.id),
        cards: state.cards.filter((c) => c.memoId !== action.id),
        edges: state.edges.filter((e) => !deadIds.has(e.sourceId) && !deadIds.has(e.targetId)),
        groups: state.groups.map((g) => ({ ...g, cardIds: g.cardIds.filter((id) => !deadIds.has(id)) })),
      };
    }
    case "addCard":
      return {
        ...state,
        cards: [
          ...state.cards,
          { id: crypto.randomUUID(), memoId: action.memoId, x: action.x, y: action.y, createdAt: Date.now(), note: "", tags: [], color: "yellow" },
        ],
      };
    case "addMemoAndCard": {
      const memoId = crypto.randomUUID();
      const now = Date.now();
      return {
        ...state,
        memos: [{ id: memoId, text: "", createdAt: now, updatedAt: now }, ...state.memos],
        cards: [
          ...state.cards,
          { id: crypto.randomUUID(), memoId, x: action.x, y: action.y, createdAt: now, note: "", tags: [], color: "yellow" }
        ],
      };
    }
    case "moveCard": {
      let x = action.x, y = action.y;
      const group = state.groups.find((g) => g.cardIds.includes(action.id));
      if (group) {
        const card = state.cards.find((c) => c.id === action.id);
        const cw = card?.w ?? 160;
        const ch = card?.h ?? 60;
        x = Math.max(group.x, Math.min(group.x + group.w - cw, x));
        y = Math.max(group.y, Math.min(group.y + group.h - ch, y));
      }
      return { ...state, cards: state.cards.map((c) => (c.id === action.id ? { ...c, x, y } : c)) };
    }
    case "moveCards": {
      const moveMap = new Map(action.moves.map((m) => [m.id, m]));
      return { ...state, cards: state.cards.map((c) => { const m = moveMap.get(c.id); return m ? { ...c, x: m.x, y: m.y } : c; }) };
    }
    case "updateCardNote":
      return { ...state, cards: state.cards.map((c) => (c.id === action.id ? { ...c, note: action.note } : c)) };
    case "updateCardSize":
      return { ...state, cards: state.cards.map((c) => (c.id === action.id ? { ...c, w: action.w, h: action.h } : c)) };
    case "addCardTags": {
      if (action.tags.length === 0) return state;
      return {
        ...state,
        cards: state.cards.map((c) => {
          if (c.id !== action.id) return c;
          const next = new Set(c.tags);
          action.tags.forEach((t) => next.add(t));
          return { ...c, tags: Array.from(next) };
        }),
      };
    }
    case "removeCardTag":
      return { ...state, cards: state.cards.map((c) => (c.id === action.id ? { ...c, tags: c.tags.filter((t) => t !== action.tag) } : c)) };
    case "setCardColor":
      return { ...state, cards: state.cards.map((c) => (c.id === action.id ? { ...c, color: action.color } : c)) };
    case "toggleSelectionMode": {
      const next = !state.isSelectionMode;
      return { ...state, isSelectionMode: next, selectedCardIds: next ? state.selectedCardIds : [] };
    }
    case "toggleCardSelection": {
      if (!state.isSelectionMode) return state;
      const has = state.selectedCardIds.includes(action.id);
      return {
        ...state,
        selectedCardIds: has ? state.selectedCardIds.filter((id) => id !== action.id) : [...state.selectedCardIds, action.id],
      };
    }
    case "deleteSelectedCards": {
      if (!state.isSelectionMode || state.selectedCardIds.length === 0) return state;
      const rm = new Set(state.selectedCardIds);
      return {
        ...state,
        cards: state.cards.filter((c) => !rm.has(c.id)),
        edges: state.edges.filter((e) => !rm.has(e.sourceId) && !rm.has(e.targetId)),
        groups: state.groups.map((g) => ({ ...g, cardIds: g.cardIds.filter((id) => !rm.has(id)) })),
        selectedCardIds: [],
      };
    }
    case "linkSelectedCards": {
      if (!state.isSelectionMode || state.selectedCardIds.length < 2) return state;
      const ids = state.selectedCardIds;
      const nextEdges = [...state.edges];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const src = ids[i], tgt = ids[j];
          const idx = nextEdges.findIndex(
            (e) => (e.sourceId === src && e.targetId === tgt) || (e.sourceId === tgt && e.targetId === src)
          );
          if (idx >= 0) {
            nextEdges[idx] = { ...nextEdges[idx], sourceId: src, targetId: tgt, type: action.linkType };
          } else {
            nextEdges.push({ id: crypto.randomUUID(), sourceId: src, targetId: tgt, type: action.linkType, label: "" });
          }
        }
      }
      return { ...state, edges: nextEdges };
    }
    case "unlinkSelectedCards": {
      const sel = new Set(state.selectedCardIds);
      return { ...state, edges: state.edges.filter((e) => !(sel.has(e.sourceId) && sel.has(e.targetId))) };
    }
    case "updateEdgeLabel":
      return { ...state, edges: state.edges.map((e) => (e.id === action.id ? { ...e, label: action.label } : e)) };
    case "groupSelectedCards": {
      if (state.selectedCardIds.length === 0) return state;
      const color = GROUP_COLORS[state.groups.length % GROUP_COLORS.length];
      const members = state.selectedCardIds.map((id) => state.cards.find(c => c.id === id)).filter(Boolean) as CardInstance[];
      let minX = 40, minY = 40, maxX = 240, maxY = 240;
      if (members.length > 0) {
        const PAD = 16;
        minX = Math.min(...members.map((c) => c.x)) - PAD;
        minY = Math.min(...members.map((c) => c.y)) - PAD;
        maxX = Math.max(...members.map((c) => c.x + CARD_HALF_W * 2)) + PAD;
        maxY = Math.max(...members.map((c) => c.y + CARD_HALF_H * 2)) + PAD;
      }
      return {
        ...state,
        groups: [...state.groups, { id: crypto.randomUUID(), name: "グループ", cardIds: [...state.selectedCardIds], color, x: minX, y: minY, w: maxX - minX, h: maxY - minY }],
      };
    }
    case "updateGroupBounds":
      return { ...state, groups: state.groups.map(g => g.id === action.id ? { ...g, w: action.w, h: action.h } : g) };
    case "moveGroupAbsolute": {
      const g = state.groups.find(x => x.id === action.id);
      if (!g) return state;
      const dx = action.x - g.x;
      const dy = action.y - g.y;
      const movedCardIds = new Set(g.cardIds);
      return {
        ...state,
        groups: state.groups.map(gx => gx.id === action.id ? { ...gx, x: action.x, y: action.y } : gx),
        cards: state.cards.map(c => movedCardIds.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : c)
      };
    }
    case "deleteGroup":
      return { ...state, groups: state.groups.filter((g) => g.id !== action.id) };
    case "updateGroupName":
      return { ...state, groups: state.groups.map((g) => (g.id === action.id ? { ...g, name: action.name } : g)) };
    case "clearSelection":
      return { ...state, selectedCardIds: [] };
    case "setTab":
      return { ...state, activeTab: action.tab };
    case "restore":
      return { ...action.state, hydrated: true };
    case "hydrate": {
      const s = action.state;
      const migratedEdges: LinkEdge[] = Array.isArray(s.edges)
        ? s.edges.map((e: any) => ({ ...e, label: e.label ?? "" }))
        : [];
      if (migratedEdges.length === 0 && Array.isArray(s.cards)) {
        for (const card of s.cards) {
          for (const targetId of card.links ?? []) {
            if (card.id < targetId) {
              migratedEdges.push({ id: crypto.randomUUID(), sourceId: card.id, targetId, type: "two-way", label: "" });
            }
          }
        }
      }
      const parsedCards = (s.cards ?? []).map((c: any) => ({
        id: c.id, memoId: c.memoId, x: c.x, y: c.y, createdAt: c.createdAt,
        note: c.note ?? "", tags: c.tags ?? [], color: c.color ?? "yellow",
      }));
      const parsedMemos = (s.memos ?? []).map((m: any) => ({
        id: m.id, text: m.text ?? "", createdAt: m.createdAt ?? Date.now(), updatedAt: m.updatedAt ?? Date.now(),
        folderId: m.folderId ?? null,
      }));
      const parsedFolders = (s.folders ?? []).map((f: any) => ({
        id: f.id, name: f.name ?? "フォルダ", color: f.color ?? FOLDER_COLORS[0],
        parentId: f.parentId ?? null, order: f.order ?? 0, createdAt: f.createdAt ?? Date.now(),
      }));
      return {
        ...initialState,
        ...s,
        memos: parsedMemos,
        edges: migratedEdges,
        folders: parsedFolders,
        hydrated: true,
        isSelectionMode: false,
        selectedCardIds: [],
        cards: parsedCards,
        groups: (s.groups ?? []).map((g: any) => {
          if (typeof g.w === "number") return g;
          const members = (g.cardIds || []).map((id: string) => parsedCards.find((c: any) => c.id === id)).filter(Boolean);
          if (members.length === 0) return { ...g, x: 0, y: 0, w: 200, h: 200 };
          const minX = Math.min(...members.map((c: any) => c.x)) - 16;
          const minY = Math.min(...members.map((c: any) => c.y)) - 16;
          const maxX = Math.max(...members.map((c: any) => c.x + 160)) + 16;
          const maxY = Math.max(...members.map((c: any) => c.y + 60)) + 16;
          return { ...g, x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }),
      };
    }
    case "addFolder": {
      const siblings = state.folders.filter((f) => f.parentId === action.parentId);
      const order = siblings.length > 0 ? Math.max(...siblings.map((f) => f.order)) + 1 : 0;
      return {
        ...state,
        folders: [...state.folders, { id: crypto.randomUUID(), name: "新しいフォルダ", color: FOLDER_COLORS[0], parentId: action.parentId, order, createdAt: Date.now() }],
      };
    }
    case "renameFolder":
      return { ...state, folders: state.folders.map((f) => (f.id === action.id ? { ...f, name: action.name } : f)) };
    case "setFolderColor":
      return { ...state, folders: state.folders.map((f) => (f.id === action.id ? { ...f, color: action.color } : f)) };
    case "deleteFolder": {
      const toDelete = new Set<string>();
      const queue = [action.id];
      while (queue.length > 0) {
        const id = queue.shift()!;
        toDelete.add(id);
        state.folders.filter((f) => f.parentId === id).forEach((f) => queue.push(f.id));
      }
      return {
        ...state,
        folders: state.folders.filter((f) => !toDelete.has(f.id)),
        memos: state.memos.map((m) => (m.folderId && toDelete.has(m.folderId) ? { ...m, folderId: null } : m)),
      };
    }
    case "moveMemoToFolder":
      return { ...state, memos: state.memos.map((m) => (m.id === action.memoId ? { ...m, folderId: action.folderId } : m)) };
    case "reorderFolder": {
      const dragFolder = state.folders.find((f) => f.id === action.dragId);
      const targetFolder = state.folders.find((f) => f.id === action.targetId);
      if (!dragFolder || !targetFolder || dragFolder.id === targetFolder.id) return state;
      const parentId = targetFolder.parentId;
      const siblings = state.folders
        .filter((f) => f.parentId === parentId && f.id !== action.dragId)
        .sort((a, b) => a.order - b.order);
      const targetIdx = siblings.findIndex((f) => f.id === action.targetId);
      const insertIdx = action.position === "before" ? targetIdx : targetIdx + 1;
      siblings.splice(insertIdx, 0, { ...dragFolder, parentId });
      return {
        ...state,
        folders: [
          ...state.folders.filter((f) => f.parentId !== parentId && f.id !== action.dragId),
          ...siblings.map((f, i) => ({ ...f, order: i })),
        ],
      };
    }
    case "moveFolderToParent": {
      const isDescendant = (folderId: string, ancestorId: string): boolean => {
        let cur = state.folders.find((f) => f.id === folderId);
        while (cur && cur.parentId) {
          if (cur.parentId === ancestorId) return true;
          cur = state.folders.find((f) => f.id === cur!.parentId);
        }
        return false;
      };
      if (action.parentId === action.id) return state;
      if (action.parentId && isDescendant(action.parentId, action.id)) return state;
      const siblings = state.folders.filter((f) => f.parentId === action.parentId && f.id !== action.id);
      const newOrder = siblings.length > 0 ? Math.max(...siblings.map((f) => f.order)) + 1 : 0;
      return { ...state, folders: state.folders.map((f) => (f.id === action.id ? { ...f, parentId: action.parentId, order: newOrder } : f)) };
    }
    default:
      return state;
  }
}

// ─── Arrow geometry ───────────────────────────────────────────────────────────

function cardEdgePoint(cardCx: number, cardCy: number, halfW: number, halfH: number, towardCx: number, towardCy: number) {
  const dx = towardCx - cardCx, dy = towardCy - cardCy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.5) return { x: cardCx, y: cardCy };
  const nx = dx / len, ny = dy / len;
  const t = Math.min(halfW / (Math.abs(nx) || 1e-9), halfH / (Math.abs(ny) || 1e-9));
  return { x: cardCx + nx * t, y: cardCy + ny * t };
}

function edgePoints(src: CardInstance, tgt: CardInstance) {
  const hw1 = (src.w || 160) / 2;
  const hh1 = (src.h || 60) / 2;
  const hw2 = (tgt.w || 160) / 2;
  const hh2 = (tgt.h || 60) / 2;
  const cx1 = src.x + hw1, cy1 = src.y + hh1;
  const cx2 = tgt.x + hw2, cy2 = tgt.y + hh2;
  const p1 = cardEdgePoint(cx1, cy1, hw1, hh1, cx2, cy2);
  const p2 = cardEdgePoint(cx2, cy2, hw2, hh2, cx1, cy1);
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, mx: (cx1 + cx2) / 2, my: (cy1 + cy2) / 2 };
}

// ─── Layout algorithms ────────────────────────────────────────────────────────

/** ⊞ Grid: arrange cards in a square grid */
function gridLayout(cards: CardInstance[]): { id: string; x: number; y: number }[] {
  if (cards.length === 0) return [];
  const COLS = Math.ceil(Math.sqrt(cards.length));
  const COL_W = 200, ROW_H = 100;
  return cards.map((c, i) => ({
    id: c.id,
    x: 40 + (i % COLS) * COL_W,
    y: 40 + Math.floor(i / COLS) * ROW_H,
  }));
}

/** ⬇ Tree: layer cards by directed-edge depth (left→right columns) */
function treeLayout(cards: CardInstance[], edges: LinkEdge[]): { id: string; x: number; y: number }[] {
  if (cards.length === 0) return [];
  const cardIds = new Set(cards.map((c) => c.id));
  const children = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const c of cards) { children.set(c.id, []); inDeg.set(c.id, 0); }

  for (const e of edges) {
    if (!cardIds.has(e.sourceId) || !cardIds.has(e.targetId)) continue;
    // Treat both one-way and two-way as directed source→target for layer assignment
    children.get(e.sourceId)!.push(e.targetId);
    inDeg.set(e.targetId, (inDeg.get(e.targetId) ?? 0) + 1);
  }

  // Roots = nodes with no incoming edges
  const roots = cards.filter((c) => inDeg.get(c.id) === 0).map((c) => c.id);
  const startIds = roots.length > 0 ? roots : [cards[0].id];

  // BFS to assign layers
  const layer = new Map<string, number>();
  const queue: { id: string; l: number }[] = startIds.map((id) => ({ id, l: 0 }));
  const visited = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const { id, l } = queue[i];
    if (visited.has(id)) continue;
    visited.add(id);
    layer.set(id, Math.max(layer.get(id) ?? 0, l));
    for (const child of children.get(id) ?? []) {
      if (!visited.has(child)) queue.push({ id: child, l: l + 1 });
    }
  }
  const maxL = Math.max(0, ...Array.from(layer.values()));
  for (const c of cards) if (!layer.has(c.id)) layer.set(c.id, maxL + 1);

  // Group by layer, sort each layer to minimise edge crossings (heuristic)
  const byLayer = new Map<number, string[]>();
  for (const [id, l] of layer) {
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(id);
  }

  const LAYER_X = 220, CARD_Y = 100;
  const result: { id: string; x: number; y: number }[] = [];
  for (const [l, ids] of [...byLayer.entries()].sort(([a], [b]) => a - b)) {
    ids.forEach((id, j) => result.push({ id, x: 40 + l * LAYER_X, y: 40 + j * CARD_Y }));
  }
  return result;
}

/** ◎ Radial: most-connected node at center, BFS rings radiate outward */
function radialLayout(cards: CardInstance[], edges: LinkEdge[]): { id: string; x: number; y: number }[] {
  if (cards.length === 0) return [];
  if (cards.length === 1) return [{ id: cards[0].id, x: 300, y: 220 }];

  const cardIds = new Set(cards.map((c) => c.id));
  // Build undirected adjacency
  const adj = new Map<string, Set<string>>();
  for (const c of cards) adj.set(c.id, new Set());
  for (const e of edges) {
    if (!cardIds.has(e.sourceId) || !cardIds.has(e.targetId)) continue;
    adj.get(e.sourceId)!.add(e.targetId);
    adj.get(e.targetId)!.add(e.sourceId);
  }

  // Pick most-connected node as center
  const centerId = cards.reduce((best, c) =>
    (adj.get(c.id)?.size ?? 0) > (adj.get(best.id)?.size ?? 0) ? c : best
  ).id;

  // BFS from center to assign rings
  const ring = new Map<string, number>([[centerId, 0]]);
  const bfsQ = [centerId];
  for (let i = 0; i < bfsQ.length; i++) {
    const id = bfsQ[i];
    for (const nb of adj.get(id) ?? []) {
      if (!ring.has(nb)) { ring.set(nb, ring.get(id)! + 1); bfsQ.push(nb); }
    }
  }
  const maxRing = Math.max(0, ...Array.from(ring.values()));
  for (const c of cards) if (!ring.has(c.id)) ring.set(c.id, maxRing + 1);

  const byRing = new Map<number, string[]>();
  for (const [id, r] of ring) {
    if (!byRing.has(r)) byRing.set(r, []);
    byRing.get(r)!.push(id);
  }

  const CX = 420, CY = 300, RING_R = 190;
  const result: { id: string; x: number; y: number }[] = [];
  result.push({ id: centerId, x: CX - 80, y: CY - 30 });
  for (const [r, ids] of byRing) {
    if (r === 0) continue;
    const radius = r * RING_R;
    ids.forEach((id, j) => {
      const angle = (j / ids.length) * 2 * Math.PI - Math.PI / 2;
      result.push({ id, x: CX + Math.cos(angle) * radius - 80, y: CY + Math.sin(angle) * radius - 30 });
    });
  }
  return result;
}

// ─── Tag drag transfer (module-level fallback for WebView2/Tauri) ─────────────
// dataTransfer.types may not be populated during dragover in WebView2,
// so we track the dragged tag in a module variable as a reliable fallback.
let _activeTagDrag: string | null = null;

// ─── Folder drag (module-level, same WebView2 workaround pattern) ─────────────
let _draggingFolderId: string | null = null;

// ─── FolderItem ───────────────────────────────────────────────────────────────

type FolderFilter = "__all__" | "__unfiled__" | string;

function FolderItem({
  folder, folders, depth, isActive, onSelect, onAddChild, onRename, onSetColor,
  onDelete, onReorder, onMoveParent, children,
}: {
  folder: Folder; folders: Folder[]; depth: number; isActive: boolean;
  onSelect: (id: FolderFilter) => void;
  onAddChild: (parentId: string) => void;
  onRename: (id: string, name: string) => void;
  onSetColor: (id: string, color: string) => void;
  onDelete: (id: string) => void;
  onReorder: (dragId: string, targetId: string, position: "before" | "after") => void;
  onMoveParent: (id: string, parentId: string | null) => void;
  children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(folder.name);
  const [showColors, setShowColors] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [dropPos, setDropPos] = useState<"before" | "after" | null>(null);

  const commitRename = () => {
    const trimmed = editName.trim();
    onRename(folder.id, trimmed || folder.name);
    setEditing(false);
  };

  // Draggable row – pointer-capture approach to avoid WebView2 DnD issues
  const rowRef = useRef<HTMLDivElement>(null);

  function onDragHandleDown(e: React.PointerEvent<HTMLSpanElement>) {
    _draggingFolderId = folder.id;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.stopPropagation();
  }
  function onDragHandleUp(e: React.PointerEvent<HTMLSpanElement>) {
    _draggingFolderId = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Drop zone
  function onRowPointerEnter(e: React.PointerEvent<HTMLDivElement>) {
    if (!_draggingFolderId || _draggingFolderId === folder.id) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDropPos(e.clientY < rect.top + rect.height / 2 ? "before" : "after");
  }
  function onRowPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!_draggingFolderId || _draggingFolderId === folder.id) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDropPos(e.clientY < rect.top + rect.height / 2 ? "before" : "after");
  }
  function onRowPointerLeave() { setDropPos(null); }
  function onRowPointerUp() {
    if (_draggingFolderId && _draggingFolderId !== folder.id && dropPos) {
      onReorder(_draggingFolderId, folder.id, dropPos);
    }
    setDropPos(null);
  }

  // All non-descendant folders for "move to parent" select
  const isDescendantOf = (checkId: string, ancestorId: string): boolean => {
    let cur = folders.find((f) => f.id === checkId);
    while (cur && cur.parentId) {
      if (cur.parentId === ancestorId) return true;
      cur = folders.find((f) => f.id === cur!.parentId);
    }
    return false;
  };
  const parentOptions = folders.filter(
    (f) => f.id !== folder.id && !isDescendantOf(f.id, folder.id)
  );

  return (
    <div style={{ position: "relative" }}>
      {dropPos === "before" && <div className="folder-drop-indicator" />}
      <div
        ref={rowRef}
        className={`folder-row${isActive ? " active" : ""}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onPointerEnter={onRowPointerEnter}
        onPointerMove={onRowPointerMove}
        onPointerLeave={onRowPointerLeave}
        onPointerUp={onRowPointerUp}
      >
        <span
          className="folder-drag-handle"
          onPointerDown={onDragHandleDown}
          onPointerUp={onDragHandleUp}
          title="ドラッグで並び替え"
        >⠿</span>
        <span
          className="folder-color-dot"
          style={{ background: folder.color }}
          onClick={() => { setShowColors((v) => !v); setShowMove(false); }}
          title="色を変更"
        />
        {editing ? (
          <input
            className="folder-name-input"
            value={editName}
            autoFocus
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setEditName(folder.name); setEditing(false); } }}
          />
        ) : (
          <span className="folder-name" onClick={() => onSelect(folder.id)} onDoubleClick={() => { setEditName(folder.name); setEditing(true); }} title="クリック: 選択 / ダブルクリック: 名前変更">
            {folder.name}
          </span>
        )}
        <span className="folder-actions">
          <button className="folder-btn-icon" title="名前変更" onClick={() => { setEditName(folder.name); setEditing(true); }}>✎</button>
          <button className="folder-btn-icon" title="サブフォルダ追加" onClick={() => onAddChild(folder.id)}>＋</button>
          <button className="folder-btn-icon" title="移動" onClick={() => { setShowMove((v) => !v); setShowColors(false); }}>↕</button>
          <button className="folder-btn-icon danger" title="削除" onClick={() => onDelete(folder.id)}>×</button>
        </span>
      </div>
      {showColors && (
        <div className="folder-color-picker" style={{ paddingLeft: 8 + depth * 16 + 20 }}>
          {FOLDER_COLORS.map((c) => (
            <span
              key={c}
              className={`folder-color-swatch${folder.color === c ? " active" : ""}`}
              style={{ background: c }}
              onClick={() => { onSetColor(folder.id, c); setShowColors(false); }}
            />
          ))}
        </div>
      )}
      {showMove && (
        <div className="folder-move-row" style={{ paddingLeft: 8 + depth * 16 + 20 }}>
          <select
            className="folder-parent-select"
            value={folder.parentId ?? ""}
            onChange={(e) => { onMoveParent(folder.id, e.target.value || null); setShowMove(false); }}
          >
            <option value="">ルート</option>
            {parentOptions.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>
      )}
      {dropPos === "after" && <div className="folder-drop-indicator" />}
      {children}
    </div>
  );
}

// ─── FolderSidebar ────────────────────────────────────────────────────────────

function FolderSidebar({
  width, folders, activeFolderId, onSelect, onAdd, onAddChild, onRename, onSetColor,
  onDelete, onReorder, onMoveParent,
}: {
  width: number;
  folders: Folder[]; activeFolderId: FolderFilter;
  onSelect: (id: FolderFilter) => void; onAdd: () => void;
  onAddChild: (parentId: string) => void;
  onRename: (id: string, name: string) => void;
  onSetColor: (id: string, color: string) => void;
  onDelete: (id: string) => void;
  onReorder: (dragId: string, targetId: string, position: "before" | "after") => void;
  onMoveParent: (id: string, parentId: string | null) => void;
}) {
  const renderTree = (parentId: string | null, depth: number): React.ReactNode =>
    folders
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.order - b.order)
      .map((folder) => (
        <FolderItem
          key={folder.id}
          folder={folder}
          folders={folders}
          depth={depth}
          isActive={activeFolderId === folder.id}
          onSelect={onSelect}
          onAddChild={onAddChild}
          onRename={onRename}
          onSetColor={onSetColor}
          onDelete={onDelete}
          onReorder={onReorder}
          onMoveParent={onMoveParent}
        >
          {renderTree(folder.id, depth + 1)}
        </FolderItem>
      ));

  return (
    <div className="memo-sidebar" style={{ width }}>
      <button className={`folder-filter-btn${activeFolderId === "__all__" ? " active" : ""}`} onClick={() => onSelect("__all__")}>すべて</button>
      <button className={`folder-filter-btn${activeFolderId === "__unfiled__" ? " active" : ""}`} onClick={() => onSelect("__unfiled__")}>未分類</button>
      <div className="folder-list">{renderTree(null, 0)}</div>
      <button className="btn small" style={{ marginTop: 6 }} onClick={onAdd}>＋ フォルダ</button>
    </div>
  );
}

// ─── ResizeDivider ────────────────────────────────────────────────────────────

function ResizeDivider({ onDrag }: { onDrag: (dx: number) => void }) {
  const startXRef = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  return (
    <div
      className={active ? "resize-divider active" : "resize-divider"}
      onPointerDown={(e) => {
        startXRef.current = e.clientX;
        setActive(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        e.stopPropagation();
      }}
      onPointerMove={(e) => {
        if (startXRef.current === null) return;
        const dx = e.clientX - startXRef.current;
        startXRef.current = e.clientX;
        onDrag(dx);
      }}
      onPointerUp={() => { startXRef.current = null; setActive(false); }}
    />
  );
}

// ─── Group component ──────────────────────────────────────────────────────────

type GroupProps = {
  group: CardGroup;
  outerRef: React.RefObject<HTMLDivElement>;
  zoom: number;
  pan: { x: number; y: number };
  onMoveGroup: (id: string, x: number, y: number) => void;
  onResizeGroup: (id: string, w: number, h: number) => void;
};

function GroupEl({ group, outerRef, zoom, pan, onMoveGroup, onResizeGroup }: GroupProps) {
  const pointerIdRef = useRef<number | null>(null);
  const dragModeRef = useRef<"none" | "move" | "resize">("none");
  const startRef = useRef({ cx: 0, cy: 0, gx: 0, gy: 0, gw: 0, gh: 0 });

  function screenToCanvas(clientX: number, clientY: number) {
    const rect = outerRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - pan.x) / zoom,
      y: (clientY - rect.top - pan.y) / zoom,
    };
  }

  function handleDown(e: React.PointerEvent<HTMLDivElement>, mode: "move" | "resize") {
    const pos = screenToCanvas(e.clientX, e.clientY);
    dragModeRef.current = mode;
    pointerIdRef.current = e.pointerId;
    startRef.current = { cx: pos.x, cy: pos.y, gx: group.x, gy: group.y, gw: group.w, gh: group.h };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.stopPropagation();
  }

  function handleMove(e: React.PointerEvent<HTMLDivElement>) {
    if (dragModeRef.current === "none" || pointerIdRef.current !== e.pointerId) return;
    const pos = screenToCanvas(e.clientX, e.clientY);
    const origin = startRef.current;
    const dx = pos.x - origin.cx;
    const dy = pos.y - origin.cy;
    if (dragModeRef.current === "move") {
      onMoveGroup(group.id, origin.gx + dx, origin.gy + dy);
    } else if (dragModeRef.current === "resize") {
      onResizeGroup(group.id, Math.max(100, origin.gw + dx), Math.max(50, origin.gh + dy));
    }
  }

  function handleUp(e: React.PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    dragModeRef.current = "none";
    pointerIdRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  return (
    <div
      className="group-rect"
      style={{
        left: group.x, top: group.y, width: group.w, height: group.h,
        background: group.color + "88", borderColor: group.color, pointerEvents: "auto"
      }}
    >
      <div
        style={{ cursor: "move", width: "100%", height: "100%", position: "absolute", top: 0, left: 0 }}
        onPointerDown={(e) => handleDown(e, "move")}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
      />
      <span className="group-label" style={{ pointerEvents: "none", position: "relative" }}>{group.name}</span>
      <div
        style={{
          position: "absolute", right: -4, bottom: -4, width: 20, height: 20, cursor: "nwse-resize",
          background: group.color, border: "2px solid rgba(0,0,0,0.2)", borderRadius: "4px"
        }}
        onPointerDown={(e) => handleDown(e, "resize")}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
      />
    </div>
  );
}

// ─── Card component ───────────────────────────────────────────────────────────

type CardProps = {
  card: CardInstance;
  text: string;
  outerRef: React.RefObject<HTMLDivElement>;
  zoom: number;
  pan: { x: number; y: number };
  onMove: (id: string, x: number, y: number) => void;
  onSizeChange: (id: string, w: number, h: number) => void;
  isSelectionMode: boolean;
  isSelected: boolean;
  selectionIndex?: number;
  isSearchMatch: boolean;
  isInfoActive: boolean;
  isTagHighlight: boolean;
  onToggleSelect: (id: string) => void;
  onInfo: (id: string) => void;
  onTagDrop: (id: string, tag: string) => void;
};

function CardEl({ card, text, outerRef, zoom, pan, onMove, onSizeChange, isSelectionMode, isSelected, selectionIndex, isSearchMatch, isInfoActive, isTagHighlight, onToggleSelect, onInfo, onTagDrop }: CardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const offsetRef = useRef({ x: 0, y: 0 });
  const pointerIdRef = useRef<number | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    if (!cardRef.current) return;
    const observer = new ResizeObserver(() => {
      if (cardRef.current) {
        onSizeChange(card.id, cardRef.current.offsetWidth, cardRef.current.offsetHeight);
      }
    });
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [card.id, onSizeChange]);

  function screenToCanvas(clientX: number, clientY: number) {
    const rect = outerRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - pan.x) / zoom,
      y: (clientY - rect.top - pan.y) / zoom,
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (isSelectionMode) { onToggleSelect(card.id); e.preventDefault(); return; }
    const pos = screenToCanvas(e.clientX, e.clientY);
    draggingRef.current = true;
    pointerIdRef.current = e.pointerId;
    offsetRef.current = { x: pos.x - card.x, y: pos.y - card.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
    const pos = screenToCanvas(e.clientX, e.clientY);
    onMove(card.id, pos.x - offsetRef.current.x, pos.y - offsetRef.current.y);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    draggingRef.current = false;
    pointerIdRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const cls = ["card", `color-${card.color}`, isSelected ? "selected" : "", isSearchMatch ? "search-match" : "", isInfoActive ? "info-active" : "", isTagHighlight ? "tag-highlight" : "", isDragOver ? "drag-over" : ""]
    .filter(Boolean).join(" ");

  return (
    <div
      ref={cardRef}
      className={cls}
      style={{ left: card.x, top: card.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDragOver={(e) => { if (_activeTagDrag !== null || e.dataTransfer.types.includes("text/tag")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setIsDragOver(true); } }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => { setIsDragOver(false); const tag = _activeTagDrag || e.dataTransfer.getData("text/tag"); _activeTagDrag = null; if (tag) { e.preventDefault(); onTagDrop(card.id, tag); } }}
    >
      {selectionIndex !== undefined && (
        <div className="selection-badge">{selectionIndex + 1}</div>
      )}
      <button
        className="card-info-btn"
        title="カード詳細"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onInfo(card.id); }}
      >ℹ</button>
      {text || "(empty)"}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const canvasOuterRef = useRef<HTMLDivElement>(null);
  const [tagInput, setTagInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [snapToGrid, setSnapToGrid] = useState(false);
  const GRID = 20;

  // Zoom & pan (UI state, not persisted)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanningRef = useRef(false);

  // Center origin on first render
  useEffect(() => {
    const el = canvasOuterRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPan({ x: width / 2, y: height / 2 });
  }, []);
  const panStartRef = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  // Selected edge for label editing
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const selectedEdge = selectedEdgeId ? state.edges.find((e) => e.id === selectedEdgeId) ?? null : null;
  
  // Memo editing state in the left sidebar
  const [editingMemoId, setEditingMemoId] = useState<string | null>(null);

  // Active info card (independent of selection mode)
  const [activeInfoCardId, setActiveInfoCardId] = useState<string | null>(null);

  // Tag filter: clicking a tag in toolbar highlights matching cards
  const [activeFilterTag, setActiveFilterTag] = useState<string | null>(null);

  // Folder filter for memo mode
  const [activeFolderId, setActiveFolderId] = useState<FolderFilter>("__all__");

  // Helper: all descendant folder IDs of a given folder
  const getDescendantIds = useCallback((rootId: string): Set<string> => {
    const result = new Set<string>();
    const queue = [rootId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      result.add(id);
      state.folders.filter((f) => f.parentId === id).forEach((f) => queue.push(f.id));
    }
    return result;
  }, [state.folders]);

  const filteredMemos = useMemo(() => {
    if (activeFolderId === "__all__") return state.memos;
    if (activeFolderId === "__unfiled__") return state.memos.filter((m) => !m.folderId);
    const ids = getDescendantIds(activeFolderId);
    return state.memos.filter((m) => m.folderId && ids.has(m.folderId));
  }, [state.memos, activeFolderId, getDescendantIds]);

  // Resizable panel widths
  const [folderSidebarWidth, setFolderSidebarWidth] = useState(270);
  const [leftPanelWidth, setLeftPanelWidth] = useState(200);
  const [rightPanelWidth, setRightPanelWidth] = useState(280);

  // Undo/Redo
  const pastRef = useRef<State[]>([]);
  const futureRef = useRef<State[]>([]);

  const dispatchWithHistory = useCallback(
    (action: Action) => {
      if (!SKIP_HISTORY.has(action.type)) {
        pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), state];
        futureRef.current = [];
      }
      dispatch(action);
    },
    [state]
  );

  const undo = useCallback(() => {
    if (pastRef.current.length === 0) return;
    const prev = pastRef.current[pastRef.current.length - 1];
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [state, ...futureRef.current.slice(0, HISTORY_LIMIT - 1)];
    dispatch({ type: "restore", state: prev });
  }, [state]);

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const next = futureRef.current[0];
    futureRef.current = futureRef.current.slice(1);
    pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), state];
    dispatch({ type: "restore", state: next });
  }, [state]);

  // Hydrate
  useEffect(() => {
    tauriStore.get<{ value: string } | string>(STORAGE_KEY).then(async (data) => {
      // Compatibility with older local storage items if needed, but let's just stick to Store API.
      // If store is empty, try grabbing from localStorage just to migrate old data
      let raw = typeof data === "string" ? data : (data as any)?.value;
      if (!raw) {
        raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("brainstorming-v0");
        if (raw) {
          // migrate to tauri store
          await tauriStore.set(STORAGE_KEY, raw);
          await tauriStore.save();
        }
      }
      
      if (!raw) return;
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed && Array.isArray(parsed.memos) && Array.isArray(parsed.cards)) {
          dispatch({ type: "hydrate", state: parsed });
        }
      } catch {}
    }).catch(console.error);
  }, []);

  // Persist
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

  // Wheel zoom
  function onCanvasWheel(e: React.WheelEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom((z) => {
      const nz = Math.min(3, Math.max(0.2, z * delta));
      setPan((p) => ({
        x: mouseX - (mouseX - p.x) * (nz / z),
        y: mouseY - (mouseY - p.y) * (nz / z),
      }));
      return nz;
    });
  }

  // Pan
  function onCanvasPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const isBg = (e.target as HTMLElement).classList.contains("canvas") || (e.target as HTMLElement).classList.contains("canvas-inner");
    if (e.button === 1 || (e.button === 0 && isBg)) {
      isPanningRef.current = true;
      panStartRef.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    }
  }

  // Double-click to add new memo
  function onCanvasDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    const isBg = (e.target as HTMLElement).classList.contains("canvas") || (e.target as HTMLElement).classList.contains("canvas-inner");
    if (!isBg) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const x = (mouseX - pan.x) / zoom;
    const y = (mouseY - pan.y) / zoom;
    dispatchWithHistory({ type: "addMemoAndCard", x: snap(x), y: snap(y) });
  }
  function onCanvasPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isPanningRef.current) return;
    setPan({
      x: panStartRef.current.px + (e.clientX - panStartRef.current.mx),
      y: panStartRef.current.py + (e.clientY - panStartRef.current.my),
    });
  }
  function onCanvasPointerUp() {
    isPanningRef.current = false;
  }

  const memosById = useMemo(() => { const m = new Map<string, Memo>(); state.memos.forEach((x) => m.set(x.id, x)); return m; }, [state.memos]);
  const cardsById = useMemo(() => { const m = new Map<string, CardInstance>(); state.cards.forEach((c) => m.set(c.id, c)); return m; }, [state.cards]);

  // Resolve active info card (cleared automatically if the card is deleted)
  const activeInfoCard = activeInfoCardId ? cardsById.get(activeInfoCardId) ?? null : null;
  useEffect(() => {
    if (activeInfoCardId && !cardsById.has(activeInfoCardId)) setActiveInfoCardId(null);
  }, [cardsById, activeInfoCardId]);

  const selectedHasLinks = useMemo(() => {
    if (state.selectedCardIds.length < 2) return false;
    const sel = new Set(state.selectedCardIds);
    return state.edges.some((e) => sel.has(e.sourceId) && sel.has(e.targetId));
  }, [state.selectedCardIds, state.edges]);

  const searchMatchIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return new Set<string>();
    const matchMemos = new Set(state.memos.filter((m) => m.text.toLowerCase().includes(q)).map((m) => m.id));
    return new Set(state.cards.filter((c) => matchMemos.has(c.memoId)).map((c) => c.id));
  }, [searchQuery, state.memos, state.cards]);

  // All unique tags across all cards (sorted)
  const allTags = useMemo(() => {
    const set = new Set<string>();
    state.cards.forEach((c) => c.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [state.cards]);

  // Cards matching the active filter tag
  const tagFilterMatchIds = useMemo(() => {
    if (!activeFilterTag) return new Set<string>();
    return new Set(state.cards.filter((c) => c.tags.includes(activeFilterTag)).map((c) => c.id));
  }, [activeFilterTag, state.cards]);

  useEffect(() => { setTagInput(""); }, [activeInfoCardId]);

  function snap(v: number) { return snapToGrid ? Math.round(v / GRID) * GRID : v; }

  function commitTags() {
    if (!activeInfoCard) return;
    const tags = tagInput.split(",").map((t) => t.trim().replace(/^#+/, "")).filter(Boolean);
    if (!tags.length) return;
    dispatchWithHistory({ type: "addCardTags", id: activeInfoCard.id, tags });
    setTagInput("");
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `brainstorm-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const importRef = useRef<HTMLInputElement>(null);
  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        if (parsed && Array.isArray(parsed.memos)) dispatchWithHistory({ type: "hydrate", state: parsed });
        else alert("無効なJSONファイルです。");
      } catch { alert("JSONの読み込みに失敗しました。"); }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function runLayout(fn: () => { id: string; x: number; y: number }[]) {
    const moves = fn();
    if (moves.length === 0) return;
    dispatchWithHistory({ type: "moveCards", moves });
  }

  // ─── Board panels ─────────────────────────────────────────────────────────

  const searchedMemos = state.memos.filter(memo =>
    searchQuery.trim() === "" || memo.text.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );

  const boardList = (
    <div className="board-left" style={{ width: leftPanelWidth }}>
      <div className="panel-title">Memos</div>
      {searchedMemos.length === 0 && <div className="muted">No memos match</div>}
      {searchedMemos.map((memo) => {
        const count = state.cards.filter((c) => c.memoId === memo.id).length;
        const base = 24 + count * 12;
        const isEditing = editingMemoId === memo.id;
        return (
          <div className="board-memo" key={memo.id} style={isEditing ? { flexWrap: "wrap" } : {}}>
            {isEditing ? (
              <div style={{ display: "flex", flexDirection: "column", width: "100%", gap: "4px" }}>
                <textarea
                  className="detail-textarea"
                  style={{ minHeight: "60px", fontSize: "12px", width: "100%", boxSizing: "border-box" }}
                  autoFocus
                  value={memo.text}
                  onChange={(e) => dispatchWithHistory({ type: "updateMemo", id: memo.id, text: e.target.value })}
                  onBlur={() => setEditingMemoId(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) {
                      setEditingMemoId(null);
                    }
                  }}
                />
                <button className="btn small" onClick={() => setEditingMemoId(null)} style={{ alignSelf: "flex-end" }}>OK</button>
              </div>
            ) : (
              <>
                <div className="board-memo-text" onDoubleClick={() => setEditingMemoId(memo.id)} title="ダブルクリックでも編集可能">
                  {memo.text || "(empty)"}
                </div>
                <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
                  <button className="btn small" onClick={() => setEditingMemoId(memo.id)}>Edit</button>
                  <button className="btn small" onClick={() => dispatchWithHistory({ type: "addCard", memoId: memo.id, x: snap(base), y: snap(base) })}>
                    Place
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );

  // Reset view: zoom=100%, canvas origin (0,0) at viewport center
  function resetToOrigin() {
    const el = canvasOuterRef.current;
    if (!el) { setZoom(1); setPan({ x: 0, y: 0 }); return; }
    const { width, height } = el.getBoundingClientRect();
    setZoom(1);
    setPan({ x: width / 2, y: height / 2 });
  }

  // Edge click handler (for label selection)
  function onEdgeClick(edgeId: string) {
    setSelectedEdgeId((prev) => (prev === edgeId ? null : edgeId));
  }

  const boardCanvas = (
    <div className="board-right">
      <div className="panel-title">
        Canvas
        <span className="zoom-label">{Math.round(zoom * 100)}%</span>
        <button className="btn small ml-auto" onClick={resetToOrigin} title="ズーム100%・原点中央に戻る">⌖ Home</button>
      </div>
      <div
        ref={canvasOuterRef}
        className="canvas"
        style={snapToGrid ? {
          backgroundImage: "linear-gradient(rgba(0,0,0,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.07) 1px, transparent 1px)",
          backgroundSize: `${GRID * zoom}px ${GRID * zoom}px`,
          backgroundPosition: `${pan.x % (GRID * zoom)}px ${pan.y % (GRID * zoom)}px`,
        } : undefined}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onDoubleClick={onCanvasDoubleClick}
        onWheel={onCanvasWheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Canvas inner: apply zoom+pan transform */}
        <div
          className="canvas-inner"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
        >
          {/* Origin marker at canvas (0, 0) */}
          <svg style={{ position: "absolute", left: -12, top: -12, width: 24, height: 24, pointerEvents: "none", overflow: "visible" }}>
            <line x1="12" y1="0" x2="12" y2="24" stroke="#aaa" strokeWidth="1" strokeDasharray="2,2" />
            <line x1="0" y1="12" x2="24" y2="12" stroke="#aaa" strokeWidth="1" strokeDasharray="2,2" />
            <circle cx="12" cy="12" r="2.5" fill="#aaa" />
          </svg>

          {/* Group backgrounds */}
          {state.groups.map((g) => (
            <GroupEl
              key={g.id}
              group={g}
              outerRef={canvasOuterRef}
              zoom={zoom}
              pan={pan}
              onMoveGroup={(id, x, y) => dispatch({ type: "moveGroupAbsolute", id, x: snap(x), y: snap(y) })}
              onResizeGroup={(id, w, h) => dispatch({ type: "updateGroupBounds", id, w: snap(w), h: snap(h) })}
            />
          ))}

          {/* SVG link layer */}
          <svg className="links-layer" style={{ overflow: "visible" }}>
            <defs>
              <marker id="arr-end" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#2b2b2b" fillOpacity={0.65} />
              </marker>
              <marker id="arr-start" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto-start-reverse">
                <polygon points="0 0, 8 3, 0 6" fill="#2b2b2b" fillOpacity={0.65} />
              </marker>
            </defs>
            {state.edges.map((edge) => {
              const src = cardsById.get(edge.sourceId);
              const tgt = cardsById.get(edge.targetId);
              if (!src || !tgt) return null;
              const { x1, y1, x2, y2, mx, my } = edgePoints(src, tgt);
              const isSelEdge = edge.id === selectedEdgeId;
              return (
                <g key={edge.id}>
                  {/* Wider invisible hit area */}
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} style={{ cursor: "pointer", pointerEvents: "stroke" }} onClick={() => onEdgeClick(edge.id)} />
                  <line
                    x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={isSelEdge ? "#2f5fb3" : "#2b2b2b"}
                    strokeWidth={isSelEdge ? 2.5 : 2}
                    strokeOpacity={isSelEdge ? 0.9 : 0.5}
                    markerEnd="url(#arr-end)"
                    markerStart={edge.type === "two-way" ? "url(#arr-start)" : undefined}
                    style={{ pointerEvents: "none" }}
                  />
                  {edge.label && (
                    <text x={mx} y={my - 6} textAnchor="middle" fontSize={11} fill="#555" style={{ pointerEvents: "none", userSelect: "none" }}>
                      {edge.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Cards */}
          {state.cards.map((card) => {
            const memo = memosById.get(card.memoId);
            if (!memo) return null;
            const selIdx = state.isSelectionMode ? state.selectedCardIds.indexOf(card.id) : -1;
            return (
              <CardEl
                key={card.id}
                card={card}
                text={memo.text}
                outerRef={canvasOuterRef}
                zoom={zoom}
                pan={pan}
                onMove={(id, x, y) => dispatch({ type: "moveCard", id, x: snap(x), y: snap(y) })}
                onSizeChange={(id, w, h) => dispatch({ type: "updateCardSize", id, w, h })}
                isSelectionMode={state.isSelectionMode}
                isSelected={selIdx >= 0}
                selectionIndex={selIdx >= 0 ? selIdx : undefined}
                isSearchMatch={searchMatchIds.has(card.id)}
                isInfoActive={activeInfoCardId === card.id}
                isTagHighlight={tagFilterMatchIds.has(card.id)}
                onToggleSelect={(id) => dispatchWithHistory({ type: "toggleCardSelection", id })}
                onInfo={(id) => setActiveInfoCardId((prev) => (prev === id ? null : id))}
                onTagDrop={(id, tag) => dispatchWithHistory({ type: "addCardTags", id, tags: [tag] })}
              />
            );
          })}
        </div>
      </div>
    </div>
  );

  const detailPanel = activeInfoCard ? (
    <div className="detail-panel" style={{ width: rightPanelWidth }}>
      <div className="panel-title">
        Card Detail
        <button className="btn small ml-auto" style={{ fontSize: 11 }} onClick={() => setActiveInfoCardId(null)}>✕</button>
      </div>

      <div className="detail-label">Color</div>
      <div className="color-picker">
        {CARD_COLORS.map((c) => (
          <button
            key={c.value}
            className={`color-swatch${activeInfoCard.color === c.value ? " active" : ""}`}
            style={{ background: c.bg, borderColor: c.border }}
            title={c.label}
            onClick={() => dispatchWithHistory({ type: "setCardColor", id: activeInfoCard.id, color: c.value })}
          />
        ))}
      </div>

      <div className="detail-label">Note</div>
      <textarea
        className="detail-textarea"
        value={activeInfoCard.note}
        placeholder="メモを追加..."
        onChange={(e) => dispatchWithHistory({ type: "updateCardNote", id: activeInfoCard.id, note: e.target.value })}
      />

      <div className="detail-label">Tags</div>
      <input
        className="detail-input"
        value={tagInput}
        placeholder="タグ追加 (Enter or ,)"
        onChange={(e) => setTagInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitTags(); } }}
      />
      <div className="tag-list">
        {activeInfoCard.tags.map((tag) => (
          <span className="tag" key={tag}>
            #{tag}
            <button type="button" className="tag-remove" onClick={() => dispatchWithHistory({ type: "removeCardTag", id: activeInfoCard.id, tag })}>×</button>
          </span>
        ))}
      </div>
      {allTags.filter((t) => !activeInfoCard.tags.includes(t)).length > 0 && (
        <>
          <div className="detail-label" style={{ marginTop: 6 }}>既存タグから追加</div>
          <div className="tag-list">
            {allTags.filter((t) => !activeInfoCard.tags.includes(t)).map((t) => (
              <span
                key={t}
                className="tag tag-addable"
                onClick={() => dispatchWithHistory({ type: "addCardTags", id: activeInfoCard.id, tags: [t] })}
              >
                + #{t}
              </span>
            ))}
          </div>
        </>
      )}

      {selectedEdge && (
        <>
          <div className="detail-label" style={{ marginTop: 8 }}>選択中のリンクラベル</div>
          <input
            className="detail-input"
            value={selectedEdge.label}
            placeholder="ラベルを入力..."
            onChange={(e) => dispatchWithHistory({ type: "updateEdgeLabel", id: selectedEdge.id, label: e.target.value })}
          />
        </>
      )}
    </div>
  ) : selectedEdge ? (
    <div className="detail-panel" style={{ width: rightPanelWidth }}>
      <div className="panel-title">
        Link Detail
        <button className="btn small ml-auto" style={{ fontSize: 11 }} onClick={() => setSelectedEdgeId(null)}>✕</button>
      </div>
      <div className="detail-label">ラベル</div>
      <input
        className="detail-input"
        value={selectedEdge.label}
        placeholder="ラベルを入力..."
        onChange={(e) => dispatchWithHistory({ type: "updateEdgeLabel", id: selectedEdge.id, label: e.target.value })}
      />
      <div className="detail-label" style={{ marginTop: 8 }}>種別</div>
      <div style={{ fontSize: 13 }}>{selectedEdge.type === "one-way" ? "一方向 →" : "双方向 ↔"}</div>
    </div>
  ) : null;

  const hasDetail = !!(activeInfoCard || selectedEdge);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <input ref={importRef} type="file" accept=".json" style={{ display: "none" }} onChange={handleImport} />

      <header className="topbar">
        <div className="title">Brainstorming</div>
        <div className="topbar-actions">
          <button className="btn small topbar-btn" onClick={exportJSON}>Export</button>
          <button className="btn small topbar-btn" onClick={() => importRef.current?.click()}>Import</button>
        </div>
        <div className="tabs">
          <button className={state.activeTab === "memo" ? "tab active" : "tab"} onClick={() => dispatchWithHistory({ type: "setTab", tab: "memo" })}>Memo</button>
          <button className={state.activeTab === "board" ? "tab active" : "tab"} onClick={() => dispatchWithHistory({ type: "setTab", tab: "board" })}>Board</button>
        </div>
      </header>

      {state.activeTab === "memo" && (
        <main className="memo-view">
          <div className="memo-header">
            <button className="btn" onClick={() => dispatchWithHistory({ type: "addMemo", folderId: activeFolderId === "__all__" || activeFolderId === "__unfiled__" ? null : activeFolderId })}>
              Add Memo
            </button>
            <div className="undo-redo">
              <button className="btn small" onClick={undo} title="Ctrl+Z">↩ Undo</button>
              <button className="btn small" onClick={redo} title="Ctrl+Y">↪ Redo</button>
            </div>
          </div>
          <div className="memo-body">
            <FolderSidebar
              width={folderSidebarWidth}
              folders={state.folders}
              activeFolderId={activeFolderId}
              onSelect={setActiveFolderId}
              onAdd={() => dispatchWithHistory({ type: "addFolder", parentId: null })}
              onAddChild={(parentId) => dispatchWithHistory({ type: "addFolder", parentId })}
              onRename={(id, name) => dispatchWithHistory({ type: "renameFolder", id, name })}
              onSetColor={(id, color) => dispatchWithHistory({ type: "setFolderColor", id, color })}
              onDelete={(id) => dispatchWithHistory({ type: "deleteFolder", id })}
              onReorder={(dragId, targetId, position) => dispatchWithHistory({ type: "reorderFolder", dragId, targetId, position })}
              onMoveParent={(id, parentId) => dispatchWithHistory({ type: "moveFolderToParent", id, parentId })}
            />
            <ResizeDivider onDrag={(dx) => setFolderSidebarWidth((w) => Math.max(140, Math.min(480, w + dx)))} />
            <div className="memo-content">
              <div className="memo-list">
                {filteredMemos.length === 0 && <div className="muted">メモがありません</div>}
                {filteredMemos.map((memo) => {
                  const folder = state.folders.find((f) => f.id === memo.folderId);
                  return (
                    <div className="memo-card" key={memo.id}>
                      <textarea
                        className="memo-text"
                        value={memo.text}
                        placeholder="Write memo..."
                        onChange={(e) => dispatchWithHistory({ type: "updateMemo", id: memo.id, text: e.target.value })}
                      />
                      <div className="memo-actions">
                        <select
                          className="memo-folder-select"
                          value={memo.folderId ?? ""}
                          onChange={(e) => dispatchWithHistory({ type: "moveMemoToFolder", memoId: memo.id, folderId: e.target.value || null })}
                          title="フォルダを変更"
                        >
                          <option value="">未分類</option>
                          {state.folders.map((f) => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                          ))}
                        </select>
                        {folder && (
                          <span className="memo-folder-badge" style={{ background: folder.color + "33", borderColor: folder.color, color: folder.color }}>
                            {folder.name}
                          </span>
                        )}
                        <button className="btn danger" onClick={() => dispatchWithHistory({ type: "deleteMemo", id: memo.id })}>Delete</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </main>
      )}

      {state.activeTab === "board" && (
        <main className="board-view">
          {/* ── Toolbar Row 1: always visible ── */}
          <div className="board-toolbar">
            <button className="btn" onClick={() => {
              const rect = canvasOuterRef.current?.getBoundingClientRect();
              const w = rect ? rect.width : 800;
              const h = rect ? rect.height : 600;
              const cx = (w / 2 - pan.x) / zoom;
              const cy = (h / 2 - pan.y) / zoom;
              dispatchWithHistory({ type: "addMemoAndCard", x: snap(cx - 80), y: snap(cy - 30) });
            }} title="画面中央に新しいメモを作成">➕ New Memo</button>
            <div className="toolbar-sep" />

            <button className="btn small" onClick={undo} title="Ctrl+Z">↩</button>
            <button className="btn small" onClick={redo} title="Ctrl+Y">↪</button>
            <div className="toolbar-sep" />

            <button className={snapToGrid ? "btn active" : "btn"} onClick={() => setSnapToGrid((v) => !v)} title="グリッドにスナップ・方眼表示">
              Grid {snapToGrid ? "ON" : "OFF"}
            </button>
            <button className="btn" onClick={() => runLayout(() => gridLayout(state.cards))} title="格子状に並べる">⊞ Grid</button>
            <button className="btn" onClick={() => runLayout(() => treeLayout(state.cards, state.edges))} title="有向エッジでレイヤー分け（左→右）">⬇ Tree</button>
            <button className="btn" onClick={() => runLayout(() => radialLayout(state.cards, state.edges))} title="最多接続ノードを中心に放射状配置">◎ Radial</button>
            <div className="toolbar-sep" />

            <input
              className="search-input"
              placeholder="🔍 Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* ── Toolbar Row 2: Select button + selection actions when ON; Tags on right ── */}
          <div className="board-toolbar board-toolbar-row2">
            <button className={state.isSelectionMode ? "btn active" : "btn"} onClick={() => dispatchWithHistory({ type: "toggleSelectionMode" })}>
              Select {state.isSelectionMode ? "ON" : "OFF"}
            </button>
            {state.isSelectionMode && (
              <>
                <div className="toolbar-sep" />
                <button className="btn" disabled={state.selectedCardIds.length < 2} onClick={() => dispatchWithHistory({ type: "linkSelectedCards", linkType: "one-way" })} title="一方向リンク">Link →</button>
                <button className="btn" disabled={state.selectedCardIds.length < 2} onClick={() => dispatchWithHistory({ type: "linkSelectedCards", linkType: "two-way" })} title="双方向リンク">Link ↔</button>
                <button className="btn" disabled={!selectedHasLinks} onClick={() => dispatchWithHistory({ type: "unlinkSelectedCards" })}>Unlink</button>
                <button className="btn" disabled={state.selectedCardIds.length === 0} onClick={() => dispatchWithHistory({ type: "groupSelectedCards" })} title="選択カードをグループ化">Group</button>
                <button className="btn danger" disabled={state.selectedCardIds.length === 0} onClick={() => dispatchWithHistory({ type: "deleteSelectedCards" })}>Delete</button>
              </>
            )}
            {allTags.length > 0 && (
              <div className="toolbar-tags">
                <span className="toolbar-label">Tags:</span>
                {allTags.map((tag) => (
                  <span
                    key={tag}
                    className={`toolbar-tag${activeFilterTag === tag ? " active" : ""}`}
                    draggable
                    onDragStart={(e) => { _activeTagDrag = tag; e.dataTransfer.setData("text/tag", tag); }}
                    onDragEnd={() => { _activeTagDrag = null; }}
                    onClick={() => setActiveFilterTag((prev) => prev === tag ? null : tag)}
                    title="クリック: このタグのカードをハイライト / ドラッグ: カードにタグを付与"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Groups list */}
          {state.groups.length > 0 && (
            <div className="groups-bar">
              {state.groups.map((g) => (
                <div key={g.id} className="group-chip" style={{ borderColor: g.color, background: g.color + "55" }}>
                  <input
                    className="group-chip-name"
                    value={g.name}
                    onChange={(e) => dispatchWithHistory({ type: "updateGroupName", id: g.id, name: e.target.value })}
                  />
                  <button className="tag-remove" onClick={() => dispatchWithHistory({ type: "deleteGroup", id: g.id })}>×</button>
                </div>
              ))}
            </div>
          )}

          <div className="board-columns">
            {boardList}
            <ResizeDivider onDrag={(dx) => setLeftPanelWidth((w) => Math.max(120, Math.min(400, w + dx)))} />
            {boardCanvas}
            {hasDetail && (
              <>
                <ResizeDivider onDrag={(dx) => setRightPanelWidth((w) => Math.max(160, Math.min(520, w - dx)))} />
                {detailPanel}
              </>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
