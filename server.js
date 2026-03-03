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
You are HVAC Services Pro receptionist.
Speak only English.
Sound natural and human.
Start with:
"Thanks for calling HVAC Services Pro. How can I help you today?"
Ask one question at a time.
Never mention AI.
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
