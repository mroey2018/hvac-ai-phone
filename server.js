
import express from "express";
import bodyParser from "body-parser";
import WebSocket from "ws";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.urlencoded({ extended: false }));

const PUBLIC_HOST = "hvac-ai-phone.onrender.com";

app.get("/", (_, res) => res.send("Server running"));
app.get("/health", (_, res) => res.json({ ok: true }));

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

  <Gather input="dtmf" numDigits="1" action="/menu" method="POST" timeout="7">
    <Say voice="alice">Please press 1, 2, 3, 4, or 5 now.</Say>
  </Gather>

  <Say voice="alice">Sorry, I did not get a selection.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>
  `);
});

app.post("/menu", (req, res) => {
  console.log("✅ /menu hit. Digits:", req.body?.Digits);

  const d = (req.body?.Digits || "").trim();
  const deptMap = { "1": "sales", "2": "dispatch", "3": "service", "4": "billing", "5": "warranty" };
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
  let department = "general";
  let openaiReady = false;

  // Print each OpenAI event type once (helps diagnose “silence” instantly)
  const seenTypes = new Set();

  if (!process.env.OPENAI_API_KEY) {
    console.log("❌ OPENAI_API_KEY missing in Render env");
    twilioWs.close();
    return;
  }

  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  function oaiSend(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function sendGreeting() {
    // Force an audio response
    oaiSend({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `You are the ${department} department.
Greet the caller warmly and ask how you can help today.`,
      },
    });
  }

  openaiWs.on("open", () => {
    openaiReady = true;
    console.log("✅ OpenAI Realtime connected");

    // Supported formats: pcm16, g711_ulaw, g711_alaw
    oaiSend({
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy",
        turn_detection: { type: "server_vad" },
        instructions: `You are HVAC Services Pro's phone agent.
Department: ${department}.
Be concise, friendly, ask one question at a time.
Never say you are an AI.`,
      },
    });

    // Speak first after a short pause
    setTimeout(sendGreeting, 600);
  });

  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Log event types once
    if (msg?.type && !seenTypes.has(msg.type)) {
      seenTypes.add(msg.type);
      console.log("🟦 OpenAI event type:", msg.type);
    }

    // Any error: print code + message
    if (msg.type === "error") {
      console.log("❌ OpenAI error:", msg?.error?.code, msg?.error?.message);
      return;
    }

    // ---- AUDIO OUT: robust extraction ----
    // Different builds may use different event names/fields:
    // - response.output_audio.delta { delta: base64 }
    // - response.audio.delta { delta: base64 }
    // - response.output_audio.chunk { chunk: base64 }
    // - sometimes { audio: base64 }
    let audioB64 = null;

    const isAudioEvent =
      msg.type === "response.output_audio.delta" ||
      msg.type === "response.audio.delta" ||
      msg.type === "response.output_audio.chunk";

    if (isAudioEvent) {
      audioB64 = msg.delta || msg.audio || msg.chunk || null;
    }

    if (audioB64 && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: audioB64 }, // base64 g711_ulaw
        })
      );
    }
  });

  openaiWs.on("close", () => {
    openaiReady = false;
    console.log("❎ OpenAI disconnected");
  });

  openaiWs.on("error", (e) => {
    console.log("❌ OpenAI ws error:", e.message);
  });

  twilioWs.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      department = evt.start?.customParameters?.department || "general";
      console.log("▶️ start event received", { streamSid, department });

      // Update department in session (if already open)
      if (openaiReady) {
        oaiSend({
          type: "session.update",
          session: {
            instructions: `You are HVAC Services Pro's phone agent.
Department: ${department}.
Be concise, friendly, ask one question at a time.
Never say you are an AI.`,
          },
        });

        // Speak again right after start (some calls need this)
        setTimeout(sendGreeting, 300);
      }
    }

    if (evt.event === "media") {
      const payload = evt.media?.payload;
      if (payload && openaiReady) {
        // Send caller audio to OpenAI
        oaiSend({
          type: "input_audio_buffer.append",
          audio: payload,
        });
      }
    }

    if (evt.event === "stop") {
      console.log("⏹ stop event received");
      try { openaiWs.close(); } catch {}
    }
  });

  twilioWs.on("close", () => {
    console.log("❎ Twilio stream disconnected");
    try { openaiWs.close(); } catch {}
  });
});
