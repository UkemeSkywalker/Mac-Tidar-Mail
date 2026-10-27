// Keeps a WebSocket open to the push API and calls onSignal whenever the server says
// "new mail". Signals carry no content. Reconnects with back-off, pings to stay open, and
// renews the connection before API Gateway's 2-hour limit (with a fresh access token).
import { fetchAuthSession } from "aws-amplify/auth";
import { liveConfig } from "./config";

export function connectPush(mailbox: string, onSignal: () => void): () => void {
  if (!liveConfig.wsUrl || typeof WebSocket === "undefined") return () => {};
  let ws: WebSocket | null = null, stopped = false, attempt = 0;
  let ping: ReturnType<typeof setInterval> | undefined, renew: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined;

  const clear = () => { clearInterval(ping); clearTimeout(renew); clearTimeout(retry); };
  const open = async () => {
    if (stopped) return;
    clear();
    let token: string | undefined;
    try { token = (await fetchAuthSession()).tokens?.accessToken?.toString(); } catch { token = undefined; }
    if (!token || stopped) { schedule(); return; }
    const url = `${liveConfig.wsUrl}?token=${encodeURIComponent(token)}&mailbox=${encodeURIComponent(mailbox)}`;
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      onSignal(); // catch anything that arrived while disconnected
      ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ action: "ping" })), 5 * 60_000);
      renew = setTimeout(() => ws?.close(4000, "renew"), 100 * 60_000);
    };
    ws.onmessage = e => { try { if (JSON.parse(String(e.data)).type === "new-mail") onSignal(); } catch { /* ignore */ } };
    ws.onclose = () => { ws = null; clear(); schedule(); };
    ws.onerror = () => ws?.close();
  };
  const schedule = () => {
    if (stopped) return;
    const delay = Math.min(60_000, 1000 * 2 ** attempt++) + Math.random() * 1000;
    retry = setTimeout(open, delay);
  };

  void open();
  return () => { stopped = true; clear(); ws?.close(1000, "bye"); };
}
