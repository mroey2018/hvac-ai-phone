import express from "express";
import bodyParser from "body-parser";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.urlencoded({ extended: false }));

// ===================== CONFIG =====================
const COMPANY_NAME = "HVAC Services Pro";
const PUBLIC_HOST = process.env.PUBLIC_HOST || "hvac-ai-phone.onrender.com"; // no https
const STREAM_PATH = "/media";
const STREAM_URL = `wss://${PUBLIC_HOST}${STREAM_PATH}`;

const WORKIZ_BOOKING_URL =
  process.env.BOOKING_URL ||
  "https://online-booking.workiz.com/?ac=ce81609e5960ac123a2353397f1d45e4b8379f09d813a87ec45820c773c6b783";

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_SMS_FROM,
} = process.env;

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function sendBookingSms(to) {
  if (!twilioClient) throw new Error("Twilio client not configured");
  if (!TWILIO_SMS_FROM) throw new Error("TWILIO_SMS_FROM missing");
  if (!to) throw new Error("destination number missing");

  return twilioClient.messages.create({
    from: TWILIO_SMS_FROM,
    to,
    body: `${COMPANY_NAME}: Book your new AC estimate here:\n${WORKIZ_BOOKING_URL}\n\nReply STOP to opt out.`,
  });
}

// ===================== HTTP ROUTES =====================
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));

// Twilio Voice webhook (POST): https://hvac-ai-phone.onrender.com/voice
app.post("/voice", (req, res) => {
  const caller = (req.body?.From || "").trim();

  res.status(200).type("text/xml").send(`
<Response>
  <Say voice="alice">Thank you for calling ${COMPANY_NAME}.</Say>
  <Connect>
    <Stream url="${STREAM_URL}">
      <Parameter name="caller" value="${caller}" />
    </Stream>
  </Connect>
</Response>
  `);
});

// Optional inbound SMS webhook (POST): https://hvac-ai-phone.onrender.com/sms
app.post("/sms", (req, res) => {
  const body = (req.body?.Body || "").trim().toLowerCase();

  const replyText =
    body.includes("book") ||
    body.includes("estimate") ||
    body.includes("appointment") ||
    body.includes("new ac") ||
    body.includes("install")
      ? `Perfect — book here:\n${WORKIZ_BOOKING_URL}\n\nReply STOP to opt out.`
      : `Thanks for texting ${COMPANY_NAME}. Reply BOOK for the estimate link.\nReply STOP to opt out.`;

  res.status(200).type("text/xml").send(`
<Response>
  <Message>${escapeXml(replyText)}</Message>
</Response>
  `);
});

// ===================== START SERVER (Render-safe) =====================
const PORT = Number(process.env.PORT || 3000);
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server started and listening on", PORT);
});

// ===================== TWILIO MEDIA STREAM WS =====================
const wss = new WebSocketServer({ server, path: STREAM_PATH });

