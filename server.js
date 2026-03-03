
    

        
  import express from "express";
import bodyParser from "body-parser";
import WebSocket from "ws";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.urlencoded({ extended: false }));

const PUBLIC_HOST = "hvac-ai-phone.onrender.com"; // your Render host

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

  // ----- Twilio state -----
  let streamSid = null;
  let department = "general";
  let latestMediaTimestamp = 0;

  // Used for clean interruption like Twilio sample
  let lastAssistantItemId = null;
  let responseStartTimestampTwilio = null;
  let markQueue = [];

  // ----- OpenAI WS -----
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

  const sendMark = () => {
    if (!streamSid) return;
    twilioWs.send(
      JSON.stringify({
        event: "mark",
        streamSid,
        mark: { name: "responsePart" },
      })
    );
    markQueue.push("responsePart");
  };

  const handleSpeechStarted = () => {
    // If AI is talking, truncate it and clear Twilio buffer
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedMs = latestMediaTimestamp - responseStartTimestampTwilio;

      if (lastAssistantItemId) {
        openaiWs.send(
          JSON.stringify({
            type: "conversation.item.truncate",
            item_id: lastAssistantItemId,
            content_index: 0,
            audio_end_ms: elapsedMs,
          })
        );
      }

      // Clear audio already queued on Twilio side
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));

      // Reset
      markQueue = [];
      lastAssistantItemId = null;
      responseStartTimestampTwilio = null;
    }
  };

  const initializeOpenAI = () => {
    // IMPORTANT: OpenAI supports pcm16, g711_ulaw, g711_alaw (NOT pcMU string)
    // Your Twilio stream is μ-law, so use g711_ulaw.
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: "alloy",
          turn_detection: { type: "server_vad" },
          modalities: ["audio", "text"],
          instructions: `You are HVAC Services Pro's phone agent.
Department: ${department}.
Be concise, friendly, and ask one question at a time.
Never say you are an AI.`,
        },
      })
    );
  };

  const sendInitialGreeting = () => {
    // Make the assistant speak FIRST (reliable method: create a user item + response.create)
    openaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `You are connected to the ${department} department. Please greet the caller and ask how you can help today.`,
            },
          ],
        },
      })
    );
    openaiWs.send(JSON.stringify({ type: "response.create" }));
  };

  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
    // Give it a tiny moment, then init session
    setTimeout(initializeOpenAI, 100);
  });

  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // 1) Stream audio back to Twilio
    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );

      // Start elapsed time counter at first audio chunk
      if (responseStartTimestampTwilio == null) {
        responseStartTimestampTwilio = latestMediaTimestamp;
      }

      if (msg.item_id) lastAssistantItemId = msg.item_id;
      sendMark();
    }

    // 2) Interruption hook (best-practice pattern)
    if (msg.type === "input_audio_buffer.speech_started") {
      handleSpeechStarted();
    }

    // 3) Log errors clearly
    if (msg.type === "error") {
      console.log("❌ OpenAI error:", msg.error?.code, msg.error?.message);
    }
  });

  openaiWs.on("close", () => console.log("❎ OpenAI disconnected"));
  openaiWs.on("error", (e) => console.log("❌ OpenAI ws error:", e.message));

  twilioWs.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (evt.event) {
      case "start": {
        streamSid = evt.start?.streamSid || null;
        department = evt.start?.customParameters?.department || "general";
        latestMediaTimestamp = 0;
        responseStartTimestampTwilio = null;
        markQueue = [];
        lastAssistantItemId = null;

        console.log("▶️ start event received", { streamSid, department });

        // Update instructions now that we know department
        if (openaiWs.readyState === WebSocket.OPEN) {
          initializeOpenAI();
          // Speak first after a short pause
          setTimeout(sendInitialGreeting, 250);
        }
        break;
      }

      case "media": {
        latestMediaTimestamp = evt.media?.timestamp ?? latestMediaTimestamp;
        const payload = evt.media?.payload;

        if (payload && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: payload,
            })
          );
        }
        break;
      }

      case "mark": {
        if (markQueue.length > 0) markQueue.shift();
        break;
      }

      case "stop": {
        console.log("⏹ stop event received");
        try {
          openaiWs.close();
        } catch {}
        break;
      }

      default:
        // console.log("Twilio event:", evt.event);
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("❎ Twilio stream disconnected");
    try {
      openaiWs.close();
    } catch {}
  });
});
