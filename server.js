import express from "express";
import bodyParser from "body-parser";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.urlencoded({ extended: false }));

app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));

// --- IMPORTANT: BIND TO RENDER PORT ---
const PORT = Number(process.env.PORT || 3000);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server started and listening on", PORT);
});

// WebSocket server for Twilio Media Streams
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", () => {
  console.log("✅ WS /media connected");
});

// If you want, keep your other routes below (voice/sms/etc).
// But this file guarantees Render sees an open port.
