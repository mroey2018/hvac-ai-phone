import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post("/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
    <Response>
      <Say>HVAC Services Pro test line is working.</Say>
      <Hangup/>
    </Response>
  `);
});

app.get("/", (_, res) => res.send("Server running"));

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Server started");
});

const wss = new WebSocketServer({ server, path: "/media" });
wss.on("connection", (ws) => {
  console.log("Media stream connected");
});
