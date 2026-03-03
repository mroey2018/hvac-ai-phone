import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));

const PUBLIC_HOST = process.env.PUBLIC_HOST || "hvac-ai-phone.onrender.com";

app.get("/", (_, res) => res.send("Server running"));

app.post("/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_HOST}/media" />
  </Connect>
</Response>
  `);
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server started");
});

const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio connected");

  let streamSid = null;
  let openaiWs = null;

  function connectOpenAI() {
    openaiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    openaiWs.on("open", () => {
      console.log("✅ OpenAI connected");

      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: "alloy",
          turn_detection: { type: "server_vad" },
      instructions: `
You are the live front-desk receptionist for HVAC Services Pro.

You must:
- Speak only English.
- Sound warm, calm, and natural.
- Use short sentences.
- Add natural pauses using commas.
- Never sound robotic.
- Never give long explanations.
- Ask ONE question at a time.
- Wait for the caller to answer before asking the next question.
- Do NOT ask multiple questions in one sentence.
- Do NOT repeat yourself.

Opening style:
"Hi, thank you for calling HVAC Services Pro... how can I help you today?"

If the caller wants a new AC estimate:
Step 1 — Ask: "Can I get your name?"
(wait for answer)

Step 2 — Ask: "What city are you in?"
(wait for answer)

Step 3 — Ask: "What’s the best phone number for confirmation?"
(wait for answer)

Step 4 — Ask: "About how big is the home, roughly?"
(wait for answer)

Step 5 — Ask: "What day works best for you?"
(wait for answer)

After collecting those, say:
"Perfect… I’ll send you the booking link right now."

Tone example:
"Got it… thank you."
"Okay, no problem."
"Sure, I can help with that."

Never talk more than 2 sentences at a time.
Never list options.
Never explain internal processes.
Sound like a real Texas receptionist.
`
          `.trim()
        }
      }));

      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: "Greet the caller."
        }
      }));
    });

    openaiWs.on("message", (data) => {
      const evt = JSON.parse(data.toString());

      if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: evt.delta }
        }));
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        openaiWs.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio"],
            instructions: "Respond naturally and briefly."
          }
        }));
      }
    });

    openaiWs.on("close", () => console.log("❎ OpenAI disconnected"));
  }

  twilioWs.on("message", (msg) => {
    const evt = JSON.parse(msg.toString());

    if (evt.event === "start") {
      streamSid = evt.start.streamSid;
      connectOpenAI();
    }

    if (evt.event === "media") {
      if (openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: evt.media.payload
        }));
      }
    }

    if (evt.event === "stop") {
      openaiWs?.close();
    }
  });
});
