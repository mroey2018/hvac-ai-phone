import express from "express";
import bodyParser from "body-parser";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.urlencoded({ extended: false }));

// ---- CONFIG ----
const PUBLIC_HOST = process.env.PUBLIC_HOST || "hvac-ai-phone.onrender.com";
const STREAM_PATH = "/media";
const STREAM_URL = `wss://${PUBLIC_HOST}${STREAM_PATH}`;

const COMPANY_NAME = "HVAC Services Pro";
const WORKIZ_BOOKING_URL =
  process.env.BOOKING_URL ||
  "https://online-booking.workiz.com/?ac=ce81609e5960ac123a2353397f1d45e4b8379f09d813a87ec45820c773c6b783";

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_SMS_FROM,
} = process.env;

// Twilio REST client (for outbound SMS)
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

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

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

app.get("/", (_, res) => res.send("Server running"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ---- VOICE WEBHOOK ----
app.post("/voice", (req, res) => {
  // Pass caller id to stream so we can SMS them without asking again
  const caller = (req.body?.From || "").trim();

  res.status(200).type("text/xml").send(`
<Response>
  <Say voice="alice">
    Hi, thank you for calling ${COMPANY_NAME}. Please hold for a moment.
  </Say>

  <Connect>
    <Stream url="${STREAM_URL}">
      <Parameter name="caller" value="${caller}" />
    </Stream>
  </Connect>
</Response>
  `);
});

// ---- OPTIONAL: INBOUND SMS AUTO-REPLY ----
app.post("/sms", (req, res) => {
  const from = (req.body?.From || "").trim();
  const body = (req.body?.Body || "").trim().toLowerCase();

  const reply = (text) =>
    res.status(200).type("text/xml").send(`
<Response>
  <Message>${escapeXml(text)}</Message>
</Response>
  `);

  if (!from) return reply("Sorry — I couldn't read your number. Please try again.");

  if (
    body.includes("book") ||
    body.includes("estimate") ||
    body.includes("appointment") ||
    body.includes("new ac") ||
    body.includes("install")
  ) {
    return reply(
      `Perfect — book your estimate here:\n${WORKIZ_BOOKING_URL}\n\nReply STOP to opt out.`
    );
  }

  return reply(
    `Thanks for texting ${COMPANY_NAME}. To book an estimate, reply BOOK.\nReply STOP to opt out.`
  );
});

// ---- START SERVER ----
const server = app.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server started");
});

// ---- TWILIO MEDIA STREAM WS ----
const wss = new WebSocketServer({ server, path: STREAM_PATH });

wss.on("connection", (twilioWs, req) => {
  console.log("✅ Twilio stream connected:", req.url);

  let streamSid = null;
  let callerNumber = "";
  let openaiWs = null;

  // prevents duplicate SMS per call
  let smsSent = false;

  function systemPrompt() {
    return `
You are the LIVE front-desk receptionist for ${COMPANY_NAME}.
Speak ONLY English.

VOICE & STYLE:
- Warm, calm, human.
- Short sentences.
- Natural pauses using commas and ellipses.
- Never sound robotic.
- Ask EXACTLY ONE question at a time.
- Never give more than 2 short sentences per turn.

OPENING:
Say: "Hi, thanks for calling ${COMPANY_NAME}... how can I help you today?"

ALWAYS COLLECT (if missing):
1) Name
2) City
3) Best phone number for confirmations

BOOKING (NEW AC ESTIMATE):
If caller wants a new AC estimate / installation:
- Ask in this order, one at a time:
  (1) Name
  (2) City
  (3) Best phone number
  (4) Rough home size (sq ft)
  (5) Best day/time window
- Then say: "Perfect... I'm sending you the booking link now."
- Then output EXACTLY this single line (nothing else on that line):
SEND_BOOKING_SMS_TO:+E164NUMBER

Example:
SEND_BOOKING_SMS_TO:+14697669959

Never mention AI or OpenAI.
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

      // Greeting
      openaiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions:
              `Speak English only. ` +
              `Greet warmly, then ask how you can help. ` +
              `Keep it short and human.`,
          },
        })
      );
    });

    // Buffer text so we can detect the SMS trigger line even if streamed
    let textBuf = "";

    openaiWs.on("message", async (data) => {
      let evt;
      try {
        evt = JSON.parse(data.toString());
      } catch {
        return;
      }

      // OpenAI audio -> Twilio
      if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: evt.delta },
          })
        );
      }

      // Text stream events vary; handle any string chunk we see
      const maybeText =
        (evt.type === "response.text.delta" && evt.delta) ||
        (evt.type === "response.output_text.delta" && evt.delta) ||
        null;

      if (typeof maybeText === "string" && maybeText.length) {
        textBuf += maybeText;
        if (textBuf.length > 4000) textBuf = textBuf.slice(-2000);

        // Look for trigger line
        const m = textBuf.match(/SEND_BOOKING_SMS_TO:(\+\d{10,15})/);
        if (m && !smsSent) {
          smsSent = true;
          const to = m[1] || callerNumber;

          try {
            await sendBookingSms(to);
            console.log("✅ Booking SMS sent to:", to);
          } catch (e) {
            console.log("❌ SMS send failed:", e?.message || e);
          }

          // Voice confirmation
          openaiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "Speak English only. All set... I just sent the booking link by text.",
              },
            })
          );

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