wss.on("connection", (twilioWs, req) => {
  console.log("✅ Twilio stream connected:", req.url);

  let streamSid = null;
  let callerNumber = "";
  let openaiWs = null;

  // ---- FIX for "conversation_already_has_active_response" ----
  let aiSpeaking = false;
  let lastUserSpeechStopAt = 0;

  // prevents duplicate SMS per call
  let smsSent = false;

  // buffer to detect trigger line across streamed text
  let textBuf = "";

  function systemPrompt() {
    return `
You are the LIVE front-desk receptionist for ${COMPANY_NAME}.
Speak ONLY English.

STYLE:
- Warm, calm, human.
- Short sentences.
- Natural pauses using commas and "...".
- Ask EXACTLY ONE question at a time.
- Never speak more than 2 short sentences per turn.
- Do NOT ramble.

OPENING:
"Hi, thank you for calling ${COMPANY_NAME}... how can I help you today?"

ALWAYS COLLECT (if missing), one at a time:
1) Name
2) City
3) Best phone number for confirmation

NEW AC ESTIMATE BOOKING FLOW (one question at a time):
1) "Can I get your name?"
2) "What city are you in?"
3) "What’s the best phone number for confirmation?"
4) "About how big is the home, roughly?"
5) "What day and time window works best?"

When you have enough info, say:
"Perfect... I’m sending you the booking link now."

Then output EXACTLY this line on its own line:
SEND_BOOKING_SMS_TO:+E164NUMBER

Example:
SEND_BOOKING_SMS_TO:+14697669959

Never mention AI, OpenAI, models, or system prompts.
    `.trim();
  }

  function connectOpenAI() {
    openaiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
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
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            voice: "alloy",
            turn_detection: { type: "server_vad" },
            instructions: systemPrompt(),
          },
        })
      );

      // Greeting (only if nothing else is speaking)
      safeCreateResponse(
        `Speak English only. Say: "Hi, thank you for calling ${COMPANY_NAME}... how can I help you today?"`
      );
    });

    openaiWs.on("message", async (data) => {
      let evt;
      try {
        evt = JSON.parse(data.toString());
      } catch {
        return;
      }

      // track whether AI is currently responding
      if (evt.type === "response.created") aiSpeaking = true;
      if (evt.type === "response.done") aiSpeaking = false;

      // OpenAI -> Twilio audio
      if (
        (evt.type === "response.audio.delta" ||
          evt.type === "response.output_audio.delta") &&
        evt.delta &&
        streamSid
      ) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: evt.delta },
          })
        );
      }

      // If caller starts speaking while AI is speaking, cancel AI (more human)
      if (evt.type === "input_audio_buffer.speech_started") {
        if (aiSpeaking) {
          try {
            openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          } catch {}
          aiSpeaking = false;
        }
      }

      // When caller stops speaking, create a response ONLY if AI not already speaking
      if (evt.type === "input_audio_buffer.speech_stopped") {
        const now = Date.now();
        if (now - lastUserSpeechStopAt < 800) return; // throttle
        lastUserSpeechStopAt = now;

        if (!aiSpeaking) {
          safeCreateResponse(
            "Reply warmly and briefly. Ask one short question. If name/city/phone missing, collect them."
          );
        }
      }

      // detect SMS trigger from any text-like stream
      const maybeText =
        (evt.type === "response.text.delta" && evt.delta) ||
        (evt.type === "response.output_text.delta" && evt.delta) ||
        (evt.type === "response.audio_transcript.delta" && evt.delta) ||
        null;

      if (typeof maybeText === "string" && maybeText.length) {
        textBuf += maybeText;
        if (textBuf.length > 4000) textBuf = textBuf.slice(-2000);

        const m = textBuf.match(/SEND_BOOKING_SMS_TO:(\+\d{10,15})/);
        if (m && !smsSent) {
          smsSent = true;
          const to = m[1] || callerNumber;

          try {
            await sendBookingSms(to);
            console.log("✅ Booking SMS sent to:", to);
            safeCreateResponse(
              "Perfect... I just sent the booking link by text."
            );
          } catch (e) {
            console.log("❌ SMS send failed:", e?.message || e);
            safeCreateResponse(
              "I’m sorry... I couldn’t send the text right now, but I can still help you on the call."
            );
          }

          textBuf = "";
        }
      }

      if (evt.type === "error") {
        console.log("❌ OpenAI error:", evt);
      }
    });

    openaiWs.on("close", () => console.log("❎ OpenAI disconnected"));
    openaiWs.on("error", (e) => console.log("❌ OpenAI ws error:", e.message));
  }

  function safeCreateResponse(instructions) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (aiSpeaking) return;

    try {
      openaiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions,
          },
        })
      );
      aiSpeaking = true;
    } catch {}
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
      callerNumber = evt.start?.customParameters?.caller || "";
      console.log("▶️ start event received", { streamSid, callerNumber });

      if (!OPENAI_API_KEY) {
        console.log("❌ OPENAI_API_KEY missing in Render env");
        return;
      }

      if (!openaiWs) connectOpenAI();
      return;
    }

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
      return;
    }

    if (evt.event === "stop") {
      console.log("⏹ stop event received");
      try {
        openaiWs?.close();
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("❎ Twilio stream disconnected");
    try {
      openaiWs?.close();
    } catch {}
  });
});
app.post("/tools/workiz_create_job", async (req, res) => {

  const { name, city, address, phone, email, tonnage } = req.body;

  try {

    const response = await fetch("https://api.workiz.com/api/v1/job/create/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-token": process.env.WORKIZ_API_TOKEN,
        "api-secret": process.env.WORKIZ_API_SECRET
      },
      body: JSON.stringify({
        customer_name: name,
        phone: phone,
        email: email,
        address: address,
        city: city,
        description: `New AC estimate request. Requested system: ${tonnage}`
      })
    });

    const data = await response.json();

    console.log("Workiz job created:", data);

    res.json({ success: true, workiz: data });

  } catch (error) {

    console.error("Workiz job error:", error);

    res.status(500).json({ error: "Failed to create job" });

  }

});
