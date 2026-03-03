
import express from "express";
import bodyParser from "body-parser";
import WebSocket from "ws";
import { WebSocketServer } from "ws";


const app = express();

// Twilio posts x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.urlencoded({ extended: false }));

const PUBLIC_HOST = "hvac-ai-phone.onrender.com"; // for wss://

app.get("/", (_, res) => res.send("Server running"));
app.get("/health", (_, res) => res.json({ ok: true }));

// 1) Incoming call hits here (Twilio Voice Webhook)
app.post("/voice", (req, res) => {
  res.status(200).type("text/xml").send(`
<Response>
  <Say voice="alice">
    Welcome to HVAC Services Pro.
    For Sales press 1.
    For Dispatch press 2.
    For Service press 3.
    For Billing press 4.
    For Warranty press 5.
  </Say>

  <!-- IMPORTANT: Use relative action -->
  <Gather input="dtmf" numDigits="1" action="/menu" method="POST" timeout="7">
    <Say voice="alice">Please press 1, 2, 3, 4, or 5 now.</Say>
  </Gather>

  <Say voice="alice">Sorry, I did not get a selection.</Say>
  <!-- IMPORTANT: Use relative redirect -->
  <Redirect method="POST">/voice</Redirect>
</Response>
  `);
});

// 2) Twilio posts the pressed digit here
app.post("/menu", (req, res) => {
  // Log everything so we can debug instantly
  console.log("✅ /menu hit. Body:", req.body);

  const d = (req.body?.Digits || "").trim();

  const deptMap = {
    "1": "sales",
    "2": "dispatch",
    "3": "service",
    "4": "billing",
    "5": "warranty",
  };

  const dept = deptMap[d] || "general";
  const streamUrl = `wss://${PUBLIC_HOST}/media`;

  res.status(200).type("text/xml").send(`
<Response>
  <Say voice="alice">Got it. Connecting you now.</Say>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="department" value="${dept}" />
    </Stream>
  </Connect>
</Response>
  `);
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server started");
});

const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs, req) => {
  console.log("✅ Twilio stream connected:", req.url);

  let streamSid = null;
  let openaiWs = null;
  let department = "general";

  function connectOpenAI() {
    openaiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    openaiWs.on("open", () => {
      console.log("✅ OpenAI Realtime connected");

      openaiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            audio: {
              input: { format: "g711_ulaw" },
              output: { format: "g711_ulaw" }
            },
            instructions: `You are an HVAC Services Pro phone agent.
Department: ${department}.
Be concise, friendly, and ask one question at a time.
Never say you are an AI.`,
            voice: "alloy",
            turn_detection: { type: "server_vad" }
          }
        })
      );

      // Option B: small “thinking” pause before greeting
      setTimeout(() => {
        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions: "Greet the caller and ask how you can help today."
            }
          })
        );
      }, 1200);
    });

    openaiWs.on("message", (data) => {
      const evt = JSON.parse(data.toString());

      // OpenAI audio chunks -> send back to Twilio
      if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: evt.delta }
          })
        );
      }

      if (evt.type === "error") {
        console.log("❌ OpenAI error:", evt);
      }
    });

    openaiWs.on("close", () => console.log("❎ OpenAI disconnected"));
    openaiWs.on("error", (e) => console.log("❌ OpenAI ws error:", e.message));
  }

  twilioWs.on("message", (msg) => {
    let evt;
    try {
      evt = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      department = evt.start?.customParameters?.department || "general";
      console.log("▶️ start event received", { streamSid, department });

      if (!process.env.OPENAI_API_KEY) {
        console.log("❌ OPENAI_API_KEY missing in Render env");
        return;
      }
      if (!openaiWs) connectOpenAI();
    }

    if (evt.event === "media") {
      const payload = evt.media?.payload;
      if (payload && openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: payload
          })
        );
      }
    }

    if (evt.event === "stop") {
      console.log("⏹ stop event received");
      try { openaiWs?.close(); } catch {}
    }
  });

  twilioWs.on("close", () => {
    console.log("❎ Twilio stream disconnected");
    try { openaiWs?.close(); } catch {}
  });
});
