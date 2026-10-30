import { useCallback, useEffect, useState } from "react";
import { useRider } from "../contexts/RiderContext.jsx";
import { useBackHandler } from "../hooks/useBackHandler.js";
import { Button, Card, ErrorNote, Money } from "./ui.jsx";
import { SETTLEMENT_UPI_ID } from "../config.js";
import { upiLink } from "../services/geo.js";
import { hapticSuccess, hapticTap } from "../services/native.js";
import { LEVEL_TEXT, RANGES, canSubmitDeposit, cleanPaymentRef, earningsView, refHint, cashStatus, ledgerEffect, ledgerHelp, ledgerLabel, parseAmount, quickAmounts } from "../services/wallet.js";

export function CashMeter({ rider }) {
  const s = cashStatus(rider);
  return (<>
    <div className="bar" role="progressbar" aria-valuenow={s.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Cash limit used"><i style={{ width: `${s.pct}%` }} className={`lvl-${s.level}`} /></div>
    <small className="muted">Limit <Money v={s.limit} /> · room for <Money v={s.room} /> more{s.pending > 0 && <> · <Money v={s.pending} /> awaiting verification</>}</small>
    {LEVEL_TEXT[s.level] && <div className={`note ${s.level === "warn" ? "warn" : "err"}`}>{LEVEL_TEXT[s.level]}</div>}
  </>);
}

export function DepositSheet({ rider, onClose, onDone }) {
  const { actions, busy, error } = useRider();
  const s = cashStatus(rider);
  const [amount, setAmount] = useState(String(s.due)); const [ref, setRef] = useState(""); const [opened, setOpened] = useState(false); const [done, setDone] = useState(false); const [copied, setCopied] = useState(false);
  const amt = parseAmount(amount);
  const valid = canSubmitDeposit(amt, s.due, ref);
  useBackHandler(true, onClose);
  const copyUpi = async () => { try { await navigator.clipboard.writeText(SETTLEMENT_UPI_ID); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  const submit = async () => { const r = await actions.settle(amt, cleanPaymentRef(ref)); if (r.ok) { hapticSuccess(); setDone(true); onDone?.(); } };
  return (
    <div className="overlay"><div className="sheet">
      {done ? (<>
        <h3>Deposit submitted ✓</h3>
        <p className="muted">We've received your reference. Your cash balance drops once the SehatWaadi team verifies the payment. It's shown as "awaiting verification" until then.</p>
        <Button onClick={onClose}>Done</Button>
      </>) : (<>
        <h3>Deposit cash by UPI</h3>
        <ol className="steps-text"><li>Choose the amount and pay it by UPI.</li><li>Come back and enter the UPI reference (UTR) from your payment app.</li></ol>
        <ErrorNote text={error} onClose={actions.clearError} />
        <label className="field"><span>Amount (you hold <Money v={s.due} /> to deposit)</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <div className="chips">{quickAmounts(s.due).map((q) => <button key={q.key} type="button" className={`chip ${amt === q.value ? "on" : ""}`} onClick={() => { hapticTap(); setAmount(String(q.value)); }}>{q.label}</button>)}</div>
        {amt > s.due && <div className="note warn">That's more than the cash you hold.</div>}
        {SETTLEMENT_UPI_ID ? (<>
          <a className={`btn ${opened ? "ghost" : "primary"}`} href={amt > 0 ? upiLink(SETTLEMENT_UPI_ID, amt) : undefined} aria-disabled={!(amt > 0)} onClick={() => setOpened(true)}>Pay <Money v={amt} /> in your UPI app</a>
          <div className="row between small"><span className="muted">Paying to <b>{SETTLEMENT_UPI_ID}</b></span><button className="link" type="button" onClick={copyUpi}>{copied ? "Copied" : "Copy UPI ID"}</button></div>
        </>) : <div className="note warn">The settlement UPI ID isn't set up in this build (VITE_SETTLEMENT_UPI_ID). Ask SehatWaadi where to pay.</div>}
        <label className="field"><span>UPI reference / UTR (12 digits) {opened && <b className="hint">← enter it after paying</b>}</span><input value={ref} onChange={(e) => setRef(e.target.value)} inputMode="numeric" maxLength={16} autoComplete="off" placeholder="e.g. 412345678901" aria-invalid={!!refHint(ref)} /></label>
        {refHint(ref) && <div className="note warn" role="status">{refHint(ref)}</div>}
        <div className="row"><Button kind="ghost" onClick={onClose}>Close</Button><Button busy={busy} disabled={!valid} onClick={submit}>Submit deposit</Button></div>
      </>)}
    </div></div>
  );
}

export default function Wallet({ onBack }) {
  const { rider, api, error, actions } = useRider();
  const s = cashStatus(rider);
  const [rows, setRows] = useState(null); const [loadErr, setLoadErr] = useState(""); const [deposit, setDeposit] = useState(false);
  const [sum, setSum] = useState(null); const [range, setRange] = useState("today");
  useBackHandler(true, onBack);
  const load = useCallback(async () => {
    const r = await api.getLedger(40); if (r.ok) { setRows(r.rows); setLoadErr(""); } else setLoadErr("Couldn't load your history. Pull to retry.");
    if (api.getMyEarnings) { const e = await api.getMyEarnings(); if (e.ok) setSum(e); }
  }, [api]);
  useEffect(() => { load(); }, [load, rider.cashInHand, rider.earningsBalance, rider.pendingSettlement]);
  const ev = earningsView(sum, range);
  const owed = Number(rider.earningsBalance) || 0;
  return (
    <main className="screen wallet">
      <header className="top"><button className="link" onClick={onBack} aria-label="Back">← Back</button><b>Wallet</b><button className="link" onClick={load}>Refresh</button></header>
      <ErrorNote text={error} onClose={actions.clearError} />

      {ev && (
        <Card title="What you've earned">
          <div className="chips" role="tablist" aria-label="Period">{RANGES.map((r) => <button key={r.key} type="button" role="tab" aria-selected={range === r.key} className={`chip ${range === r.key ? "on" : ""}`} onClick={() => setRange(r.key)}>{r.label}</button>)}</div>
          <div className="big" aria-label="Total earned"><Money v={ev.total} /></div>
          <small className="muted">{ev.deliveries} {ev.deliveries === 1 ? "delivery" : "deliveries"} · your delivery fees from all orders</small>
          <ul className="list split">
            <li><div><b>Kept from cash orders</b><small className="muted block">Already with you. On cash orders you keep your fee out of the cash you collect.</small></div><b className="pos"><Money v={ev.kept} /></b></li>
            <li><div><b>From online-paid orders</b><small className="muted block">The customer paid SehatWaadi online, so SehatWaadi pays you this fee.</small></div><b className="pos"><Money v={ev.credited} /></b></li>
          </ul>
        </Card>)}

      <Card title="SehatWaadi will pay you">
        <div className="big"><Money v={owed} /></div>
        <small className="muted">{owed > 0 ? "Fees from online-paid orders, waiting to be paid out to you. Depositing cash does not reduce this." : "Nothing waiting. Fees from cash orders are already with you, so only online-paid orders show up here."}</small>
      </Card>

      <Card title="Cash to give SehatWaadi">
        <div className="big"><Money v={s.cash} /></div>
        <small className="muted">This is the order amount you collected in cash. It is SehatWaadi's money, not yours. Your own delivery fees are not in this number.</small>
        <CashMeter rider={rider} />
        <Button disabled={!s.canSettle} onClick={() => setDeposit(true)}>{s.canSettle ? "Deposit cash by UPI" : s.pending > 0 ? "Deposit under verification" : "Nothing to deposit"}</Button>
      </Card>

      <details className="card howto">
        <summary><b>How your money works</b></summary>
        <p><b>Customer pays cash.</b> Say the bill is ₹800 including your ₹40 fee. You collect ₹800, keep your ₹40, and owe SehatWaadi ₹760. The ₹760 shows under "Cash to give SehatWaadi" until you deposit it.</p>
        <p><b>Customer pays online.</b> You collect nothing. SehatWaadi owes you the ₹40 fee, and it shows under "SehatWaadi will pay you".</p>
        {ev && <p className="muted small">So "What you've earned" adds both together: fees you kept plus fees SehatWaadi pays you.</p>}
      </details>

      <Card title="History">
        {loadErr && <div className="note warn">{loadErr}</div>}
        {rows === null && !loadErr ? <p className="muted">Loading…</p> : rows && rows.length === 0 ? <p className="muted">No activity yet.</p> : (
          <ul className="list ledger">{(rows || []).map((e) => { const fx = ledgerEffect(e); const help = ledgerHelp(e.entry_type); return (
            <li key={e.id}><div><b>{ledgerLabel(e.entry_type)}</b>
              <small className="muted block">{new Date(e.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>
              {help && <small className="muted block">{help}</small>}</div>
              <div className="right"><b className={`fx ${fx.tone}`}>{fx.text}</b>{e.cash_in_hand_after != null && <small className="muted block">cash held now <Money v={e.cash_in_hand_after} /></small>}</div></li>); })}</ul>)}
      </Card>
      {deposit && <DepositSheet rider={rider} onClose={() => setDeposit(false)} onDone={load} />}
    </main>
  );
}
