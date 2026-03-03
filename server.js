import express from "express";
import bodyParser from "body-parser";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.urlencoded({ extended: false }));

const PUBLIC_HOST = "hvac-ai-phone.onrender.com";

// Your Workiz booking link (you gave this)
const BOOKING_URL =
  "https://online-booking.workiz.com/?ac=ce81609e5960ac123a2353397f1d45e4b8379f09d813a87ec45820c773c6b783";

// Twilio SMS client (optional but recommended)
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

app.get("/", (_, res) => res.send("Server running"));
app.get("/health", (_, res) => res.json({ ok: true }));

// 1) Incoming call -> menu
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

// 2) Digit -> connect to Media Stream
app.post("/menu", (req, res) => {
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

  // Twilio provides caller number in From
  const caller = (req.body?.From || "").trim();

  const streamUrl = `wss://${PUBLIC_HOST}/media`;

  res.status(200).type("text/xml").send(`
<Response>
  <Say voice="alice">Got it. Connecting you now.</Say>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="department" value="${dept}" />
      <Parameter name="caller" value="${caller}" />
    </Stream>
  </Connect>
</Response>
  `);
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server started");
});

// Twilio Media Stream WS endpoint
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs, req) => {
  console.log("✅ Twilio stream connected:", req.url);

  let streamSid = null;
  let department = "general";
  let callerNumber = "";

  let openaiWs = null;
  let openaiReady = false;

  // Track whether OpenAI is actively speaking so we don’t spam cancel
  let responseActive = false;

  // Avoid duplicate bookings per call
  let booked = false;

  // Basic “human” timing
  const humanDelayMs = () => 250 + Math.floor(Math.random() * 350);

  function safeJsonParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function sendTwilioMedia(base64Audio) {
    if (!streamSid) return;
    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64Audio },
      })
    );
  }

  function oaiSend(obj) {
    if (openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  async function sendBookingLinkSms(to) {
    if (!twilioClient) {
      console.log("⚠️ Twilio SMS not configured (missing TWILIO_ACCOUNT_SID/AUTH_TOKEN)");
      return false;
    }
    if (!process.env.TWILIO_SMS_FROM) {
      console.log("⚠️ Missing TWILIO_SMS_FROM env var (SMS-capable Twilio number)");
      return false;
    }
    if (!to) {
      console.log("⚠️ No caller number to send SMS to");
      return false;
    }

    await twilioClient.messages.create({
      to,
      from: process.env.TWILIO_SMS_FROM,
      body: `HVAC Services Pro — book your NEW AC estimate here:\n${BOOKING_URL}\nReply to this text if you want us to book it for you.`,
    });

    console.log("✅ Booking link SMS sent to:", to);
    return true;
  }

  function buildInstructions() {
    return `You are HVAC Services Pro’s front-desk phone agent.
Speak ENGLISH ONLY (United States). Never switch languages.

Sound like a real person:
- Warm, natural, short sentences.
- Use quick fillers sometimes (“Got it—one sec”, “Okay, perfect”).
- Ask ONE question at a time.
- Confirm details out loud.
- Don’t mention AI, models, policies, or being virtual.

Department: ${department}

Department rules:
- Sales: ask city + home size/tonnage + timeline + budget range if appropriate.
- Dispatch: ask address + issue + availability window.
- Service: ask symptoms + is system running + any error code/ice/water.
- Billing/Warranty: ask invoice/phone + keep it brief.

BOOKING rule (NEW AC estimate):
If the caller wants to book an appointment for a NEW AC system estimate:
1) Collect these fields (one question at a time):
   - full name
   - best phone number (confirm the number on caller ID is OK, or get a different one)
   - service address (street + city)
   - preferred day/time window (e.g., “tomorrow 2–5” or “any weekday after 4”)
   - home size or tonnage (optional)
2) After collecting required fields, output ONE line exactly:
   BOOK_NEW_AC_ESTIMATE | name=<...> | phone=<...> | address=<...> | window=<...> | size=<...>
3) Then say: “Perfect — I’m booking that now and I’ll text you the confirmation link.”`;
  }

  function parseBookingLine(text) {
    if (!text) return null;
    if (!text.includes("BOOK_NEW_AC_ESTIMATE")) return null;

    const parts = text.split("|").map((x) => x.trim());
    const kv = {};
    for (const p of parts) {
      const m = p.match(/^(\w+)\s*=\s*(.+)$/);
      if (m) kv[m[1]] = m[2];
    }
    return {
      name: kv.name || "",
      phone: kv.phone || "",
      address: kv.address || "",
      window: kv.window || "",
      size: kv.size || "",
    };
  }

  function speakConfirmSentLink() {
    // Make the agent confirm on the call (audio)
    const delay = humanDelayMs();
    setTimeout(() => {
      oaiSend({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Speak English only. Say: “All set — I just texted you the booking link. If you don’t see it in 30 seconds, tell me and I’ll resend.” Then stop.",
        },
      });
    }, delay);
  }

  function greet() {
    const delay = humanDelayMs();
    setTimeout(() => {
      oaiSend({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Speak English only. Say: “Hi! Thanks for calling HVAC Services Pro—this is Mia. How can I help you today?” Then stop.",
        },
      });
    }, delay);
  }

  function connectOpenAI() {
    if (!process.env.OPENAI_API_KEY) {
      console.log("❌ OPENAI_API_KEY missing in Render env");
      return;
    }

    openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    openaiWs.on("open", () => {
      openaiReady = true;
      console.log("✅ OpenAI Realtime connected");

      // Supported formats: pcm16, g711_ulaw, g711_alaw :contentReference[oaicite:1]{index=1}
      oaiSend({
        type: "session.update",
        session: {
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: process.env.OPENAI_VOICE || "verse",
          modalities: ["audio", "text"],
          turn_detection: { type: "server_vad" },
          instructions: buildInstructions(),
        },
      });

      // We’ll greet once we receive Twilio "start" so streamSid exists.
    });

    openaiWs.on("message", async (data) => {
      const msg = safeJsonParse(data.toString());
      if (!msg) return;

      // Track response lifecycle to avoid cancel spam
      if (msg.type === "response.created") responseActive = true;
      if (msg.type === "response.done") responseActive = false;

      // AUDIO OUT (support both common event names)
      const audioDelta =
        (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") && msg.delta
          ? msg.delta
          : null;

      if (audioDelta && streamSid) {
        sendTwilioMedia(audioDelta);
      }

      // TEXT OUT (catch booking trigger line)
      // Different builds can deliver text in different fields — check a few.
      let textOut = null;

      if (msg.type === "response.output_text.delta" && msg.delta) textOut = msg.delta;
      if (msg.type === "response.text.delta" && msg.delta) textOut = msg.delta;

      // Some responses include full text blocks:
      if (!textOut && typeof msg.text === "string") textOut = msg.text;
      if (!textOut && typeof msg.delta === "string" && msg.type?.includes("text")) textOut = msg.delta;

      // Booking detection
      const booking = parseBookingLine(textOut);
      if (booking && !booked) {
        booked = true;
        console.log("📅 Booking captured:", booking);

        // Prefer SMS to the phone they provided; fallback to caller ID
        const to = booking.phone || callerNumber;

        try {
          await sendBookingLinkSms(to);
        } catch (e) {
          console.log("❌ Failed to send SMS:", e?.message || e);
        }

        // Confirm on call
        speakConfirmSentLink();
      }

      // Log errors clearly
      if (msg.type === "error") {
        console.log("❌ OpenAI error:", msg?.error?.code, msg?.error?.message);
      }
    });

    openaiWs.on("close", () => {
      openaiReady = false;
      responseActive = false;
      console.log("❎ OpenAI disconnected");
    });

    openaiWs.on("error", (e) => {
      console.log("❌ OpenAI ws error:", e.message);
    });
  }

  connectOpenAI();

  twilioWs.on("message", (raw) => {
    const evt = safeJsonParse(raw.toString());
    if (!evt) return;

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      department = evt.start?.customParameters?.department || "general";
      callerNumber = evt.start?.customParameters?.caller || "";

      console.log("▶️ start event received", { streamSid, department, callerNumber });

      // Update instructions now that dept is known
      if (openaiReady) {
        oaiSend({
          type: "session.update",
          session: { instructions: buildInstructions() },
        });
      }

      // Greet
      greet();
    }

    if (evt.event === "media") {
      const payload = evt.media?.payload;

      if (payload && openaiReady) {
        // Only cancel if a response is actually active (prevents spam)
        if (responseActive) {
          oaiSend({ type: "response.cancel" });
        }

        // Send caller audio to OpenAI
        oaiSend({
          type: "input_audio_buffer.append",
          audio: payload,
        });
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
