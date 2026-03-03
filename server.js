import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Your Render public host (no https://)
const PUBLIC_HOST = "hvac-ai-phone.onrender.com";

// Incoming call -> play menu -> gather 1 digit
app.post("/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Say voice="alice">
    Welcome to HVAC Services Pro.
    For Sales press 1.
    For Dispatch press 2.
    For Service press 3.
    For Billing press 4.
    For Warranty press 5.
  </Say>

  <Gather numDigits="1" action="/menu" method="POST" timeout="6">
    <Say voice="alice">Please press 1, 2, 3, 4, or 5 now.</Say>
  </Gather>

  <Say voice="alice">Sorry, I did not get a selection.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>
  `);
});

// After digit -> start Twilio Media Stream to /media
app.post("/menu", (req, res) => {
  const d = (req.body.Digits || "").trim();

  const deptMap = {
    "1": "sales",
    "2": "dispatch",
    "3": "service",
    "4": "billing",
    "5": "warranty",
  };

  const dept = deptMap[d] || "general";
  const streamUrl = `wss://${PUBLIC_HOST}/media`;

  res.type("text/xml");
  res.send(`
<Response>
  <Say voice="alice">Got it. Connecting you now.</Say>

  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="department" value="${dept}" />
    </Stream>
  </Connect>

  <Say voice="alice">Thanks for calling HVAC Services Pro.</Say>
</Response>
  `);
});

app.get("/", (_, res) => res.send("Server running"));

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Server started");
});

// WebSocket endpoint Twilio connects to
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (ws, req) => {
  console.log("✅ Twilio stream connected:", req.url);

  ws.on("message", (msg) => {
    const s = msg.toString();
    if (s.includes('"event":"start"')) console.log("▶️ start event received");
    if (s.includes('"event":"stop"')) console.log("⏹ stop event received");
  });

  ws.on("close", () => console.log("❎ Twilio stream disconnected"));
});
