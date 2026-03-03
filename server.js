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

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

app.get("/", (_, res) => res.send("Server running"));
app.get("/health", (_, res) => res.json({ ok: true }));

// 🚀 DIRECT CONNECT — NO MENU
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
  let booked = false;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  function oaiSend(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
    }
  }

  function sendSMS(to) {
    if (!twilioClient || !process.env.TWILIO_SMS_FROM) return;

    twilioClient.messages.create({
      to,
      from: process.env.TWILIO_SMS_FROM,
      body: `Book your new AC estimate here:\n${BOOKING_URL}`,
    });
  }

  function parseBooking(text) {
    if (!text || !text.includes("BOOK_NEW_AC_ESTIMATE")) return null;

    const parts = text.split("|").map((p) => p.trim());
    const kv = {};
    for (const p of parts) {
      const m = p.match(/^(\w+)\s*=\s*(.+)$/);
      if (m) kv[m[1]] = m[2];
    }

    return {
      name: kv.name,
      phone: kv.phone,
      city: kv.city,
      address: kv.address,
      window: kv.window,
      size: kv.size,
    };
  }

  openaiWs.on("open", () => {
    oaiSend({
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "verse",
        turn_detection: { type: "server_vad" },
        instructions: `You are HVAC Services Pro’s receptionist.
Speak English only.
Sound warm and natural.
Ask ONE short question at a time.

If caller wants a NEW AC estimate:
Ask in this order:
1) Full name
2) Best phone number
3) City
4) Service address
5) Preferred day/time window

After collecting all, output EXACTLY:
BOOK_NEW_AC_ESTIMATE | name=<name> | phone=<phone> | city=<city> | address=<address> | window=<window> | size=<size or blank>

Then say:
"Perfect — I’m texting you the booking link now."`
      },
    });

    // 🎤 Greeting
    setTimeout(() => {
      oaiSend({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Hi — thank you for calling HVAC Services Pro. What can I help you with today?",
        },
      });
    }, 400);
  });

  openaiWs.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === "response.created") responseActive = true;
    if (msg.type === "response.done") responseActive = false;

    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );
    }

    if (msg.delta && typeof msg.delta === "string") {
      const booking = parseBooking(msg.delta);
      if (booking && !booked) {
        booked = true;
        sendSMS(booking.phone || callerNumber);

        setTimeout(() => {
          oaiSend({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions:
                "All set — I just texted you the booking link.",
            },
          });
        }, 400);
      }
    }
  });

  twilioWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.event === "start") {
      streamSid = evt.start.streamSid;
      callerNumber = evt.start.customParameters?.caller || "";
    }

    if (evt.event === "media") {
      if (responseActive) {
        oaiSend({ type: "response.cancel" });
      }

      oaiSend({
        type: "input_audio_buffer.append",
        audio: evt.media.payload,
      });
    }
  });
});
