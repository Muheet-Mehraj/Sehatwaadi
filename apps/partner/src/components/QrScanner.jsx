import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Button } from "./ui.jsx";
// Camera QR scanner (jsQR works on every phone browser, including iOS Safari). If the camera is unavailable the rider can paste the code.
export default function QrScanner({ title, onResult, onCancel }) {
  const video = useRef(null), canvas = useRef(null);
  const [err, setErr] = useState(""); const [manual, setManual] = useState("");
  useEffect(() => {
    let stream, raf, stopped = false, last = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 960 } }, audio: false });
        video.current.srcObject = stream; await video.current.play();
        const tick = (t) => {
          if (stopped) return;
          raf = requestAnimationFrame(tick);
          if (t - last < 120 || video.current.readyState < 2) return; last = t;
          const w = video.current.videoWidth, h = video.current.videoHeight; if (!w) return;
          const c = canvas.current; c.width = w; c.height = h; const ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(video.current, 0, 0, w, h);
          const q = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
          if (q?.data) { stopped = true; onResult(q.data.trim()); }
        };
        raf = requestAnimationFrame(tick);
      } catch (e) { setErr(e?.name === "NotAllowedError" ? "Camera permission is blocked. Allow it in your browser settings, or paste the code below." : "Couldn't start the camera. Paste the code below."); }
    })();
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="overlay" role="dialog" aria-label={title}>
      <div className="sheet">
        <h3>{title}</h3>
        {!err && <div className="scan"><video ref={video} playsInline muted /><canvas ref={canvas} hidden /><div className="scan-frame" /></div>}
        {err && <div className="note err">{err}</div>}
        <label className="field"><span>Or paste the code</span><input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="SW1.…" autoCapitalize="off" autoCorrect="off" /></label>
        <div className="row"><Button kind="ghost" onClick={onCancel}>Cancel</Button><Button disabled={manual.trim().length < 10} onClick={() => onResult(manual.trim())}>Use code</Button></div>
      </div>
    </div>
  );
}
