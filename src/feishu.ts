import * as Lark from "@larksuiteoapi/node-sdk";
import { feishuSettings } from "./feishu/config";
import { FeishuClient, sdkOptions, sdkLogger } from "./feishu/client";
import { FeishuBridge } from "./feishu/bridge";
import { EyesHTTP } from "./feishu/eyes";
import { log } from "./log";

if (import.meta.main) {
  try {
    const settings = feishuSettings();
    const client = new FeishuClient(settings);
    const botId = await client.identity();
    const bridge = new FeishuBridge({ ...settings, botId }, client, new EyesHTTP(settings.eyesURL, settings.bridgeToken));
    const ws = new Lark.WSClient({ ...sdkOptions(settings), autoReconnect: true, handshakeTimeoutMs: 20_000,
      onReady: () => log("feishu_connected"), onReconnecting: () => log("feishu_reconnecting"), onReconnected: () => log("feishu_connected"),
      onError: () => { log("feishu_connection_failed"); void stop(1); },
    });
    let closing = false;
    async function stop(code = 0) {
      if (closing) return; closing = true; ws.close({ force: true });
      const timer = setTimeout(() => process.exit(1), 25_000);
      await bridge.close(); clearTimeout(timer); process.exit(code);
    }
    process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
    await ws.start({ eventDispatcher: new Lark.EventDispatcher({ logger: sdkLogger }).register({ "im.message.receive_v1": event => bridge.receive(event) }) });
  } catch { log("feishu_startup_failed", { hint: "Check app credentials, bot capability, permissions and network; raw SDK errors are omitted." }); process.exitCode = 1; }
}
