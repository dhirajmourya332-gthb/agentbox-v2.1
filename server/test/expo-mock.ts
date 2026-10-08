/**
 * A local stand-in for Expo's push API, for the push tests. Point the server at it with
 * AGENTBOX_PUSH_URL=http://127.0.0.1:<port>/--/api/v2/push/send.
 *
 * - A token containing "Gone" gets a DeviceNotRegistered ticket.
 * - A token containing "Later" gets an ok ticket, then a DeviceNotRegistered receipt.
 * - `failNext = n` answers the next n send requests with 503 (to exercise the retries).
 */
import http from "node:http";

export type Sent = { at: number; messages: any[]; headers: http.IncomingHttpHeaders };

export async function startExpoMock(port: number) {
  const state = {
    sends: [] as Sent[],
    receiptCalls: [] as string[][],
    failNext: 0,
    attempts: 0,
    tickets: new Map<string, string>(), // receipt id → token
  };
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      let body: any = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(400, { errors: [{ code: "BAD_JSON" }] }); }
      if (req.method === "POST" && req.url === "/--/api/v2/push/send") {
        state.attempts++;
        if (state.failNext > 0) {
          state.failNext--;
          return reply(503, { errors: [{ code: "UNAVAILABLE" }] });
        }
        const messages = Array.isArray(body) ? body : [body];
        state.sends.push({ at: Date.now(), messages, headers: req.headers });
        return reply(200, {
          data: messages.map((m: any) => {
            if (String(m.to).includes("Gone")) {
              return { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } };
            }
            const id = `rcpt-${++n}`;
            state.tickets.set(id, String(m.to));
            return { status: "ok", id };
          }),
        });
      }
      if (req.method === "POST" && req.url === "/--/api/v2/push/getReceipts") {
        const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
        state.receiptCalls.push(ids);
        const data: Record<string, unknown> = {};
        for (const id of ids) {
          const token = state.tickets.get(id);
          if (!token) continue;
          data[id] = token.includes("Later")
            ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
            : { status: "ok" };
        }
        return reply(200, { data });
      }
      reply(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${port}/--/api/v2/push/send`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
