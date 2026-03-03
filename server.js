import express from "express";
import bodyParser from "body-parser";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.urlencoded({ extended: false }));

const PUBLIC_HOST = "hvac-ai-phone.onrender.com";

const BOOKING_URL =
  "https://online-booking.workiz.com/?ac=ce81609e5960ac123a2353397f1d45e4b8379f09d813a87ec45820c773c6b783";

// Twilio SMS client
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

app.get("/", (_, res) => res.send("Server running"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ✅ DIRECT CONNECT — NO MENU
// Twilio Voice webhook URL should point to: https://hvac-ai-phone.onrender.com/voice  (POST)
app.post("/voice", (req, res) => {
  const caller = (req.body?.From || "").trim();
  const streamUrl = `wss://${PUBLIC_HOST}/media`;

  res.status(200).type("text/xml").send(`
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="caller" value="${caller}" />
    </Stream>
  </Connect>
</Response>
  `);
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server started");
});

const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let callerNumber = "";
  let responseActive = false;

  // prevent double-booking per call
  let booked = false;

  function oaiSend(ws, obj) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  async function sendBookingSms(to) {
    if (!twilioClient) {
      console.log("⚠️ SMS disabled: missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
      return false;
    }
    if (!process.env.TWILIO_SMS_FROM) {
      console.log("⚠️ SMS disabled: missing TWILIO_SMS_FROM");
      return false;
    }
    if (!to) {
      console.log("⚠️ SMS disabled: missing destination number");
      return false;
    }

    await twilioClient.messages.create({
      to,
      from: process.env.TWILIO_SMS_FROM,
      body: `HVAC Services Pro — Book your NEW AC estimate here:\n${BOOKING_URL}`,
    });

    console.log("✅ Booking link SMS sent to:", to);
    return true;
  }

  // Strict booking trigger parser
  function parseBookingLine(text) {
    if (!text) return null;
    if (!text.includes("BOOK_NEW_AC_ESTIMATE")) return null;

    const parts = text.split("|").map((p) => p.trim());
    const kv = {};
    for (const p of parts) {
      const m = p.match(/^(\w+)\s*=\s*(.+)$/);
      if (m) kv[m[1]] = m[2];
    }
    return {
      name: kv.name || "",
      phone: kv.phone || "",
      city: kv.city || "",
      address: kv.address || "",
      window: kv.window || "",
      size: kv.size || "",
    };
  }

  function buildInstructions() {
    return `You are HVAC Services Pro’s receptionist.
Speak ENGLISH ONLY (United States).

CRITICAL:
- Ask EXACTLY ONE short question at a time.
- No long explanations. No lists. Keep it brief and human.
- Don’t mention AI, models, or being virtual.

BOOKING — NEW AC ESTIMATE (STRICT ORDER):
If the caller wants to book a NEW AC system estimate, follow this exact order:

1) Ask: "What’s your full name?"
2) Ask: "What’s the best phone number?"
3) Ask: "What city are you in?"
4) Ask: "What’s the service address?"
5) Ask: "What day and time window works best?"

Optional (only after #5): "About how many square feet is the home?"

When you have steps 1–5, output ONE line exactly:
BOOK_NEW_AC_ESTIMATE | name=<name> | phone=<phone> | city=<city> | address=<address> | window=<window> | size=<size or blank>

Then say: "Perfect — I’m texting you the booking link now."`;
  }

  // OpenAI Realtime WS
  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");

    // Supported formats: pcm16, g711_ulaw, g711_alaw
    oaiSend(openaiWs, {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: process.env.OPENAI_VOICE || "verse",
        turn_detection: { type: "server_vad" },
        instructions: buildInstructions(),
      },
    });

    // Greeting
    setTimeout(() => {
      oaiSend(openaiWs, {
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Speak English only. Hi — thank you for calling HVAC Services Pro. What can I help you with today?",
        },
      });
    }, 400);
  });

  openaiWs.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "response.created") responseActive = true;
    if (msg.type === "response.done") responseActive = false;

    // Send AI audio back to Twilio
    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );
    }

    // Log errors clearly
    if (msg.type === "error") {
      console.log("❌ OpenAI error:", msg?.error?.code, msg?.error?.message);
      return;
    }

    // Try to detect the booking trigger line from any text-ish payload
    const textCandidate =
      (typeof msg.delta === "string" && msg.delta) ||
      (typeof msg.text === "string" && msg.text) ||
      null;

    const booking = parseBookingLine(textCandidate);
    if (booking && !booked) {
      booked = true;
      console.log("📅 Booking captured:", booking);

      // Send SMS to provided phone, else fallback to caller ID
      const to = booking.phone || callerNumber;

      try {
        await sendBookingSms(to);
      } catch (e) {
        console.log("❌ SMS send failed:", e?.message || e);
      }

      // Voice confirmation
      setTimeout(() => {
        oaiSend(openaiWs, {
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions:
              "Speak English only. All set — I just texted you the booking link.",
          },
        });
      }, 350);
    }
  });

  openaiWs.on("close", () => console.log("❎ OpenAI disconnected"));
  openaiWs.on("error", (e) => console.log("❌ OpenAI ws error:", e.message));

  // Twilio stream events
  twilioWs.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      callerNumber = evt.start?.customParameters?.caller || "";
      console.log("▶️ start event received", { streamSid, callerNumber });

      // refresh instructions on each call start
      oaiSend(openaiWs, {
        type: "session.update",
        session: { instructions: buildInstructions() },
      });
    }

    if (evt.event === "media") {
      const payload = evt.media?.payload;
      if (!payload) return;

      // Cancel only if actively speaking (prevents spam errors)
      if (responseActive) {
        oaiSend(openaiWs, { type: "response.cancel" });
      }

      oaiSend(openaiWs, {
        type: "input_audio_buffer.append",
        audio: payload,
      });
    }

    if (evt.event === "stop") {
      console.log("⏹ stop event received");
      try {
        openaiWs.close();
      } catch {}
    }
  });

  twilioWs.on("close", () => {
    console.log("❎ Twilio stream disconnected");
    try {
      openaiWs.close();
    } catch {}
  });
});
