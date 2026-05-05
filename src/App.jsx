import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ── Constants ──────────────────────────────────────────────────────────────────
const SYMBOLS = [
  { id: "btcusdt", label: "BTC/USDT", tv: "BINANCE:BTCUSDT",  dec: 1, qDec: 4, ticks: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5] },
  { id: "ethusdt", label: "ETH/USDT", tv: "BINANCE:ETHUSDT",  dec: 2, qDec: 3, ticks: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2]    },
  { id: "solusdt", label: "SOL/USDT", tv: "BINANCE:SOLUSDT",  dec: 3, qDec: 2, ticks: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25]  },
  { id: "bnbusdt", label: "BNB/USDT", tv: "BINANCE:BNBUSDT",  dec: 2, qDec: 3, ticks: [0.01, 0.05, 0.1, 0.25, 0.5, 1]       },
  { id: "xrpusdt", label: "XRP/USDT", tv: "BINANCE:XRPUSDT",  dec: 4, qDec: 0, ticks: [0.0001, 0.0005, 0.001, 0.005, 0.01]  },
];

const INITIAL_BALANCE = 150_000;
const GRID_LEVELS     = 150;

const C = {
  bg:     "#080b12",
  bg2:    "#0c1020",
  border: "#182035",
  bid:    "#00e676",
  ask:    "#ff1744",
  bidBar: "rgba(0,230,118,0.13)",
  askBar: "rgba(255,23,68,0.13)",
  text:   "#d0dcea",
  dim:    "#3a5070",
  blue:   "#4da6ff",
  yellow: "#ffd600",
  spread: "#111c30",
};

const fmt = (n, d) => (n == null ? "—" : Number(n).toFixed(d));

