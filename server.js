import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const app = express();

// Twilio sends application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// === CONFIG ===
const PUBLIC_HOST = process.env.PUBLIC_HOST || "hvac-ai-phone.onrender.com"; // no https
const BOOKING_URL =
  process.env.BOOKING_URL ||
  "https://online-booking.workiz.com/?ac=ce81609e5960ac123a2353397f1d45e4b8379f09d813a87ec45820c773c6b783";

app.get("/", (_, res) => res.send("Server running"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ========= TWILIO VOICE WEBHOOK =========
// In Twilio -> Voice Configuration -> "A call comes in" -> Webhook:
// URL: https://hvac-ai-phone.onrender.com/voice
// Method: HTTP POST
app.post("/voice", (req, res) => {
  res.status(200).type("text/xml").send(`
<Response>
  <Say voice="alice">
    Thanks for calling HVAC Services Pro. Please hold for a moment while I connect you.
  </Say>

  <Connect>
    <Stream url="wss://${PUBLIC_HOST}/media">
      <Parameter name="booking_url" value="${BOOKING_URL}" />
    </Stream>
  </Connect>
</Response>
  `);
});

// ========= WEBSOCKET: TWILIO MEDIA STREAMS =========
const server = app.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server started");
});

const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs, req) => {
  console.log("✅ Twilio stream connected:", req.url);

  let streamSid = null;
  let openaiWs = null;
  let bookingUrl = BOOKING_URL;

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

      // Session settings (IMPORTANT)
      openaiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            voice: "alloy",
            turn_detection: { type: "server_vad" },
            instructions: `
You are the HVAC Services Pro phone receptionist.
Speak ONLY in English.
Sound like a real human receptionist: short, natural sentences.
Be friendly, confident, and fast.

Start with:
"Thanks for calling HVAC Services Pro. How can I help you today?"

Your job:
- Handle the caller request.
- If you do not have them yet, collect:
  1) Full name
  2) Best callback phone number
  3) City (and state if unclear)

If the caller wants a new AC system estimate or installation:
- Ask: (1) City, (2) home size in square feet, (3) preferred day/time.
- Then say: "Perfect — I’ll text you a booking link to lock it in."
- Tell them the booking link is: ${bookingUrl}

Do NOT mention AI, OpenAI, or that you are a bot.
Ask ONE question at a time.
Keep answers under 2 sentences unless you must clarify.
          `.trim(),
          },
        })
      );

      // Initial greeting
      openaiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio"],
            instructions:
              "Greet the caller exactly as instructed and ask how you can help.",
          },
        })
      );
    });

    openaiWs.on("message", (data) => {
      let evt;
      try {
        evt = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Forward OpenAI audio -> Twilio
      if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: evt.delta },
          })
        );
      }

      // When caller stops speaking -> make OpenAI respond
      if (evt.type === "input_audio_buffer.speech_stopped") {
        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio"],
              instructions:
                "Reply naturally, briefly, and ask one question at a time. If name/phone/city missing, collect them.",
            },
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

      // Read custom parameters (if Twilio sent them)
      bookingUrl =
        evt.start?.customParameters?.booking_url || BOOKING_URL;

      console.log("▶️ start event received", { streamSid, bookingUrl });

      if (!process.env.OPENAI_API_KEY) {
        console.log("❌ OPENAI_API_KEY missing in Render env");
        return;
      }

      if (!openaiWs) connectOpenAI();
    }

    // Incoming audio from Twilio -> OpenAI
    if (evt.event === "media") {
      const payload = evt.media?.payload;
      if (payload && openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: payload,
          })
        );
      }
    }

    if (evt.event === "stop") {
      console.log("⏹ stop event received");
      try {
        openaiWs?.close();
      } catch {}
    }
  });

  twilioWs.on("close", () => {
    console.log("❎ Twilio stream disconnected");
    try {
      openaiWs?.close();
    } catch {}
  });
});
