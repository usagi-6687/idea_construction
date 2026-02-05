import { useEffect, useMemo, useReducer, useRef, useState } from "react";

type Memo = { id: string; text: string; createdAt: number; updatedAt: number };
type CardInstance = {
  id: string;
  memoId: string;
  x: number;
  y: number;
  createdAt: number;
  links: string[];
  note: string;
  tags: string[];
};

type TabKey = "memo" | "board";

type State = {
  memos: Memo[];
  cards: CardInstance[];
  activeTab: TabKey;
  isSelectionMode: boolean;
  selectedCardIds: string[];
  hydrated: boolean; // without this all vanished when reloaded
};

type Action =
  | { type: "addMemo" }
  | { type: "updateMemo"; id: string; text: string }
  | { type: "deleteMemo"; id: string }
  | { type: "addCard"; memoId: string; x: number; y: number }
  | { type: "moveCard"; id: string; x: number; y: number }
  | { type: "updateCardNote"; id: string; note: string }
  | { type: "addCardTags"; id: string; tags: string[] }
  | { type: "removeCardTag"; id: string; tag: string }
  | { type: "toggleSelectionMode" }
  | { type: "toggleCardSelection"; id: string }
  | { type: "deleteSelectedCards" }
  | { type: "linkSelectedCards" }
  | { type: "clearSelection" }
  | { type: "setTab"; tab: TabKey }
  | { type: "hydrate"; state: State };

const STORAGE_KEY = "brainstorming-v0";

const initialState: State = {
  memos: [],
  cards: [],
  activeTab: "memo",
  isSelectionMode: false,
  selectedCardIds: [],
  hydrated: false
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "addMemo": {
      const now = Date.now();
      const memo: Memo = {
        id: crypto.randomUUID(),
        text: "",
        createdAt: now,
        updatedAt: now
      };
      return { ...state, memos: [memo, ...state.memos] };
    }
    case "updateMemo": {
      const now = Date.now();
      return {
        ...state,
        memos: state.memos.map((m) =>
          m.id === action.id ? { ...m, text: action.text, updatedAt: now } : m
        )
      };
    }
    case "deleteMemo": {
      return {
        ...state,
        memos: state.memos.filter((m) => m.id !== action.id),
        cards: state.cards.filter((c) => c.memoId !== action.id)
      };
    }
    case "addCard": {
      const card: CardInstance = {
        id: crypto.randomUUID(),
        memoId: action.memoId,
        x: action.x,
        y: action.y,
        createdAt: Date.now(),
        links: [],
        note: "",
        tags: []
      };
      return { ...state, cards: [...state.cards, card] };
    }
    case "moveCard": {
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.id ? { ...c, x: action.x, y: action.y } : c
        )
      };
    }
    case "updateCardNote": {
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.id ? { ...c, note: action.note } : c
        )
      };
    }
    case "addCardTags": {
      if (action.tags.length === 0) return state;
      return {
        ...state,
        cards: state.cards.map((c) => {
          if (c.id !== action.id) return c;
          const next = new Set(c.tags);
          for (const tag of action.tags) next.add(tag);
          return { ...c, tags: Array.from(next) };
        })
      };
    }
    case "removeCardTag": {
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.id ? { ...c, tags: c.tags.filter((t) => t !== action.tag) } : c
        )
      };
    }
    case "toggleSelectionMode": {
      const next = !state.isSelectionMode;
      return {
        ...state,
        isSelectionMode: next,
        selectedCardIds: next ? state.selectedCardIds : []
      };
    }
    case "toggleCardSelection": {
      if (!state.isSelectionMode) return state;
      const isSelected = state.selectedCardIds.includes(action.id);
      return {
        ...state,
        selectedCardIds: isSelected
          ? state.selectedCardIds.filter((id) => id !== action.id)
          : [...state.selectedCardIds, action.id]
      };
    }
    case "deleteSelectedCards": {
      if (!state.isSelectionMode || state.selectedCardIds.length === 0) return state;
      const removeSet = new Set(state.selectedCardIds);
      const filtered = state.cards.filter((c) => !removeSet.has(c.id));
      const cleaned = filtered.map((c) => ({
        ...c,
        links: c.links.filter((id) => !removeSet.has(id))
      }));
      return { ...state, cards: cleaned, selectedCardIds: [] };
    }
    case "linkSelectedCards": {
      if (!state.isSelectionMode || state.selectedCardIds.length < 2) return state;
      const selectedSet = new Set(state.selectedCardIds);
      const updated = state.cards.map((card) => {
        if (!selectedSet.has(card.id)) return card;
        const nextLinks = new Set(card.links);
        for (const otherId of state.selectedCardIds) {
          if (otherId !== card.id) nextLinks.add(otherId);
        }
        return { ...card, links: Array.from(nextLinks) };
      });
      return { ...state, cards: updated };
    }
    case "clearSelection":
      return { ...state, selectedCardIds: [] };
    case "setTab":
      return { ...state, activeTab: action.tab };
    case "hydrate":
      return {
        ...initialState,
        ...action.state,
        hydrated: true,
        isSelectionMode: false,
        selectedCardIds: [],
        cards: action.state.cards.map((c) => ({
          ...c,
          links: c.links ?? [],
          note: c.note ?? "",
          tags: c.tags ?? []
        }))
      };
    default:
      return state;
  }
}