function bucketBook(levels, tick) {
  const map = new Map();
  for (const { price, qty } of levels) {
    const key = Math.round(price / tick);
    map.set(key, (map.get(key) ?? 0) + qty);
  }
  return map;
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function DOMSim() {
  const [symIdx, setSymIdx]       = useState(0);
  const [tickIdx, setTickIdx]     = useState(4);
  const sym                       = SYMBOLS[symIdx];
  const [panelW, setPanelW]       = useState({ chart: 33, dom: 300, lotsR: 33, pendingR: 33 });
  const dragRef  = useRef(null);
  const bodyRef  = useRef(null);
  const rightRef = useRef(null);
  const tick                      = sym.ticks[Math.min(tickIdx, sym.ticks.length - 1)];
  const priceDec                  = Math.max(0, Math.ceil(-Math.log10(tick)));

  const [book, setBook]           = useState({ bids: [], asks: [] });
  const [lastPrice, setLastPrice] = useState(null);
  const [priceDir, setPriceDir]   = useState(0);
  const [connected, setConnected] = useState(false);
  const [lastPrices, setLastPrices] = useState({});

  // Account — each lot is a separate entry: { id, symbol, side:"long"|"short", qty, entryPrice }
  const [balance, setBalance]     = useState(INITIAL_BALANCE);
  const [lots, setLots]           = useState([]);
  const [pending, setPending]     = useState([]);
  const [trades, setTrades]       = useState([]);
  const [orderQty, setOrderQty]   = useState("0.001");

  // Stable refs for WS callbacks
  const bookRef      = useRef({ bids: [], asks: [] });
  const pendingRef   = useRef([]);
  const balanceRef   = useRef(INITIAL_BALANCE);
  const lotsRef      = useRef([]);
  const prevPriceRef = useRef(null);

  const domScrollRef   = useRef(null);
  const spreadRowRef   = useRef(null);
  const hasCenteredRef = useRef(false);
  const DOM_ROW_H      = 17;

  const startDrag = useCallback((handle, e) => {
    e.preventDefault();
    dragRef.current = { handle, startX: e.clientX, startVals: { ...panelW } };
  }, [panelW]);

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d || !bodyRef.current) return;
      const dx  = e.clientX - d.startX;
      const totW = bodyRef.current.offsetWidth;
      if (d.handle === "chart") {
        const pct = Math.max(15, Math.min(60, d.startVals.chart + (dx / totW) * 100));
        setPanelW(p => ({ ...p, chart: pct }));
      } else if (d.handle === "dom") {
        const px = Math.max(180, Math.min(500, d.startVals.dom + dx));
        setPanelW(p => ({ ...p, dom: px }));
      } else if (d.handle === "lotsR" || d.handle === "pendingR") {
        if (!rightRef.current) return;
        const rw = rightRef.current.offsetWidth;
        const key = d.handle;
        const pct = Math.max(15, Math.min(70, d.startVals[key] + (dx / rw) * 100));
        setPanelW(p => ({ ...p, [key]: pct }));
      }
    };
    const onUp = () => { dragRef.current = null; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",  onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",  onUp);
    };
  }, []);

  const recenterDOM = useCallback(() => {
    const el = domScrollRef.current;
    if (!el) return;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, []);

  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => { balanceRef.current = balance; }, [balance]);
  useEffect(() => { lotsRef.current    = lots;    }, [lots]);

  // ── P&L calculation (no stale state) ─────────────────────────────────────────
  // For LONG: on close, you get back (fillPrice * qty). Cost was (entryPrice * qty).
  // For SHORT: you borrowed and sold at entryPrice*qty. On cover, you pay fillPrice*qty.
  //   Collateral held = entryPrice*qty. Returned = entryPrice*qty - (fillPrice - entryPrice)*qty
  //                   = (2*entryPrice - fillPrice)*qty ... simpler: profit = (entry-fill)*qty
  //   So return to balance = entryPrice*qty + (entryPrice - fillPrice)*qty = (2*entry-fill)*qty
  //   → to avoid confusion let's just track it as: cost = entryPrice*qty debited on open,
  //     credited back on close = fillPrice*qty + (entryPrice-fillPrice)*qty = entryPrice*qty
  //     plus pnl = (entry-fill)*qty.
  //   Net: balance += fillPrice * qty  for cover  (symmetric to buy/sell)
  //   Wait — let's think simply:
  //     BUY:   balance -= fill * qty              (spend cash)
  //     SELL:  balance += fill * qty              (receive cash)
  //     SHORT: balance -= entry * qty (post collateral = notional)
  //     COVER: balance += entry * qty + (entry - fill) * qty
  //           = balance += (2*entry - fill) * qty  ← this is what we actually credit back
  //   But simpler model: for short, treat it like selling first then buying:
  //     SHORT open:  balance += fill * qty        (received from "selling")
  //                  but we need to track we owe qty back → store as short lot
  //     COVER close: balance -= fill * qty        (pay to buy back)
  //   This is the most natural PnL model. Let's use this:
  //     LONG  open:  balance -= fill * qty
  //     LONG  close: balance += fill * qty
  //     SHORT open:  balance += fill * qty   (credited short proceeds)
  //     SHORT close: balance -= fill * qty   (debit to buy back)
  //   Unrealized PnL for display:
  //     LONG:  (currentPrice - entryPrice) * qty
  //     SHORT: (entryPrice - currentPrice) * qty

  const executeFill = useCallback((symbol, side, qty, fillPrice) => {
    // 1) Update balance atomically (no stale closure)
    setBalance(prev => {
      if (side === "buy" || side === "cover") return prev - fillPrice * qty;
      else                                    return prev + fillPrice * qty;
      // side === "sell" (close long) or "short" (open short)
    });

    // 2) Update lots
    if (side === "buy") {
      // Open a new long lot
      setLots(prev => [...prev, {
        id: Date.now() + Math.random(),
        symbol, side: "long", qty, entryPrice: fillPrice,
      }]);
    } else if (side === "sell") {
      // Close the oldest long lot(s) FIFO
      setLots(prev => {
        const toLiquidate = qty;
        let remaining = toLiquidate;
        const next = [];
        for (const lot of prev) {
          if (lot.symbol !== symbol || lot.side !== "long" || remaining <= 0) {
            next.push(lot);
            continue;
          }
          if (lot.qty <= remaining + 1e-8) {
            remaining -= lot.qty; // consume entire lot
          } else {
            next.push({ ...lot, qty: parseFloat((lot.qty - remaining).toFixed(8)) });
            remaining = 0;
          }
        }
        return next;
      });
    } else if (side === "short") {
      // Open a new short lot
      setLots(prev => [...prev, {
        id: Date.now() + Math.random(),
        symbol, side: "short", qty, entryPrice: fillPrice,
      }]);
    } else if (side === "cover") {
      // Close the oldest short lot(s) FIFO
      setLots(prev => {
        let remaining = qty;
        const next = [];
        for (const lot of prev) {
          if (lot.symbol !== symbol || lot.side !== "short" || remaining <= 0) {
            next.push(lot);
            continue;
          }
          if (lot.qty <= remaining + 1e-8) {
            remaining -= lot.qty;
          } else {
            next.push({ ...lot, qty: parseFloat((lot.qty - remaining).toFixed(8)) });
            remaining = 0;
          }
        }
        return next;
      });
    }

    // 3) Record trade
    setTrades(prev => [{
      id: Date.now() + Math.random(), symbol, side, qty,
      price: fillPrice,
      time: new Date().toLocaleTimeString("en", { hour12: false }),
    }, ...prev.slice(0, 49)]);
  }, []);

  // ── Check limit fills on each tick ───────────────────────────────────────────
  const checkLimits = useCallback((bestBid, bestAsk) => {
    const toFill = pendingRef.current.filter(o =>
      ((o.side === "buy"   || o.side === "cover") && bestAsk <= o.price) ||
      ((o.side === "sell"  || o.side === "short") && bestBid >= o.price)
    );
    if (!toFill.length) return;
    toFill.forEach(o => executeFill(o.symbol, o.side, o.qty, o.price));
    const ids = new Set(toFill.map(o => o.id));
    setPending(prev => prev.filter(o => !ids.has(o.id)));
  }, [executeFill]);

  // ── WebSocket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    hasCenteredRef.current = false;
    setBook({ bids: [], asks: [] });
    setLastPrice(null);
    setConnected(false);
    prevPriceRef.current = null;

    const url = `wss://stream.binance.com:9443/stream?streams=${sym.id}@depth20@100ms/${sym.id}@miniTicker`;
    const ws  = new WebSocket(url);

    ws.onopen    = () => setConnected(true);
    ws.onclose   = () => setConnected(false);
    ws.onerror   = () => setConnected(false);
    ws.onmessage = (evt) => {
      const { stream, data } = JSON.parse(evt.data);
      if (stream.includes("miniTicker")) {
        const p = parseFloat(data.c);
        setPriceDir(prevPriceRef.current == null ? 0 : p > prevPriceRef.current ? 1 : p < prevPriceRef.current ? -1 : 0);
        prevPriceRef.current = p;
        setLastPrice(p);
        setLastPrices(prev => ({ ...prev, [sym.id]: p }));
      }
      if (stream.includes("depth")) {
        const bids = data.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
        const asks = data.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
        setBook({ bids, asks });
        bookRef.current = { bids, asks };
        if (bids[0] && asks[0]) checkLimits(bids[0].price, asks[0].price);
      }
    };
    return () => ws.close();
  }, [sym.id, checkLimits]);

  // Center DOM on first data
  useEffect(() => {
    if (hasCenteredRef.current || !lastPrice) return;
    hasCenteredRef.current = true;
    recenterDOM();
  }, [lastPrice, recenterDOM]);
  const domGrid = useMemo(() => {
    if (!lastPrice) return [];
    const midKey     = Math.round(lastPrice / tick);
    const bidMap     = bucketBook(book.bids, tick);
    const askMap     = bucketBook(book.asks, tick);
    const bestBidKey = book.bids[0] ? Math.round(book.bids[0].price / tick) : null;
    const bestAskKey = book.asks[0] ? Math.round(book.asks[0].price / tick) : null;

    return Array.from({ length: GRID_LEVELS * 2 + 1 }, (_, idx) => {
      const i     = GRID_LEVELS - idx;
      const key   = midKey + i;
      const price = parseFloat((key * tick).toFixed(10));
      return {
        key, price,
        bidQty:     bidMap.get(key) ?? 0,
        askQty:     askMap.get(key) ?? 0,
        isBestBid:  key === bestBidKey,
        isBestAsk:  key === bestAskKey,
        isInSpread: bestBidKey != null && bestAskKey != null && key < bestAskKey && key > bestBidKey,
      };
    });
  }, [book, lastPrice, sym, tick]);

  const maxQty = useMemo(() =>
    Math.max(...domGrid.map(r => Math.max(r.bidQty, r.askQty)), 1),
  [domGrid]);

  // ── Place order from DOM click ────────────────────────────────────────────────
  // Rules:
  //   - Orders always execute at best bid (sell/short) or best ask (buy/cover)
  //   - Click on a price that already has a pending order at that side → CANCEL
  //   - Sell = close long, Short = open short (if no long), Cover = close short
  //   - Cannot create money: sell requires long qty, cover requires short qty
  const placeFromDOM = useCallback((rowPrice, clickSide) => {
    const qty       = parseFloat(orderQty);
    if (!qty || qty <= 0) { alert("Set a valid qty first"); return; }

    const { bids, asks } = bookRef.current;
    const bestBid        = bids[0]?.price;
    const bestAsk        = asks[0]?.price;
    if (!bestBid || !bestAsk) return;

    const symLots  = lotsRef.current.filter(l => l.symbol === sym.id);
    const longLots = symLots.filter(l => l.side === "long");
    const shortLots= symLots.filter(l => l.side === "short");
    const totalLong = longLots.reduce((s, l) => s + l.qty, 0);
    const totalShort= shortLots.reduce((s, l) => s + l.qty, 0);

    // Determine actual side
    const side = clickSide === "sell"
      ? (totalLong > 0 ? "sell" : "short")
      : (totalShort > 0 ? "cover" : "buy");

    // Check if there's already a pending order at this row price on the same side — if so, cancel it
    const isSellSide = clickSide === "sell";
    const existing = pendingRef.current.find(o =>
      o.symbol === sym.id &&
      (isSellSide ? (o.side === "sell" || o.side === "short") : (o.side === "buy" || o.side === "cover")) &&
      Math.abs(o.price - rowPrice) < tick * 0.5
    );
    if (existing) {
      setPending(prev => prev.filter(o => o.id !== existing.id));
      return;
    }

    // Validate
    if (side === "sell"  && totalLong  < qty - 1e-8) { alert(`You only have ${fmt(totalLong, sym.qDec)} long to sell`);   return; }
    if (side === "cover" && totalShort < qty - 1e-8) { alert(`You only have ${fmt(totalShort, sym.qDec)} short to cover`); return; }
    if ((side === "buy" || side === "short") && qty * bestAsk > balanceRef.current) { alert("Insufficient balance"); return; }

    // Determine if marketable (execute immediately) or post as limit
    // "In the middle price" = only limit orders away from best bid/ask
    const fillPrice =
      (side === "buy"   || side === "cover") ? bestAsk :
      (side === "sell"  || side === "short") ? bestBid : null;

    const isMarketable =
      (side === "buy"   || side === "cover") && rowPrice >= bestAsk ||
      (side === "sell"  || side === "short") && rowPrice <= bestBid;

    if (isMarketable) {
      // Market fill at best bid/ask — not at rowPrice, to avoid buying high/selling low exploit
      executeFill(sym.id, side, qty, fillPrice);
    } else {
      // Limit order posted at rowPrice
      setPending(prev => [...prev, {
        id: Date.now() + Math.random(),
        symbol: sym.id, side, qty,
        price: rowPrice,
        time: new Date().toLocaleTimeString("en", { hour12: false }),
      }]);
    }
  }, [orderQty, sym, executeFill]);

  const cancelOrder   = (id) => setPending(prev => prev.filter(o => o.id !== id));

  const closeLot = useCallback((lot) => {
    const { bids, asks } = bookRef.current;
    if (lot.side === "long") {
      const fp = bids[0]?.price; if (!fp) return;
      executeFill(lot.symbol, "sell", lot.qty, fp);
    } else {
      const fp = asks[0]?.price; if (!fp) return;
      executeFill(lot.symbol, "cover", lot.qty, fp);
    }
  }, [executeFill]);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const activePending = pending.filter(o => o.symbol === sym.id);

  const unrealizedPnl = useMemo(() => {
    return lots.reduce((acc, lot) => {
      const price = lastPrices[lot.symbol];
      if (price == null) return acc;
      const pnl = lot.side === "long"
        ? (price - lot.entryPrice) * lot.qty
        : (lot.entryPrice - price) * lot.qty;
      return acc + pnl;
    }, 0);
  }, [lastPrices, lots]);

  const equity = balance + unrealizedPnl;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: '"JetBrains Mono","Cascadia Code","Fira Code",monospace', background: C.bg, color: C.text, height: "100vh", display: "flex", flexDirection: "column", fontSize: 11, overflow: "hidden" }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 12px", background: C.bg2, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <span style={{ color: C.blue, fontWeight: 700, fontSize: 12, letterSpacing: 2 }}>◈ DOM SIM</span>
        <div style={{ display: "flex", gap: 3 }}>
          {SYMBOLS.map((s, i) => (
            <button key={s.id} onClick={() => setSymIdx(i)} style={{
              background: i === symIdx ? "#0f1e3a" : "transparent",
              color: i === symIdx ? C.blue : C.dim,
              border: `1px solid ${i === symIdx ? "#1e4080" : C.border}`,
              borderRadius: 3, padding: "2px 8px", cursor: "pointer", fontSize: 10, fontFamily: "inherit",
            }}>{s.label}</button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: priceDir > 0 ? C.bid : priceDir < 0 ? C.ask : C.text, transition: "color 0.15s" }}>
            {lastPrice ? fmt(lastPrice, priceDec) : "—"}
          </span>
          <span style={{ fontSize: 9, color: connected ? C.bid : C.ask, letterSpacing: 1 }}>
            {connected ? "● LIVE" : "● OFFLINE"}
          </span>
        </div>
      </div>

      {/* ── Body ── */}
      <div ref={bodyRef} style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* Chart */}
        <div style={{ flex: `0 0 ${panelW.chart}%`, minWidth: 0, overflow: "hidden" }}>
          <iframe
            key={sym.tv}
            src={`https://www.tradingview.com/widgetembed/?symbol=${sym.tv}&interval=1&theme=dark&style=1&locale=en&toolbar_bg=0c1020&hide_side_toolbar=0&allow_symbol_change=0&save_image=0`}
            style={{ width: "100%", height: "100%", border: "none", display: "block" }}
            title="chart"
          />
        </div>

        <div
          onMouseDown={(e) => startDrag("chart", e)}
          style={{ width: 5, flexShrink: 0, cursor: "col-resize", background: "transparent", borderLeft: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, transition: "background 0.15s", zIndex: 10 }}
        />
        {/* DOM */}
        <div style={{ flex: `0 0 ${panelW.dom}px`, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Column headers */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 105px 1fr", padding: "3px 4px", background: C.bg2, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            <span style={{ textAlign: "right", color: C.bid, fontSize: 9 }}>BID / SELL</span>
            <span style={{ textAlign: "center", color: C.dim, fontSize: 9 }}>PRICE</span>
            <span style={{ textAlign: "left",  color: C.ask, fontSize: 9 }}>ASK / BUY</span>
          </div>

          {/* DOM rows — freely scrollable */}
          <div ref={domScrollRef} style={{ flex: 1, overflowY: "scroll", overflowX: "hidden" }}>
            {domGrid.map((row) => {
              const bidPct  = (row.bidQty / maxQty) * 100;
              const askPct  = (row.askQty / maxQty) * 100;
              const myBuys  = activePending.filter(o =>
                (o.side === "buy" || o.side === "cover") &&
                Math.abs(o.price - row.price) < tick * 0.5
              );
              const mySells = activePending.filter(o =>
                (o.side === "sell" || o.side === "short") &&
                Math.abs(o.price - row.price) < tick * 0.5
              );

              const rowBg =
                row.isBestBid  ? "rgba(0,230,118,0.09)" :
                row.isBestAsk  ? "rgba(255,23,68,0.09)"  :
                row.isInSpread ? C.spread                 :
                "transparent";

              return (
                <div
                  key={row.key}
                  ref={row.isInSpread ? spreadRowRef : null}
                  style={{ display: "grid", gridTemplateColumns: "1fr 105px 1fr", position: "relative", background: rowBg, borderBottom: "1px solid rgba(24,32,53,0.5)", minHeight: 17 }}
                >
                  {/* Bid bar */}
                  {row.bidQty > 0 && <div style={{ position: "absolute", right: "35%", top: 0, bottom: 0, width: `${bidPct * 0.3}%`, background: C.bidBar }} />}
                  {/* Ask bar */}
                  {row.askQty > 0 && <div style={{ position: "absolute", left:  "35%", top: 0, bottom: 0, width: `${askPct * 0.3}%`, background: C.askBar }} />}

                  {/* Left: SELL / SHORT */}
                  <div
                    onClick={() => placeFromDOM(row.price, "sell")}
                    title={mySells.length ? "Click to CANCEL pending sell/short" : "Click to SELL / SHORT"}
                    style={{
                      textAlign: "right", padding: "1px 6px", cursor: "pointer",
                      color: mySells.length ? C.yellow : row.bidQty ? C.bid : C.dim,
                      fontWeight: row.isBestBid || mySells.length ? 700 : 400,
                      position: "relative", zIndex: 1, fontSize: 10,
                      display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 3,
                      background: mySells.length ? "rgba(255,214,0,0.06)" : "transparent",
                    }}
                  >
                    {mySells.length > 0 && <span style={{ fontSize: 8 }}>▼</span>}
                    <span>{row.bidQty > 0 ? fmt(row.bidQty, sym.qDec) : mySells.length ? "—" : ""}</span>
                  </div>

                  {/* Center: Price */}
                  <div style={{
                    textAlign: "center", padding: "1px 2px", position: "relative", zIndex: 1, fontSize: 10,
                    color:
                      row.isBestBid  ? C.bid  :
                      row.isBestAsk  ? C.ask  :
                      row.isInSpread ? C.blue :
                      C.text,
                    fontWeight: (row.isBestBid || row.isBestAsk) ? 700 : 400,
                  }}>
                    {fmt(row.price, priceDec)}
                  </div>

                  {/* Right: BUY / COVER */}
                  <div
                    onClick={() => placeFromDOM(row.price, "buy")}
                    title={myBuys.length ? "Click to CANCEL pending buy/cover" : "Click to BUY / COVER"}
                    style={{
                      textAlign: "left", padding: "1px 6px", cursor: "pointer",
                      color: myBuys.length ? C.yellow : row.askQty ? C.ask : C.dim,
                      fontWeight: row.isBestAsk || myBuys.length ? 700 : 400,
                      position: "relative", zIndex: 1, fontSize: 10,
                      display: "flex", alignItems: "center", gap: 3,
                      background: myBuys.length ? "rgba(255,214,0,0.06)" : "transparent",
                    }}
                  >
                    <span>{row.askQty > 0 ? fmt(row.askQty, sym.qDec) : myBuys.length ? "—" : ""}</span>
                    {myBuys.length > 0 && <span style={{ fontSize: 8 }}>▲</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Qty input + recenter */}
          <div style={{ padding: "6px 8px", background: C.bg2, borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.dim, fontSize: 9, marginBottom: 3 }}>QTY ({sym.label.split("/")[0]})</div>
                <input
                  value={orderQty}
                  onChange={e => setOrderQty(e.target.value)}
                  style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 3, color: C.text, padding: "4px 6px", fontSize: 11, fontFamily: "inherit", boxSizing: "border-box", outline: "none" }}
                />
              </div>
              <button
                onClick={recenterDOM}
                title="Re-center on spread"
                style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 3, color: C.dim, padding: "5px 9px", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}
              >⊙</button>
            </div>
            <div style={{ color: C.dim, fontSize: 8, marginTop: 4, textAlign: "center" }}>
              ← SELL/SHORT &nbsp;·&nbsp; re-click pending = cancel &nbsp;·&nbsp; BUY/COVER →
            </div>
            {/* Tick selector */}
            <div style={{ marginTop: 6 }}>
              <div style={{ color: C.dim, fontSize: 9, marginBottom: 3 }}>GROUPING</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {sym.ticks.map((t, i) => (
                  <button key={t} onClick={() => setTickIdx(i)} style={{
                    background: i === Math.min(tickIdx, sym.ticks.length - 1) ? "#0f1e3a" : "transparent",
                    color:      i === Math.min(tickIdx, sym.ticks.length - 1) ? C.blue : C.dim,
                    border: `1px solid ${i === Math.min(tickIdx, sym.ticks.length - 1) ? "#1e4080" : C.border}`,
                    borderRadius: 3, padding: "2px 6px", cursor: "pointer",
                    fontSize: 9, fontFamily: "inherit",
                  }}>{t}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div
          onMouseDown={(e) => startDrag("dom", e)}
          style={{ width: 5, flexShrink: 0, cursor: "col-resize", background: "transparent", borderLeft: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, transition: "background 0.15s", zIndex: 10 }}
        />
        {/* Right panel */}
        <div ref={rightRef} style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

          {/* Account summary */}
          <div style={{ padding: "8px 12px", borderBottom: `1px solid ${C.border}`, background: C.bg2, flexShrink: 0, display: "flex", gap: 24, alignItems: "center" }}>
            {[
              { label: "BALANCE",    val: `${fmt(balance, 2)} USDT`,                                           color: C.text },
              { label: "UNREAL P&L", val: `${unrealizedPnl >= 0 ? "+" : ""}${fmt(unrealizedPnl, 2)} USDT`,  color: unrealizedPnl >= 0 ? C.bid : C.ask },
              { label: "EQUITY",     val: `${fmt(equity, 2)} USDT`,                                           color: C.blue },
            ].map(({ label, val, color }) => (
              <div key={label}>
                <div style={{ color: C.dim, fontSize: 9, marginBottom: 2 }}>{label}</div>
                <div style={{ color, fontWeight: 700, fontSize: 12 }}>{val}</div>
              </div>
            ))}
            <button
              onClick={() => { setBalance(INITIAL_BALANCE); setLots([]); setPending([]); setTrades([]); }}
              style={{ marginLeft: "auto", background: "transparent", color: C.dim, border: `1px solid ${C.border}`, borderRadius: 3, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit", fontSize: 9 }}
            >RESET ACCOUNT</button>
          </div>

          {/* Three column layout for the panels */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

            {/* Lots */}
            <div style={{ flex: `0 0 ${panelW.lotsR}%`, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <Sec label="OPEN LOTS" />
              <div style={{ flex: 1, overflowY: "auto" }}>
                {lots.length === 0 ? <Emp>No open lots</Emp> : lots.map(lot => {
                  const s   = SYMBOLS.find(s => s.id === lot.symbol) ?? sym;
                  const lotPrice = lastPrices[lot.symbol];
                  const pnl = lotPrice != null
                    ? (lot.side === "long" ? lotPrice - lot.entryPrice : lot.entryPrice - lotPrice) * lot.qty
                    : null;
                  return (
                    <div key={lot.id} style={{ padding: "5px 10px", borderBottom: `1px solid ${C.border}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                        <span style={{ color: lot.side === "long" ? C.bid : C.ask, fontWeight: 700, fontSize: 10 }}>
                          {lot.side.toUpperCase()}
                        </span>
                        <span style={{ color: C.blue, fontSize: 9 }}>{s.label}</span>
                      </div>
                      <div style={{ color: C.dim, fontSize: 9, marginBottom: 3 }}>
                        {fmt(lot.qty, s.qDec)} @ {fmt(lot.entryPrice, s.dec)}
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        {pnl != null
                          ? <span style={{ color: pnl >= 0 ? C.bid : C.ask, fontWeight: 700, fontSize: 10 }}>{pnl >= 0 ? "+" : ""}{fmt(pnl, 2)} USDT</span>
                          : <span style={{ color: C.dim, fontSize: 9 }}>—</span>
                        }
                        <button onClick={() => closeLot(lot)} style={{ background: "#1a0407", color: C.ask, border: "1px solid #6b1a1a", borderRadius: 3, padding: "2px 6px", cursor: "pointer", fontSize: 9, fontFamily: "inherit" }}>CLOSE</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div
              onMouseDown={(e) => startDrag("lotsR", e)}
              style={{ width: 5, flexShrink: 0, cursor: "col-resize", background: "transparent", borderLeft: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, transition: "background 0.15s", zIndex: 10 }}
            />
            {/* Pending orders */}
            <div style={{ flex: `0 0 ${panelW.pendingR}%`, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <Sec label="PENDING ORDERS" />
              <div style={{ flex: 1, overflowY: "auto" }}>
                {activePending.length === 0 ? <Emp>No pending orders</Emp> : activePending.map(o => (
                  <div key={o.id} style={{ padding: "5px 10px", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ color: (o.side === "buy" || o.side === "cover") ? C.bid : C.ask, fontWeight: 700, fontSize: 10 }}>
                        {o.side.toUpperCase()}
                      </span>
                      <button onClick={() => cancelOrder(o.id)} style={{ background: "transparent", color: C.dim, border: `1px solid ${C.border}`, borderRadius: 3, padding: "1px 5px", cursor: "pointer", fontFamily: "inherit", fontSize: 9 }}>✕</button>
                    </div>
                    <div style={{ color: C.dim, fontSize: 9, marginBottom: 2 }}>
                      {fmt(o.qty, sym.qDec)} @ {fmt(o.price, sym.dec)}
                    </div>
                    <div style={{ color: C.dim, fontSize: 8 }}>{o.time}</div>
                  </div>
                ))}
              </div>
            </div>

            <div
              onMouseDown={(e) => startDrag("pendingR", e)}
              style={{ width: 5, flexShrink: 0, cursor: "col-resize", background: "transparent", borderLeft: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, transition: "background 0.15s", zIndex: 10 }}
            />
            {/* Trade history */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <Sec label="TRADE HISTORY" />
              <div style={{ flex: 1, overflowY: "auto" }}>
                {trades.length === 0 ? <Emp>No trades yet</Emp> : trades.map(t => {
                  const s = SYMBOLS.find(s => s.id === t.symbol) ?? sym;
                  return (
                    <div key={t.id} style={{ padding: "4px 10px", borderBottom: `1px solid ${C.border}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                        <span style={{ color: (t.side === "buy" || t.side === "cover") ? C.bid : C.ask, fontWeight: 700, fontSize: 10 }}>
                          {t.side.toUpperCase()}
                        </span>
                        <span style={{ color: C.dim, fontSize: 8 }}>{t.time}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: C.dim, fontSize: 9 }}>{fmt(t.qty, s.qDec)} @ {fmt(t.price, s.dec)}</span>
                        <span style={{ color: C.dim, fontSize: 9 }}>{fmt(t.qty * t.price, 2)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

const Sec = ({ label }) => (
  <div style={{ padding: "4px 10px", color: C.dim, fontSize: 9, textTransform: "uppercase", letterSpacing: 2, borderBottom: `1px solid ${C.border}`, background: C.bg2, flexShrink: 0 }}>
    {label}
  </div>
);
const Emp = ({ children }) => (
  <div style={{ padding: "8px 10px", color: C.dim, fontSize: 10, opacity: 0.5 }}>{children}</div>
);