type CardProps = {
  card: CardInstance;
  text: string;
  canvasRef: React.RefObject<HTMLDivElement>;
  onMove: (id: string, x: number, y: number) => void;
  isSelectionMode: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
};

function Card({ card, text, canvasRef, onMove, isSelectionMode, isSelected, onToggleSelect }: CardProps) {
  const draggingRef = useRef(false);
  const offsetRef = useRef({ x: 0, y: 0 });
  const pointerIdRef = useRef<number | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (isSelectionMode) {
      onToggleSelect(card.id);
      e.preventDefault();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;

    draggingRef.current = true;
    pointerIdRef.current = e.pointerId;
    offsetRef.current = { x: localX - card.x, y: localY - card.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;

    const nextX = localX - offsetRef.current.x;
    const nextY = localY - offsetRef.current.y;
    onMove(card.id, nextX, nextY);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    draggingRef.current = false;
    pointerIdRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  return (
    <div
      className={isSelected ? "card selected" : "card"}
      style={{ left: card.x, top: card.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {text || "(empty)"}
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [tagInput, setTagInput] = useState("");
  const hasHydrated = useRef(false);

  useEffect(() => {
const raw = localStorage.getItem(STORAGE_KEY);
if (!raw) return;
try {
const parsed = JSON.parse(raw) as State;
if (parsed && Array.isArray(parsed.memos) && Array.isArray(parsed.cards)) {
dispatch({ type: "hydrate", state: parsed });
}
} catch {}
}, []);

  useEffect(() => {
    if (!state.hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const memosById = useMemo(() => {
    const map = new Map<string, Memo>();
    for (const memo of state.memos) map.set(memo.id, memo);
    return map;
  }, [state.memos]);

  const selectedCardId = state.selectedCardIds.length === 1 ? state.selectedCardIds[0] : null;
  const selectedCard = selectedCardId
    ? state.cards.find((card) => card.id === selectedCardId) ?? null
    : null;

  useEffect(() => {
    setTagInput("");
  }, [selectedCardId]);

  function normalizeTags(input: string) {
    return input
      .split(",")
      .map((tag) => tag.trim())
      .map((tag) => tag.replace(/^#+/, ""))
      .filter(Boolean);
  }

  function commitTags() {
    if (!selectedCard) return;
    const tags = normalizeTags(tagInput);
    if (tags.length === 0) return;
    dispatch({ type: "addCardTags", id: selectedCard.id, tags });
    setTagInput("");
  }

  const boardList = (
    <div className="board-left">
      <div className="panel-title">Memos</div>
      {state.memos.length === 0 && <div className="muted">No memos yet</div>}
      {state.memos.map((memo) => {
        const count = state.cards.filter((c) => c.memoId === memo.id).length;
        const base = 24 + count * 12;
        return (
          <div className="board-memo" key={memo.id}>
            <div className="board-memo-text">{memo.text || "(empty)"}</div>
            <button
              className="btn small"
              onClick={() =>
                dispatch({ type: "addCard", memoId: memo.id, x: base, y: base })
              }
            >
              Place
            </button>
          </div>
        );
      })}
    </div>
  );

  const boardCanvas = (
    <div className="board-right">
      <div className="panel-title">Canvas</div>
      <div ref={canvasRef} className="canvas">
        <svg className="links-layer">
          {state.cards.map((card) => {
            if (card.links.length === 0) return null;
            return card.links.map((targetId) => {
              if (card.id >= targetId) return null;
              const target = state.cards.find((c) => c.id === targetId);
              if (!target) return null;
              const x1 = card.x + 80;
              const y1 = card.y + 30;
              const x2 = target.x + 80;
              const y2 = target.y + 30;
              return (
                <line
                  key={`${card.id}-${targetId}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="#2b2b2b"
                  strokeWidth={2}
                  strokeOpacity={0.5}
                />
              );
            });
          })}
        </svg>
        {state.cards.map((card) => {
          const memo = memosById.get(card.memoId);
          if (!memo) return null;
          return (
            <Card
              key={card.id}
              card={card}
              text={memo.text}
              canvasRef={canvasRef}
              onMove={(id, x, y) => dispatch({ type: "moveCard", id, x, y })}
              isSelectionMode={state.isSelectionMode}
              isSelected={state.selectedCardIds.includes(card.id)}
              onToggleSelect={(id) => dispatch({ type: "toggleCardSelection", id })}
            />
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">Brainstorming MVP</div>
        <div className="tabs">
          <button
            className={state.activeTab === "memo" ? "tab active" : "tab"}
            onClick={() => dispatch({ type: "setTab", tab: "memo" })}
          >
            Memo
          </button>
          <button
            className={state.activeTab === "board" ? "tab active" : "tab"}
            onClick={() => dispatch({ type: "setTab", tab: "board" })}
          >
            Board
          </button>
        </div>
      </header>

      {state.activeTab === "memo" && (
        <main className="memo-view">
          <div className="memo-header">
            <button className="btn" onClick={() => dispatch({ type: "addMemo" })}>
              Add Memo
            </button>
          </div>
          <div className="memo-list">
            {state.memos.length === 0 && (
              <div className="muted">No memos yet</div>
            )}
            {state.memos.map((memo) => (
              <div className="memo-card" key={memo.id}>
                <textarea
                  className="memo-text"
                  value={memo.text}
                  placeholder="Write memo..."
                  onChange={(e) =>
                    dispatch({ type: "updateMemo", id: memo.id, text: e.target.value })
                  }
                />
                <div className="memo-actions">
                  <button
                    className="btn danger"
                    onClick={() => dispatch({ type: "deleteMemo", id: memo.id })}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </main>
      )}

      {state.activeTab === "board" && (
        <main className="board-view">
          <div className="board-toolbar">
            <button
              className={state.isSelectionMode ? "btn active" : "btn"}
              onClick={() => dispatch({ type: "toggleSelectionMode" })}
            >
              Selection {state.isSelectionMode ? "ON" : "OFF"}
            </button>
            {state.isSelectionMode && (
              <>
                <button
                  className="btn"
                  disabled={state.selectedCardIds.length < 2}
                  onClick={() => dispatch({ type: "linkSelectedCards" })}
                >
                  Link
                </button>
                <button
                  className="btn danger"
                  disabled={state.selectedCardIds.length === 0}
                  onClick={() => dispatch({ type: "deleteSelectedCards" })}
                >
                  Delete
                </button>
              </>
            )}
          </div>
          <div className={selectedCard ? "board-columns has-detail" : "board-columns"}>
            {boardList}
            {boardCanvas}
            {selectedCard && (
              <div className="detail-panel">
                <div className="panel-title">Card Detail</div>
                <div className="detail-label">Note</div>
                <textarea
                  className="detail-textarea"
                  value={selectedCard.note}
                  placeholder="Write a note..."
                  onChange={(e) =>
                    dispatch({ type: "updateCardNote", id: selectedCard.id, note: e.target.value })
                  }
                />
                <div className="detail-label">Tags</div>
                <input
                  className="detail-input"
                  value={tagInput}
                  placeholder="Add tag and press Enter or comma"
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      commitTags();
                    }
                  }}
                />
                <div className="tag-list">
                  {selectedCard.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      #{tag}
                      <button
                        type="button"
                        className="tag-remove"
                        onClick={() =>
                          dispatch({ type: "removeCardTag", id: selectedCard.id, tag })
                        }
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </main>
      )}
    </div>
  );
}

